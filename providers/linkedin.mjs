// @ts-check
/** @typedef {import('./_types.js').Provider} Provider */

// LinkedIn provider - the unauthenticated guest job-search endpoint.
//
//   /jobs-guest/jobs/api/seeMoreJobPostings/search?keywords=&location=&start=N
//
// It answers 200 with rendered result cards for anonymous callers: no cookie,
// no login, no browser. That matters beyond convenience - every other route
// into LinkedIn job data requires authenticating as the user, which is both a
// Terms of Service problem and a standing risk to the one account the warm
// intro path (linkedin-join.mjs) depends on. This endpoint is the only version
// of this channel worth having.
//
// PAIRS WITH THE LIVENESS RESOLVER. Each card carries a numeric posting id, and
// this provider emits the canonical `linkedin.com/jobs/view/{id}` form rather
// than the card's own href (which carries position/refId/trackingId params that
// change every scan and would break URL dedup). That canonical shape is exactly
// what liveness-api.mjs's `linkedin` resolver matches, so postings from here get
// authoritative liveness at the first rung - no Playwright.
//
// QUERIES ARE A UNION, NOT A CONJUNCTION. `keywords:` is a list of SEPARATE
// searches, one walk each, deduped by posting id. Joining them into a single
// query string would read as an AND against the posting text, and a list like
// ["Frontend Engineer", "Design Engineer"] would return almost nothing. Same
// reasoning as the eightfold per-tenant query list: the board has no
// list-everything mode, so coverage is the union of several searches.
//
// PAGINATION: `start` steps by 10. Past the end the endpoint returns an empty
// body rather than a 404, and at start=1000 it answers 400 - so the walk stops
// on an empty page, on a page with no unseen id, or at the caps below, and never
// relies on that 400 to terminate.
//
// TRUST TIER: LinkedIn republishes the employer's posting on its own domain, so
// _trust-validator.mjs raises company_domain_mismatch here exactly as it does
// for any aggregator. Unlike the other aggregators this one ships a real
// `datetime` on every card, so postings enter with an actual posted date and are
// subject to max_posting_age_days instead of bypassing it.
//
// Wire in with a `job_boards:` entry carrying `provider: linkedin`.

import { decodeEntities } from './_html-entities.mjs';
import { resolveProfileKeywords } from './_profile-keywords.mjs';
import { sleep } from './_http.mjs';

const SEARCH_HOST = 'www.linkedin.com';
const SEARCH_PATH = '/jobs-guest/jobs/api/seeMoreJobPostings/search';
const PAGE_SIZE = 10;
/** The endpoint hard-fails at start=1000; stop before it rather than on it. */
const HARD_START_LIMIT = 1000;
/** Pages per query. 10 means 100 postings per keyword before other caps apply. */
const MAX_PAGES = 10;
const DEFAULT_MAX_JOBS = 300;
/** Deliberately slower than a normal board walk - this endpoint is rate limited
 *  and shared with the liveness rung, which paces itself at 3.5s per posting. */
const PAGE_DELAY_MS = 2000;

/** @param {string} s */
function clean(s) {
  return decodeEntities(String(s).replace(/<[^>]*>/g, ' ')).replace(/\s+/g, ' ').trim();
}

/**
 * The searches to run for one entry: `q:` as a single search, else each
 * `keywords:` item as its own search, else the candidate's own target roles.
 * @param {any} entry
 * @returns {string[]}
 */
export function resolveQueries(entry) {
  if (typeof entry?.q === 'string' && entry.q.trim()) return [entry.q.trim()];
  const listed = Array.isArray(entry?.keywords)
    ? entry.keywords.filter((k) => typeof k === 'string' && k.trim()).map((k) => k.trim())
    : [];
  if (listed.length) return [...new Set(listed)];
  // A user who finished onboarding already recorded target roles; copying them
  // into every keyword-driven provider's config by hand is what this helper
  // exists to avoid.
  return [...new Set(resolveProfileKeywords())];
}

/**
 * Build one page URL. Exported so tests can pin the query shape without a fetch.
 * @param {string} query
 * @param {string} location
 * @param {number} start
 * @param {number} [postedWithinSec] f_TPR window; 0/absent = no recency filter
 */
export function buildSearchUrl(query, location, start, postedWithinSec = 0) {
  const u = new URL(`https://${SEARCH_HOST}${SEARCH_PATH}`);
  u.searchParams.set('keywords', query);
  if (location) u.searchParams.set('location', location);
  // Without f_TPR results are relevance-sorted and mostly weeks old, so the
  // page caps fill with postings already seen. f_TPR keys on (re)post time.
  // Probed 2026-09-24: f_WT/f_E/f_JT/sortBy are ignored by this guest endpoint.
  if (postedWithinSec > 0) u.searchParams.set('f_TPR', `r${postedWithinSec}`);
  u.searchParams.set('start', String(start));
  return u.href;
}

/**
 * The canonical posting URL for a numeric id.
 *
 * Deliberately not the card's own href: that carries position/refId/trackingId
 * params which differ on every scan, so the same posting would dedup as new each
 * run. This form is also what the liveness-api.mjs resolver matches.
 * @param {string} id
 */
export function jobUrl(id) {
  return `https://www.linkedin.com/jobs/view/${id}`;
}

// One card is an <li> wrapping a div whose data-entity-urn carries the posting
// id. Fields are read inside a single card's slice so a missing field on one
// card can never pick up the next card's value.
const CARD_RE = /<li[^>]*>([\s\S]*?)<\/li>/g;
const ID_RE = /data-entity-urn="urn:li:jobPosting:(\d+)"/;
const TITLE_RE = /class="[^"]*base-search-card__title[^"]*"[^>]*>([\s\S]*?)<\/h3>/;
const COMPANY_RE = /class="[^"]*base-search-card__subtitle[^"]*"[^>]*>([\s\S]*?)<\/h4>/;
const LOCATION_RE = /class="[^"]*job-search-card__location[^"]*"[^>]*>([\s\S]*?)<\/span>/;
const DATE_RE = /class="[^"]*job-search-card__listdate[^"]*"[^>]*datetime="(\d{4}-\d{2}-\d{2})"/;

/**
 * Parse one page of guest search results. Exported for unit tests.
 *
 * @param {string} html
 * @returns {Array<{id: string, title: string, url: string, company: string, location: string, postedAt?: number}>}
 */
export function parseSearchCards(html) {
  if (typeof html !== 'string') return [];
  const out = [];
  const seen = new Set();
  for (const card of html.matchAll(CARD_RE)) {
    const block = card[1];
    const id = block.match(ID_RE)?.[1];
    if (!id || seen.has(id)) continue;
    const title = clean(block.match(TITLE_RE)?.[1] ?? '');
    if (!title) continue; // a card with no title is markup we no longer understand
    seen.add(id);
    const iso = block.match(DATE_RE)?.[1];
    // Midday UTC, not midnight: the endpoint publishes a bare date with no
    // timezone, and anchoring at 00:00Z reads as "yesterday" for every viewer
    // west of Greenwich. Noon keeps the calendar day intact on either side.
    const postedAt = iso ? Date.parse(`${iso}T12:00:00Z`) : NaN;
    out.push({
      id,
      title,
      url: jobUrl(id),
      company: clean(block.match(COMPANY_RE)?.[1] ?? ''),
      location: clean(block.match(LOCATION_RE)?.[1] ?? ''),
      ...(Number.isFinite(postedAt) ? { postedAt } : {}),
    });
  }
  return out;
}

function resolveCap(value, fallback, hardMax = Infinity) {
  return Number.isInteger(value) && value > 0 ? Math.min(value, hardMax) : fallback;
}

/** @type {Provider} */
export default {
  id: 'linkedin',

  // Explicit opt-in only. The listing URL is built from keywords rather than
  // pasted, so there is no careers_url shape to detect - and claiming
  // linkedin.com URLs generally would swallow company pages and profile links.
  detect(entry) {
    return entry?.provider === 'linkedin' ? { url: `https://${SEARCH_HOST}${SEARCH_PATH}` } : null;
  },

  async fetch(entry, ctx) {
    const queries = resolveQueries(entry);
    if (queries.length === 0) {
      throw new Error(
        'linkedin: no search terms - set `keywords:` or `q:` on the entry, or target_roles in config/profile.yml',
      );
    }
    const location = typeof entry?.location === 'string' ? entry.location.trim() : '';
    // Default one day: scans run twice daily, so every window overlaps the last.
    const postedWithin = entry?.posted_within_sec === 0 ? 0 : resolveCap(entry?.posted_within_sec, 86400, 60 * 86400);
    const maxJobs = resolveCap(entry?.max_jobs, DEFAULT_MAX_JOBS);
    const maxPages = resolveCap(entry?.max_pages, MAX_PAGES, MAX_PAGES);
    const pageCap = ctx.maxPages && ctx.maxPages > 0 ? Math.min(ctx.maxPages, maxPages) : maxPages;
    const wait = (ms) => sleep(ms, ctx);

    const jobs = [];
    const seen = new Set();
    let succeededOnce = false;
    let first = true;

    for (const query of queries) {
      for (let page = 0; page < pageCap && jobs.length < maxJobs; page++) {
        const start = page * PAGE_SIZE;
        if (start >= HARD_START_LIMIT) break;
        if (!first) await wait(PAGE_DELAY_MS);
        first = false;

        let html;
        try {
          html = await ctx.fetchText(buildSearchUrl(query, location, start, postedWithin), {
            headers: { accept: 'text/html' },
            // A server-side redirect off www.linkedin.com is an SSRF vector, and
            // this endpoint has no legitimate reason to redirect.
            redirect: 'error',
          });
        } catch (err) {
          // Nothing has succeeded yet means the source is unreachable, not
          // empty. Throw so scan.mjs and portal-health record a failure instead
          // of "live but no jobs" - a throttled board must never look like a
          // quiet one. A later page failing keeps what the walk already has.
          if (!succeededOnce) throw err;
          break;
        }
        succeededOnce = true;

        const rows = parseSearchCards(html);
        if (rows.length === 0) break; // past the end of this query's results

        let fresh = 0;
        for (const row of rows) {
          if (seen.has(row.id)) continue;
          seen.add(row.id);
          fresh++;
          const { id: _id, ...job } = row;
          jobs.push(job);
          if (jobs.length >= maxJobs) break;
        }
        // Every id already seen means this query has stopped producing - either
        // the walk wrapped, or an earlier query already covered this ground.
        if (fresh === 0) break;
      }
    }

    return jobs.slice(0, maxJobs);
  },
};
