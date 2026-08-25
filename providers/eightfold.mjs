// @ts-check
/** @typedef {import('./_types.js').Provider} Provider */

// Eightfold (PCSX) provider — powers Qualcomm, Microsoft, and a large share of
// enterprise career sites that show no ATS branding.
//
// Endpoint discovery notes (2026-08-16), kept here because the working path is
// not the documented one:
//   - The legacy `/api/apply/v2/jobs` path returns
//     403 {"message":"Not authorized for PCSX"} even with full browser headers.
//   - The live path used by the site itself is `/api/pcsx/search`, which works
//     from a plain fetch PROVIDED a `Referer` of `https://<host>/careers` is
//     sent. Without it the host 403s.
//   - The `location` query parameter is accepted but NOT honored (Microsoft
//     returns Redmond/Atlanta/NY regardless), so this provider never sends it
//     and lets scan.mjs's location_filter do the filtering.
//   - `start` pages in steps of 10. An empty `positions` array ends the board.
//   - Boards rate-limit aggressively: Microsoft 429s after ~9 rapid queries.
//     Retries below use escalating backoff rather than dropping the tenant,
//     because a silent 429 truncation looks identical to an empty board — so
//     exhausting the retries throws instead of returning a short board.
//
// Config shape in portals.yml — either form auto-detects:
//   careers_url: https://careers.qualcomm.com/careers
//   api: https://careers.qualcomm.com/api/pcsx/search?domain=qualcomm.com
// `domain` is required by the API; when only careers_url is given it is
// derived from the registrable part of the careers hostname.
//
// Optional per-entry config:
//   max_pages: 20        pagination cap per query term (default 60, hard cap 200)
//   queries: [ui, ux]    replaces DEFAULT_QUERIES for this tenant

const PAGE_SIZE = 10;
const DEFAULT_MAX_PAGES = 60; // 600 postings per query term — well past any real board
const MAX_PAGES_CAP = 200;
const PAGE_DELAY_MS = 500;
const MAX_RETRIES = 4;

// Query terms are needed because PCSX has no "list everything" mode. These are
// deliberately generic so the union approaches full board coverage; scan.mjs's
// title_filter does the real narrowing afterwards.
const DEFAULT_QUERIES = ['engineer', 'designer', 'developer', 'user experience', 'full stack', 'manager', 'analyst'];

/** @param {number} ms @param {any} ctx */
function sleep(ms, ctx) {
  if (typeof ctx?.sleep === 'function') return ctx.sleep(ms);
  return new Promise(resolve => setTimeout(resolve, ms));
}

/** @param {any} entry */
function resolveMaxPages(entry) {
  const v = entry?.max_pages;
  if (Number.isInteger(v) && v > 0) return Math.min(v, MAX_PAGES_CAP);
  return DEFAULT_MAX_PAGES;
}

/** @param {string} url */
function parseHost(url) {
  try {
    const u = new URL(url);
    return u.protocol === 'https:' ? u : null;
  } catch {
    return null;
  }
}

/** @param {import('./_types.js').PortalEntry} entry */
function resolveConfig(entry) {
  // Explicit api: wins, mirroring lever/greenhouse precedence.
  const fromApi = parseHost(entry.api || '');
  if (fromApi && fromApi.pathname.includes('/api/pcsx/')) {
    const domain = fromApi.searchParams.get('domain');
    if (domain) return { origin: fromApi.origin, domain };
  }
  const c = parseHost(entry.careers_url || '');
  if (!c) return null;
  // Only auto-detect when the entry opted in via provider: eightfold — the
  // hostname alone is not a reliable signal (Eightfold is white-labelled onto
  // customer domains), so guessing here would shadow other providers.
  if (entry.provider !== 'eightfold') return null;
  const parts = c.hostname.split('.').filter(Boolean);
  const domain = parts.slice(-2).join('.');
  return domain ? { origin: c.origin, domain } : null;
}

/** @type {Provider} */
export default {
  id: 'eightfold',

  detect(entry) {
    const cfg = resolveConfig(entry);
    return cfg ? { url: `${cfg.origin}/api/pcsx/search?domain=${cfg.domain}` } : null;
  },

  async fetch(entry, ctx) {
    const cfg = resolveConfig(entry);
    if (!cfg) throw new Error(`eightfold: cannot derive PCSX config for ${entry.name}`);

    // verify-portals' liveness probe passes ctx.maxPages: 1 — it only needs to
    // tell a live board from a broken one. Honor it for query terms too: one
    // page of one term is the whole answer that probe is asking for, and
    // walking seven terms against a 429-happy host to answer it would be rude.
    const ctxCap = Number.isInteger(ctx?.maxPages) && ctx.maxPages > 0 ? ctx.maxPages : Infinity;
    const maxPages = Math.min(resolveMaxPages(entry), ctxCap);
    const configured = Array.isArray(entry.queries) && entry.queries.length ? entry.queries : DEFAULT_QUERIES;
    const queries = Number.isFinite(ctxCap) ? configured.slice(0, 1) : configured;

    const headers = { Accept: 'application/json', Referer: `${cfg.origin}/careers` };
    /** @type {Map<string, object>} */
    const seen = new Map();

    for (const q of queries) {
      for (let page = 0; page < maxPages; page++) {
        const url = `${cfg.origin}/api/pcsx/search?domain=${encodeURIComponent(cfg.domain)}&query=${encodeURIComponent(q)}&start=${page * PAGE_SIZE}&sort_by=relevance`;
        let json = null;
        let rateLimited = null;
        for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
          try {
            json = await ctx.fetchJson(url, { headers, redirect: 'error' });
            rateLimited = null;
            break;
          } catch (err) {
            // Escalating backoff on rate limiting; anything else ends this term.
            if (/\b429\b|rate.?limit/i.test(String(err?.message))) {
              rateLimited = err;
              await sleep(4000 * (attempt + 1), ctx);
              continue;
            }
            throw err;
          }
        }
        // Retries exhausted: throw rather than break. Breaking here would end
        // the term on a short board and report a truncated scan as a complete
        // one — the exact failure the backoff exists to prevent.
        if (rateLimited) {
          throw new Error(`eightfold: ${entry.name} rate-limited on "${q}" page ${page + 1} after ${MAX_RETRIES} attempts — ${rateLimited.message}`);
        }
        const positions = json?.data?.positions;
        if (!Array.isArray(positions) || positions.length === 0) break;
        for (const p of positions) {
          const id = String(p.id ?? '');
          if (!id || seen.has(id)) continue;
          const locs = Array.isArray(p.standardizedLocations) && p.standardizedLocations.length
            ? p.standardizedLocations
            : Array.isArray(p.locations) ? p.locations : [];
          seen.set(id, {
            title: p.name || '',
            url: p.positionUrl ? new URL(p.positionUrl, cfg.origin).href : `${cfg.origin}/careers/job/${id}`,
            company: entry.name,
            location: locs.filter(Boolean).join('; '),
            // PCSX search ships no description — scan.mjs content_filter will
            // correctly treat these as description-less rather than empty.
            description: '',
            // postedTs is epoch SECONDS; postedAt is expected in ms.
            postedAt: Number.isFinite(Number(p.postedTs)) ? Number(p.postedTs) * 1000 : undefined,
          });
        }
        // A short page is the last page — paging on wastes a request against a
        // host that 429s after nine of them.
        if (positions.length < PAGE_SIZE) break;
        await sleep(PAGE_DELAY_MS, ctx);
      }
    }
    return [...seen.values()];
  },
};
