// @ts-check
/** @typedef {import('./_types.js').Provider} Provider */

// Built In (builtin.com) — the tech-hub job network (Built In NYC / Chicago /
// LA / Austin / Boston / Colorado / Seattle / SF, plus the national site). Not
// an ATS: it aggregates postings from employers that pay to list, so it surfaces
// roles that never appear on the company's own Greenhouse/Lever board, and it
// carries the mid-market and regional employers the big ATS sweeps miss.
//
// TRANSPORT: the listing pages are SERVER-rendered — no browser needed.
//
//   GET https://builtin.com/jobs/{category}[?page=N]     # 1-based, 25/page
//
// ── Two parse layers, deliberately ────────────────────────────────────────────
//
// (a) PRIMARY — schema.org JSON-LD. Every listing page embeds an ItemList of the
//     postings on it, each element carrying name/url/description. This is the
//     resilient anchor: it is a published contract Built In maintains for search
//     engines, so it survives the CSS/utility-class churn that breaks ordinary
//     scrapers. parseJsonLd() reads it and is the source of truth for the fields
//     it covers.
//
//     One trap: the script tag is emitted as `type="application/ld&#x2B;json"` —
//     the "+" is HTML-escaped. A search for the literal `application/ld+json`
//     finds NOTHING on this site and reads as "no structured data here", which is
//     exactly the wrong conclusion. The regex below accepts both spellings.
//
// (b) ENRICHMENT — the job cards. JSON-LD carries no company or location, both of
//     which the scanner filters on, so those come from the card markup, keyed by
//     the numeric job id that appears in every posting URL. The cards are anchored
//     on `data-id="..."` attributes (`job-card`, `company-title`, `job-card-title`)
//     rather than presentational classes, since those attributes exist for Built
//     In's own JS and change far less often than the Bootstrap-ish utility classes
//     around them.
//
// Enrichment is strictly additive: a card that fails to parse costs that posting
// its company/location, not its existence. A markup change therefore degrades the
// metadata while the JSON-LD keeps the postings flowing — the failure mode is a
// thinner row, never a silently empty scan.
//
// PAGINATION: `?page=N` past the end does NOT return an empty page or a 404 —
// Built In keeps serving results. So the walk stops when a page yields no job id
// it has not already seen (the radancy idiom), bounded by max_pages/max_jobs.
//
// postedAt is omitted: the cards express age as prose ("Reposted 36 Minutes Ago",
// "Yesterday"), which is a relative string with no timezone or reference instant.
// Deriving an epoch from it would manufacture precision the source does not have,
// and postedAt feeds the --posted-after/--posted-before date filters.

const MAX_PAGES = 40; // 25/page ⇒ up to 1000 postings per entry
const DEFAULT_MAX_JOBS = 1000;
const PAGE_DELAY_MS = 250; // polite pacing — Built In is a single small operator

const ALLOWED_HOST = 'builtin.com';

const NAMED_ENTITIES = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ' };

/** @param {string} s */
function decodeEntities(s) {
  return s.replace(/&(#x?[0-9a-fA-F]+|[a-zA-Z]+);/g, (m, body) => {
    if (body[0] === '#') {
      const code = body[1] === 'x' || body[1] === 'X' ? parseInt(body.slice(2), 16) : parseInt(body.slice(1), 10);
      // Mirrors radancy.mjs: a malformed or adversarial entity degrades to the
      // original text rather than throwing RangeError out of the whole parse.
      const valid = Number.isFinite(code) && code >= 0 && code <= 0x10ffff && !(code >= 0xd800 && code <= 0xdfff);
      return valid ? String.fromCodePoint(code) : m;
    }
    return NAMED_ENTITIES[body.toLowerCase()] ?? m;
  });
}

/** @param {string} s */
function clean(s) {
  return decodeEntities(String(s).replace(/<[^>]*>/g, ' ')).replace(/\s+/g, ' ').trim();
}

/**
 * The numeric id trailing every Built In posting URL (/job/{slug}/{id}).
 * It is the only stable key shared by the JSON-LD entry and the rendered card.
 * @param {string} url
 * @returns {string|null}
 */
export function jobIdFromUrl(url) {
  const m = String(url).match(/\/job\/[^/?#]+\/(\d+)(?:[/?#]|$)/);
  return m ? m[1] : null;
}

/**
 * Reject anything that is not a builtin.com URL before it is fetched.
 * Mirrors assertGreenhouseUrl in greenhouse.mjs.
 * @param {string} raw
 * @returns {URL}
 */
export function assertBuiltInUrl(raw) {
  let u;
  try {
    u = new URL(raw);
  } catch {
    throw new Error(`builtin: not a URL: ${raw}`);
  }
  if (u.protocol !== 'https:') throw new Error(`builtin: refusing non-https URL: ${raw}`);
  const host = u.hostname.toLowerCase();
  if (host !== ALLOWED_HOST && !host.endsWith(`.${ALLOWED_HOST}`)) {
    throw new Error(`builtin: refusing non-builtin.com host: ${u.hostname}`);
  }
  return u;
}

/**
 * Read the postings out of the page's schema.org ItemList.
 *
 * Returns [] rather than throwing on anything unexpected — a JSON-LD change must
 * not take the scan down, and `fetch` below treats an empty page as the end of
 * the walk.
 *
 * @param {string} html
 * @returns {{id: string, title: string, url: string, description: string}[]}
 */
export function parseJsonLd(html) {
  if (typeof html !== 'string') return [];
  const out = [];
  const seen = new Set();
  // `ld&#x2B;json` is the spelling Built In actually emits; `ld+json` is accepted
  // so the parser keeps working if they ever stop escaping it.
  const blocks = html.matchAll(/<script[^>]*type="application\/ld(?:\+|&#x2B;|&#43;)json"[^>]*>([\s\S]*?)<\/script>/gi);
  for (const block of blocks) {
    let json;
    try {
      json = JSON.parse(block[1]);
    } catch {
      continue; // one malformed block must not discard the others
    }
    const graph = Array.isArray(json?.['@graph']) ? json['@graph'] : [json];
    for (const node of graph) {
      if (node?.['@type'] !== 'ItemList' || !Array.isArray(node.itemListElement)) continue;
      for (const item of node.itemListElement) {
        const url = typeof item?.url === 'string' ? item.url : '';
        const title = clean(item?.name ?? '');
        if (!url || !title) continue;
        const id = jobIdFromUrl(url);
        if (!id || seen.has(id)) continue;
        seen.add(id);
        out.push({ id, title, url, description: clean(item?.description ?? '') });
      }
    }
  }
  return out;
}

/**
 * Pull company and location off the rendered cards, keyed by job id.
 *
 * Enrichment only: every field is optional and a miss yields ''.
 *
 * The company name is anchored on `data-id="company-title"` — an attribute Built
 * In's own JS uses, so it outlives the utility classes around it.
 *
 * The metadata rows have no such attribute: each is an icon followed by its
 * value, and the ICON CLASS is the only label present. `fa-location-dot` marks
 * the geography, `fa-house-building` the work arrangement ("Hybrid", "Remote",
 * "In-Office or Remote"). Sibling rows use `fa-sack-dollar` (salary) and
 * `fa-trophy` (seniority), so the class is what keeps them apart.
 *
 * Single-site roles print the place in the span. Multi-site roles print
 * "4 Locations" and hide the real list in a Bootstrap tooltip payload
 * (`data-bs-title="&lt;div&gt;Plano, TX, USA&lt;/div&gt;…"`, doubly escaped).
 * The tooltip wins when present — "4 Locations" tells the scanner's location
 * filter nothing. Arrangement is prefixed when both exist ("Hybrid · Plano, TX,
 * USA"): the filter needs the geography, the reader wants the arrangement.
 *
 * Only the FIRST match of each icon per card is taken, since Built In interleaves
 * sponsored company cards carrying their own location-ish rows.
 *
 * @param {string} html
 * @returns {Map<string, {company: string, location: string}>}
 */
export function parseCards(html) {
  const byId = new Map();
  if (typeof html !== 'string') return byId;
  // Cards open with id="job-card-{id}"; slice(1) drops the page head.
  const blocks = html.split(/<div[^>]*\bid="job-card-(?=\d)/i).slice(1);
  for (const block of blocks) {
    const idM = block.match(/^(\d+)"/);
    if (!idM) continue;
    const id = idM[1];
    if (byId.has(id)) continue;

    const companyM = block.match(/data-id="company-title"[\s\S]{0,400}?<span[^>]*>([\s\S]*?)<\/span>/i);
    // `<i class="… fa-location-dot …">` … then the value in the next span. The
    // {0,400} leash keeps a missing row from matching the row after it.
    const iconValue = (icon) => block.match(new RegExp(`class="[^"]*\\b${icon}\\b[^"]*"[\\s\\S]{0,400}?<span[^>]*>([\\s\\S]*?)<\\/span>`, 'i'));
    const arrangementM = iconValue('fa-house-building');
    const locM = iconValue('fa-location-dot');
    const tooltipM = locM && block.slice(locM.index, locM.index + locM[0].length).match(/data-bs-title="([^"]*)"/i);

    // The tooltip holds one <div> per site; decode first, then split on the tags.
    let geography = '';
    if (tooltipM) {
      geography = decodeEntities(tooltipM[1])
        .split(/<\/div>/i)
        .map((part) => clean(part))
        .filter(Boolean)
        .join(' · ');
    } else if (locM) {
      geography = clean(locM[1]);
    }

    const arrangement = arrangementM ? clean(arrangementM[1]) : '';
    const location = [arrangement, geography].filter(Boolean).join(' · ');
    byId.set(id, { company: companyM ? clean(companyM[1]) : '', location });
  }
  return byId;
}

/**
 * Resolve the listing URL from a portals.yml entry, dropping any inherited
 * `page` param so pagination below starts where it means to.
 * @param {{api?: string, careers_url?: string, name?: string}} entry
 */
export function resolveListUrl(entry) {
  const raw = entry?.api || entry?.careers_url || '';
  const u = assertBuiltInUrl(raw);
  u.searchParams.delete('page');
  return u;
}

/** @param {number} page */
function pageUrl(base, page) {
  const u = new URL(base.href);
  if (page > 1) u.searchParams.set('page', String(page));
  return u.href;
}

function resolveCap(value, fallback, hardMax = Infinity) {
  return Number.isInteger(value) && value > 0 ? Math.min(value, hardMax) : fallback;
}

/** @type {Provider} */
export default {
  id: 'builtin',

  detect(entry) {
    const raw = entry?.careers_url || entry?.api || '';
    if (typeof raw !== 'string' || !raw) return null;
    let u;
    try {
      u = new URL(raw);
    } catch {
      return null;
    }
    const host = u.hostname.toLowerCase().replace(/^www\./, '');
    if (host !== ALLOWED_HOST) return null;
    // Only listing pages — a /company/ or /job/ URL is a single page, not a feed.
    if (!/^\/jobs(\/|$)/.test(u.pathname)) return null;
    return { url: raw };
  },

  async fetch(entry, ctx) {
    const base = resolveListUrl(entry);
    const maxPages = resolveCap(entry?.max_pages, MAX_PAGES, MAX_PAGES);
    const maxJobs = resolveCap(entry?.max_jobs, DEFAULT_MAX_JOBS);
    const wait = (ms) => (ctx.sleep ? ctx.sleep(ms) : new Promise((r) => setTimeout(r, ms)));
    const pageCap = ctx.maxPages && ctx.maxPages > 0 ? Math.min(ctx.maxPages, maxPages) : maxPages;

    const jobs = [];
    const seen = new Set();
    let succeededOnce = false;

    for (let page = 1; page <= pageCap && jobs.length < maxJobs; page++) {
      if (page > 1) await wait(PAGE_DELAY_MS);

      let html;
      try {
        html = await ctx.fetchText(pageUrl(base, page), {
          headers: { accept: 'text/html' },
          redirect: 'error', // a server-side redirect off builtin.com is an SSRF vector
        });
      } catch (err) {
        // Page 1 failing before anything succeeded means the source is
        // unreachable, not empty — throw so scan/portal-health record a failure
        // rather than "live but empty". A later page failing keeps the partial.
        if (!succeededOnce) throw err;
        break;
      }
      succeededOnce = true;

      const rows = parseJsonLd(html);
      if (rows.length === 0) break; // no ItemList ⇒ past the end (or markup gone)

      const cards = parseCards(html);
      let fresh = 0;
      for (const row of rows) {
        if (seen.has(row.id)) continue;
        seen.add(row.id);
        fresh++;
        const card = cards.get(row.id);
        jobs.push({
          title: row.title,
          url: row.url,
          company: card?.company || '',
          location: card?.location || '',
          // The ItemList carries a real summary, so this is free — no per-job request.
          ...(row.description ? { description: row.description } : {}),
        });
      }
      // Past the last page Built In keeps serving results instead of an empty
      // page, so a page with nothing new is the only reliable end-of-walk signal.
      if (fresh === 0) break;
    }

    return jobs.slice(0, maxJobs);
  },
};
