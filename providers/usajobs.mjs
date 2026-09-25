// @ts-check
/** @typedef {import('./_types.js').Provider} Provider */

// USAJOBS (US federal government) provider — hits the official Position Search
// API at data.usajobs.gov (developer.usajobs.gov), so it lives in-process
// alongside the other JSON-API providers (arbeitsagentur/vdab shape). One or
// more keywords are queried; scan.mjs applies title_filter + location_filter +
// dedup afterwards, so this provider over-fetches (recall-first).
//
// AUTH — unlike the other government providers, this API requires a free
// registered key (developer.usajobs.gov signup): every request needs an
// `Authorization-Key` header plus a `User-Agent` set to the registered email.
// Read from the environment (scan.mjs loads .env at bootstrap, the same path
// GEMINI_API_KEY takes):
//
//   USAJOBS_API_KEY=<key from developer.usajobs.gov>
//   USAJOBS_EMAIL=<the email the key is registered to>
//
// Both absent or either missing → one warning line and an empty result, so a
// portals.yml entry for an unconfigured machine degrades instead of erroring
// every scan.
//
// Live-probed 2026-08-29 (no key on this machine, so unauthenticated surfaces
// only; the rest is from the official docs at
// developer.usajobs.gov/api-reference/get-api-search):
//   - GET data.usajobs.gov/api/search?Keyword=... WITHOUT Authorization-Key →
//     401, Content-Type application/problem+json, body
//     {"type":"...rfc9110#section-15.5.2","title":"Unauthorized","status":401,
//      "traceId":"..."}. (With curl's default User-Agent the Akamai edge
//     serves a 403 HTML "Access Denied" before the API is reached — any
//     real UA string gets through to the API's own 401.)
//   - GET data.usajobs.gov/api/codelist/occupationalseries → 200 JSON with no
//     key: the codelist endpoints are open.
//   - GET data.usajobs.gov/api/historicjoa?PositionSeries=2210 → 200 JSON with
//     no key: paginated { paging: { metadata, next }, data: [...] }. No
//     control-number filter exists (UsajobsControlNumber → 400 "Invalid
//     parameter").
//   - Public posting page www.usajobs.gov/job/{controlNumber}: unknown number
//     → bare 404; a 2020 posting → 200 with the server-rendered banner
//     "This job announcement has closed" (and "ClockDisplay": "JobClosed" in
//     embedded JSON). PositionURI's GetJob/ViewDetails/{cn} 301s to /job/{cn}.
//   - DOCUMENTED-ONLY (needs a key, not live-verified): the search response
//     shape below — SearchResult.SearchResultItems[].MatchedObjectDescriptor,
//     query params Keyword/LocationName/Radius/DatePosted/ResultsPerPage
//     (max 500, DatePosted 0–60 days), MatchedObjectId = control number.
//
// Configure via a portals.yml entry:
//
//   - name: USAJOBS — Software US
//     provider: usajobs
//     usajobs:
//       keywords: ["software engineer"]  # optional: falls back to
//                                        # config/profile.yml target_roles
//       queries:                         # optional, preferred: structured
//         - { series: "2210", keyword: "web" }   # JobCategoryCode (OPM series,
//         - { series: "0343;1084", keyword: "user experience" } # ";" = any-of)
//         - { title: "UX" }                      # PositionTitle
//                                        # Private-sector role names like
//                                        # "UI/UX Engineer" match ~0 federal
//                                        # postings, and Keyword has no OR —
//                                        # so run several narrow queries and
//                                        # merge. queries wins over keywords.
//       locationName: "Washington, DC"   # optional; API expects "City, State"
//       radius: 50                       # miles around locationName
//       days: 30                         # DatePosted window (API caps at 60)
//       size: 500                        # ResultsPerPage (API max 500)
//     enabled: true

import { resolveProfileKeywords } from './_profile-keywords.mjs';
import { intInRange } from './_config-utils.mjs';

const API_URL = 'https://data.usajobs.gov/api/search';
const JOB_BASE = 'https://www.usajobs.gov/job/';

// One warning per process, not per keyword per entry — the degrade path must
// not turn a scan log into a wall of the same line.
let warnedNoKey = false;

/**
 * Reads and sanitizes the entry's `usajobs:` config block.
 * @param {{ usajobs?: any }} entry
 * @returns {{ keywords: string[], queries: Array<{keyword?: string, series?: string, title?: string}>, locationName: string, radius: number, days: number, size: number }}
 */
export function parseUsajobsConfig(entry) {
  const cfg = (entry && entry.usajobs) || {};
  const keywords = Array.isArray(cfg.keywords)
    ? cfg.keywords.filter(k => typeof k === 'string' && k.trim()).map(k => k.trim())
    : [];
  const str = v => (typeof v === 'string' || typeof v === 'number') && String(v).trim() ? String(v).trim() : undefined;
  const queries = Array.isArray(cfg.queries)
    ? cfg.queries
      .filter(q => q && typeof q === 'object')
      .map(q => ({ keyword: str(q.keyword), series: str(q.series), title: str(q.title) }))
      .filter(q => q.keyword || q.series || q.title)
    : [];
  return {
    keywords,
    queries,
    locationName: typeof cfg.locationName === 'string' ? cfg.locationName.trim() : '',
    radius: intInRange(cfg.radius, 0, 0, 1000),  // miles; only sent when locationName is set
    days: intInRange(cfg.days, 30, 0, 60),       // DatePosted accepts 0–60 (docs)
    size: intInRange(cfg.size, 500, 1, 500),     // ResultsPerPage max 500 (docs)
  };
}

/**
 * Normalizes one SearchResultItems entry into a Job, or null when it lacks a
 * usable title or URL. The outgoing URL is normalized to the public
 * www.usajobs.gov/job/{controlNumber} page (MatchedObjectId is the control
 * number, and PositionURI's GetJob/ViewDetails form 301s there anyway); a
 * non-numeric MatchedObjectId falls back to PositionURI, accepted only on a
 * usajobs.gov host so a poisoned payload cannot inject foreign URLs.
 * @param {any} item
 * @returns {({title: string, url: string, company: string, location: string, description?: string, postedAt?: number}) | null}
 */
export function normalizeItem(item) {
  const d = item && item.MatchedObjectDescriptor;
  if (!d || typeof d !== 'object') return null;
  const title = String(d.PositionTitle || '').trim();
  if (!title) return null;

  let url = '';
  const id = String((item && item.MatchedObjectId) || '').trim();
  if (/^\d+$/.test(id)) {
    url = JOB_BASE + id;
  } else if (typeof d.PositionURI === 'string') {
    try {
      const u = new URL(d.PositionURI);
      if (u.protocol === 'https:' && (u.hostname === 'usajobs.gov' || u.hostname.endsWith('.usajobs.gov'))) {
        url = u.href;
      }
    } catch { /* not a URL → no fallback */ }
  }
  if (!url) return null;

  const location = String(
    d.PositionLocationDisplay
    || (Array.isArray(d.PositionLocation) && d.PositionLocation[0] && d.PositionLocation[0].LocationName)
    || '',
  ).trim();

  /** @type {{title: string, url: string, company: string, location: string, description?: string, postedAt?: number}} */
  const job = {
    title,
    url,
    company: String(d.OrganizationName || d.DepartmentName || '').trim(),
    location,
  };
  // QualificationSummary rides along in the list payload for free (zero-token).
  if (typeof d.QualificationSummary === 'string' && d.QualificationSummary.trim()) {
    job.description = d.QualificationSummary.trim();
  }
  const posted = Date.parse(d.PublicationStartDate);
  if (Number.isFinite(posted)) job.postedAt = posted;
  return job;
}

/** @type {Provider} */
export default {
  id: 'usajobs',

  /**
   * Fetches and normalizes postings from the USAJOBS Position Search API.
   * @param {{ name?: string, usajobs?: any }} entry
   * @param {{ fetchJson: (url: string, opts?: object) => Promise<any> }} ctx
   * @returns {Promise<Array<{title: string, url: string, company: string, location: string}>>}
   */
  async fetch(entry, ctx) {
    const apiKey = String(process.env.USAJOBS_API_KEY || '').trim();
    const email = String(process.env.USAJOBS_EMAIL || '').trim();
    if (!apiKey || !email) {
      if (!warnedNoKey) {
        warnedNoKey = true;
        console.error('⚠️  usajobs: USAJOBS_API_KEY / USAJOBS_EMAIL not set — skipping (free key: developer.usajobs.gov)');
      }
      return [];
    }

    let { keywords, queries, locationName, radius, days, size } = parseUsajobsConfig(entry);
    if (!queries.length) {
      // Same convention vdab.mjs/jobbankca.mjs use: no keywords of its own →
      // fall back to config/profile.yml's target_roles.
      if (!keywords.length) keywords = resolveProfileKeywords();
      queries = keywords.map(keyword => ({ keyword }));
    }
    if (!queries.length) {
      throw new Error(`usajobs: entry "${entry.name || '(unnamed)'}" has no usajobs.queries[]/keywords[] and profile.yml provided no target_roles`);
    }

    const byUrl = new Map();
    const errors = [];
    let succeeded = 0;
    for (const q of queries) {
      const kw = [q.series && `series ${q.series}`, q.keyword, q.title && `title ${q.title}`].filter(Boolean).join(' / ');
      const params = new URLSearchParams({
        ResultsPerPage: String(size),
        DatePosted: String(days),
      });
      if (q.keyword) params.set('Keyword', q.keyword);
      if (q.series) params.set('JobCategoryCode', q.series);
      if (q.title) params.set('PositionTitle', q.title);
      if (locationName) {
        params.set('LocationName', locationName);
        if (radius > 0) params.set('Radius', String(radius));
      }
      // ponytail: single page per keyword (API max 500) — add Page pagination
      // if a keyword ever legitimately exceeds 500 hits in the DatePosted window.
      let json;
      try {
        // redirect:'error' prevents SSRF via server-side redirects (repo convention).
        json = await ctx.fetchJson(`${API_URL}?${params.toString()}`, {
          headers: {
            'Authorization-Key': apiKey,
            // _http.mjs merges { 'user-agent': DEFAULT, ...headers } — the
            // lowercase key is what overrides its default. USAJOBS requires
            // the registered email here.
            'user-agent': email,
            accept: 'application/json',
          },
          redirect: 'error',
          timeoutMs: 12_000,
        });
      } catch (err) {
        // Recall-first: tolerate a single failed keyword and keep going.
        errors.push(`"${kw}": ${(err && err.message) || err}`);
        continue;
      }
      const items = json && json.SearchResult && json.SearchResult.SearchResultItems;
      if (!Array.isArray(items)) {
        // A 200 whose body is not the documented shape must not masquerade as
        // an empty board — count it as a failed keyword, with enough of the
        // shape in the message to debug from a log line.
        errors.push(`"${kw}": unexpected response — expected SearchResult.SearchResultItems[], got keys: [${json && typeof json === 'object' ? Object.keys(json).join(', ') : String(json)}]`);
        continue;
      }
      succeeded++;
      for (const raw of items) {
        const job = normalizeItem(raw);
        if (job && !byUrl.has(job.url)) byUrl.set(job.url, job);
      }
    }

    // Total outage = every keyword failed. A keyword that answered with zero
    // results is not an outage — key off the success count.
    if (succeeded === 0 && errors.length) {
      throw new Error(`usajobs: all ${queries.length} keyword request(s) failed — ${errors[0]}`);
    }

    return [...byUrl.values()];
  },
};
