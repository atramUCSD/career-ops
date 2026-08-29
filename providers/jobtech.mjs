// @ts-check
/** @typedef {import('./_types.js').Provider} Provider */

import { resolveProfileKeywords } from './_profile-keywords.mjs';
import { intInRange } from './_config-utils.mjs';

// JobTech (Arbetsformedlingen, Sweden's public employment service) provider —
// hits the open JobSearch REST API at jobsearch.api.jobtechdev.se. Open data,
// zero-auth (no key, no registration), so it lives in-process alongside the
// other JSON-API providers — same class as arbeitsagentur (DE), vdab (BE),
// jobbankca (CA), mycareersfuture (SG). One or more keywords are queried;
// scan.mjs applies title_filter + location_filter + dedup afterwards, so this
// provider over-fetches (recall-first).
//
// Configure via a `job_boards` (or `tracked_companies`) entry with
// `provider: jobtech` and a `jobtech:` block:
//
//   - name: JobTech — Python Sverige
//     provider: jobtech
//     jobtech:
//       keywords: ["Python", "Machine Learning"]  # optional — falls back to
//                                                 # config/profile.yml target_roles
//       days: 30    # recency window in days, maps to published-after (default 30)
//       size: 100   # results per page (1–100, default 100)
//     enabled: true
//
// Live-probed 2026-08-28 (no credentials needed anywhere):
//   GET /search?q=python&limit=1                  → 200 { total: {value}, hits: [...] }
//     hit fields used here: id, headline, webpage_url, employer{name,workplace},
//     workplace_address{municipality,country}, publication_date, description{text},
//     removed, removed_date. `description.text` ships in the LIST payload for
//     free, so it is passed through (no per-job requests — the scanner stays
//     zero-token).
//   limit  > 100  → 400 (gateway: "101 is not less or equal to 100")
//   offset > 2000 → 400 (gateway: "2001 is not less or equal to 2000")
//   published-after accepts minutes-as-int AND an ISO datetime; minutes used here.
//   GET /ad/{id}                                  → 200 full ad JSON (live ad)
//   GET /ad/{id-of-removed-ad}                    → 200 TOMBSTONE: removed:true,
//     removed_date set, headline:null (verified minutes after removal via JobStream)
//   GET /ad/99999999 (unknown id)                 → 404 {"message":"Ad not found. …","status":404}
//   GET /adzzz/… (dead route)                     → 404 {"tracking_id":…,"cause":{"code":"404",
//     "message":"resource_not_found"}} — a DIFFERENT shape, so a bare 404 must
//     not be read as posting-gone (see the liveness rung spec in the PR notes).
//
// Known limitation: geo filtering uses taxonomy concept-ids users won't know,
// so there is no location config here — every keyword search is nationwide and
// precision on location is left to scan.mjs's location_filter, consistent with
// the recall-first design (same position as vdab.mjs).

const API_URL = 'https://jobsearch.api.jobtechdev.se/search';
const DETAIL_BASE = 'https://arbetsformedlingen.se/platsbanken/annonser/';
// The gateway rejects offset > 2000 with a 400 (probed 2026-08-28). At the max
// page size (100) page 20 sends offset 2000 — the last legal page — so this cap
// both bounds a runaway loop and keeps every request inside the gateway limit.
const MAX_PAGES_PER_KEYWORD = 20;

/**
 * Reads and sanitizes the entry's `jobtech:` config block.
 * @param {{ jobtech?: any }} entry
 * @returns {{ keywords: string[], days: number, size: number }}
 */
export function parseJobtechConfig(entry) {
  const cfg = (entry && entry.jobtech) || {};
  const keywords = [...new Set(
    (Array.isArray(cfg.keywords) ? cfg.keywords : [])
      .filter(k => typeof k === 'string' && k.trim())
      .map(k => k.trim())
  )];
  return {
    keywords,
    days: intInRange(cfg.days, 30, 1, 1000), // recency window (published-after)
    size: intInRange(cfg.size, 100, 1, 100), // results per page (API max 100)
  };
}

/**
 * Assembles a human-readable location from a hit's `workplace_address`. Most
 * postings are in Sweden; only a non-SE country is appended so the downstream
 * location_filter can act on it (same shape as arbeitsagentur's buildLocation).
 * @param {any} address
 * @returns {string}
 */
export function buildLocation(address) {
  if (!address || typeof address !== 'object') return '';
  const loc = String(address.municipality || address.city || '').trim();
  const country = address.country;
  if (country && !/sverige|sweden/i.test(country)) return loc ? `${loc}, ${country}` : String(country);
  return loc;
}

/**
 * Normalizes one raw JobSearch hit into a Job plus its `id` (kept for dedup,
 * stripped before the provider returns). Returns null when the hit lacks a
 * usable id or headline, or is a removal tombstone (`removed: true` — the API
 * keeps answering 200 for removed ads, with the content fields nulled).
 * @param {any} hit
 * @returns {({title: string, url: string, company: string, location: string, postedAt?: number, description?: string, id: string}) | null}
 */
export function normalizeJob(hit) {
  const id = hit && hit.id;
  const title = String((hit && hit.headline) || '').trim();
  if (!id || !title || hit.removed === true) return null;
  const employer = (hit && hit.employer) || {};
  const result = {
    title,
    // Built from the id rather than trusting webpage_url, so the outgoing URL
    // is always the canonical Platsbanken shape the liveness rung matches on.
    url: DETAIL_BASE + encodeURIComponent(String(id)),
    // name (legal employer) first: `workplace` is free text that employers
    // often fill with a location ("Malmö, Sweden" observed live 2026-08-28).
    company: String(employer.name || employer.workplace || '').trim(),
    location: buildLocation(hit && hit.workplace_address),
    id: String(id),
  };
  const posted = hit && hit.publication_date && Date.parse(hit.publication_date);
  if (Number.isFinite(posted)) result.postedAt = posted;
  const description = String((hit && hit.description && hit.description.text) || '').trim();
  if (description) result.description = description;
  return result;
}

/** @type {Provider} */
export default {
  id: 'jobtech',

  /**
   * Fetches and normalizes postings from the JobTech JobSearch API.
   * @param {{ name?: string, jobtech?: any }} entry
   * @param {{ fetchJson: (url: string, opts?: object) => Promise<any>, maxPages?: number }} ctx
   * @returns {Promise<Array<{title: string, url: string, company: string, location: string, postedAt?: number, description?: string}>>}
   */
  async fetch(entry, ctx) {
    const { days, size, keywords: ownKeywords } = parseJobtechConfig(entry);
    let keywords = ownKeywords;
    // Fall back to config/profile.yml's target_roles when this entry has no
    // jobtech.keywords[] of its own (same fallback as vdab/jobbankca).
    if (!keywords.length) keywords = resolveProfileKeywords();
    if (!keywords.length) {
      throw new Error(`jobtech: entry "${entry.name || '(unnamed)'}" has no jobtech.keywords[] and no config/profile.yml target_roles to fall back to`);
    }

    // ctx.maxPages is set only by verify-portals.mjs's bounded health probe
    // (never during a real scan): cap pagination per keyword and let the first
    // error propagate as-is so the probe's own sentinel handling works — same
    // reasoning as vdab.mjs.
    const probing = Number.isInteger(ctx?.maxPages) && ctx.maxPages > 0;
    const pageLimit = probing ? ctx.maxPages : MAX_PAGES_PER_KEYWORD;

    /** @param {string} q */
    const fetchKeyword = async (q) => {
      const out = [];
      for (let page = 0; page < pageLimit; page++) {
        const params = new URLSearchParams({
          q,
          limit: String(size),
          offset: String(page * size),
          // published-after takes minutes-as-int (probed live; also accepts ISO).
          'published-after': String(days * 1440),
        });
        // redirect:'error' prevents SSRF via server-side redirects.
        const json = await ctx.fetchJson(`${API_URL}?${params.toString()}`, {
          headers: { accept: 'application/json' },
          redirect: 'error',
          // Observed live 2026-08-28: a 5-hit page took 12.3s to answer (the
          // list payload inlines full descriptions), so the default 10s budget
          // times out on a healthy board.
          timeoutMs: 25_000,
        });
        const hits = Array.isArray(json && json.hits) ? json.hits : [];
        out.push(...hits);
        if (hits.length < size) break; // short page → done
      }
      return out;
    };

    const byId = new Map();
    const errors = [];
    let succeeded = 0; // keywords whose request completed (i.e. the source answered)
    for (const kw of keywords) {
      let raw;
      try {
        raw = await fetchKeyword(kw);
        succeeded++;
      } catch (err) {
        if (probing) throw err;
        // Recall-first: tolerate a single failed keyword and keep going.
        errors.push(`"${kw}": ${(err && err.message) || err}`);
        continue;
      }
      for (const r of raw) {
        const job = normalizeJob(r);
        if (job && !byId.has(job.id)) byId.set(job.id, job);
      }
    }

    // Total outage = every keyword request failed. A keyword that answered with
    // zero results is not an outage, so key off the success count.
    if (succeeded === 0 && errors.length) {
      throw new Error(`jobtech: all ${keywords.length} keyword request(s) failed — ${errors[0]}`);
    }

    return [...byId.values()].map(({ id, ...job }) => job);
  },
};
