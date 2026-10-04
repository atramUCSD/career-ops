// @ts-check
/** @typedef {import('./_types.js').Provider} Provider */

// ClearanceJobs (cleared US defense / IC job board) provider — a job_boards:
// aggregator entry. Reads the site's own search API, the same JSON the
// www.clearancejobs.com/jobs SPA calls, so no HTML scraping. Recall-first:
// scan.mjs applies title_filter + location_filter + dedup afterwards.
//
// Live-probed 2026-10-04 (no auth, no cookie):
//   - POST https://api.clearancejobs.com/api/v1/jobs/search, JSON body →
//     200 { data: [...], meta: { pagination: { total, count, per_page,
//     current_page, next_page, total_pages }, ... } }.
//   - Body fields that filter: `keywords` (string), `page` (int),
//     `received` (string days — the UI offers "1", "3", "7", "31"),
//     `loc` (array of state ids, e.g. [5] = California; a scalar → 422
//     "The loc must be an array."), `city` (array of "City, ST" strings),
//     `remote` ("1").
//   - Page size is fixed at 20 server-side; a size param is ignored.
//   - Item: id, created_at (ISO with offset), job_name, job_url
//     (https://www.clearancejobs.com/jobs/{id}/{slug}), company_name,
//     locations[{location, type}], clearance, polygraph, preview_text.
//   - robots.txt disallows `/jobs?` (the SPA's query-string search pages) and
//     `/*/apply`; the API host and path are not covered.
//
// Configure via a portals.yml job_boards: entry:
//
//   - name: ClearanceJobs — California + remote
//     provider: clearancejobs
//     clearancejobs:
//       keywords: ["software engineer"]     # optional: falls back to
//                                           # config/profile.yml target_roles
//       queries:                            # optional, preferred; wins over keywords
//         - { keywords: "frontend", loc: [5] }
//         - { keywords: "software", city: ["San Diego, CA"] }
//         - { keywords: "UX", remote: true }
//       received: 7                         # days; snapped up to 1/3/7/31
//       max_pages: 10                       # per query, 20 jobs a page
//     enabled: true

import { resolveProfileKeywords } from './_profile-keywords.mjs';
import { intInRange } from './_config-utils.mjs';

const API_URL = 'https://api.clearancejobs.com/api/v1/jobs/search';
const JOB_HOST = 'www.clearancejobs.com';
const PAGE_SIZE = 20;
const RECEIVED_STEPS = [1, 3, 7, 31];
const DEFAULT_MAX_PAGES = 10;
const MAX_PAGES_CAP = 100;

/**
 * Reads and sanitizes the entry's `clearancejobs:` config block.
 * @param {{ clearancejobs?: any }} entry
 */
export function parseClearanceJobsConfig(entry) {
  const cfg = (entry && entry.clearancejobs) || {};
  const str = v => (typeof v === 'string' && v.trim() ? v.trim() : undefined);
  const keywords = Array.isArray(cfg.keywords) ? cfg.keywords.map(str).filter(Boolean) : [];
  const queries = Array.isArray(cfg.queries)
    ? cfg.queries
      .filter(q => q && typeof q === 'object')
      .map(q => ({
        keywords: str(q.keywords),
        loc: Array.isArray(q.loc) ? q.loc.filter(n => Number.isInteger(n) && n > 0) : [],
        city: Array.isArray(q.city) ? q.city.map(str).filter(Boolean) : [],
        remote: q.remote === true,
      }))
      .filter(q => q.keywords || q.loc.length || q.city.length || q.remote)
    : [];
  const days = intInRange(cfg.received, 7, 1, 31);
  return {
    keywords,
    queries,
    received: RECEIVED_STEPS.find(s => s >= days) || 31,
    maxPages: Math.min(intInRange(cfg.max_pages, DEFAULT_MAX_PAGES, 1, MAX_PAGES_CAP), MAX_PAGES_CAP),
  };
}

/**
 * Normalizes one search item into a Job, or null when unusable. job_url is
 * accepted only as https on www.clearancejobs.com so a poisoned payload
 * cannot inject a foreign URL.
 * @param {any} item
 */
export function normalizeItem(item) {
  if (!item || typeof item !== 'object') return null;
  const title = String(item.job_name || '').trim();
  if (!title) return null;
  let url = '';
  try {
    const u = new URL(String(item.job_url || ''));
    if (u.protocol === 'https:' && u.hostname === JOB_HOST) url = u.href;
  } catch { /* not a URL */ }
  if (!url) return null;

  const location = (Array.isArray(item.locations) ? item.locations : [])
    .map(l => String((l && l.location) || '').trim())
    .filter(Boolean)
    .join('; ');
  /** @type {{title: string, url: string, company: string, location: string, description?: string, postedAt?: number}} */
  const job = { title, url, company: String(item.company_name || '').trim(), location };
  // Clearance level is the one field that matters most on this board and the
  // list payload carries it for free, so it leads the description.
  const clearance = [item.clearance, item.polygraph].filter(v => typeof v === 'string' && v.trim()).join(' · ');
  const desc = [clearance, typeof item.preview_text === 'string' ? item.preview_text.trim() : ''].filter(Boolean).join(' — ');
  if (desc) job.description = desc;
  const posted = item.created_at ? Date.parse(item.created_at) : NaN;
  if (!Number.isNaN(posted)) job.postedAt = posted;
  return job;
}

/** @type {Provider} */
export default {
  id: 'clearancejobs',

  async fetch(entry, ctx) {
    let { keywords, queries, received, maxPages } = parseClearanceJobsConfig(entry);
    if (!queries.length) {
      if (!keywords.length) keywords = resolveProfileKeywords();
      queries = keywords.map(k => ({ keywords: k, loc: [], city: [], remote: false }));
    }
    if (!queries.length) {
      throw new Error(`clearancejobs: entry "${entry.name || '(unnamed)'}" has no clearancejobs.queries[]/keywords[] and profile.yml provided no target_roles`);
    }

    const byUrl = new Map();
    const errors = [];
    let succeeded = 0;
    for (const q of queries) {
      const label = [q.keywords, q.loc.length && `loc ${q.loc.join(',')}`, q.city.join(','), q.remote && 'remote'].filter(Boolean).join(' / ');
      const body = { received: String(received) };
      if (q.keywords) body.keywords = q.keywords;
      if (q.loc.length) body.loc = q.loc;
      if (q.city.length) body.city = q.city;
      if (q.remote) body.remote = '1';

      let pageOk = false;
      for (let page = 1; page <= maxPages; page++) {
        let json;
        try {
          json = await ctx.fetchJson(API_URL, {
            method: 'POST',
            headers: { 'content-type': 'application/json', accept: 'application/json' },
            body: JSON.stringify({ ...body, page }),
            redirect: 'error',
            timeoutMs: 15_000,
          });
        } catch (err) {
          errors.push(`"${label}" p${page}: ${(err && err.message) || err}`);
          break;
        }
        const rows = json && Array.isArray(json.data) ? json.data : null;
        if (!rows) {
          errors.push(`"${label}" p${page}: unexpected response — expected data[], got keys: [${json && typeof json === 'object' ? Object.keys(json).join(', ') : typeof json}]`);
          break;
        }
        pageOk = true;
        for (const raw of rows) {
          const job = normalizeItem(raw);
          if (job && !byUrl.has(job.url)) byUrl.set(job.url, job);
        }
        // Short-page stop on the source's own row count, never the filtered one.
        const totalPages = Number(json.meta && json.meta.pagination && json.meta.pagination.total_pages);
        if (rows.length < PAGE_SIZE || (Number.isFinite(totalPages) && page >= totalPages)) break;
        if (ctx.sleep) await ctx.sleep(250);
      }
      if (pageOk) succeeded++;
    }

    if (succeeded === 0 && errors.length) {
      throw new Error(`clearancejobs: all ${queries.length} query request(s) failed — ${errors[0]}`);
    }
    return [...byUrl.values()];
  },
};
