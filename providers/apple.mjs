// @ts-check
/** @typedef {import('./_types.js').Provider} Provider */

// Apple provider — jobs.apple.com's own search API. Plain fetch works; the
// earlier "needs Playwright" verdict came from calling the dead
// /api/role/search path without a token. Two steps (verified 2026-09-24):
//
//   GET  /api/v1/CSRFToken  → `x-apple-csrf-token` header + session cookies
//   POST /api/v1/search     {query, filters:{locations:[…]}, page, locale, sort, format}
//     → {res:{totalRecords, searchResults:[{id, postingTitle,
//        transformedPostingTitle, postDateInGMT, locations:[{name,…}]}]}}
//
// 20 results per page, `page` is 1-based. Location ids are Apple's own
// ("postLocation-SDO" = San Diego); configure with an `apple:` block:
//
//   - name: Apple
//     provider: apple
//     apple:
//       locations: [postLocation-SDO]

const ORIGIN = 'https://jobs.apple.com';
const PAGE_SIZE = 20; // fixed by the API
const MAX_PAGES = 60; // 1,200 postings; San Diego alone was ~430 at wiring time

/** @param {import('./_types.js').PortalEntry & {apple?: {locations?: string[]}}} entry */
function locationsOf(entry) {
  const locs = entry.apple?.locations;
  return Array.isArray(locs) && locs.length ? locs.map(String) : ['postLocation-SDO'];
}

/** @type {Provider} */
export default {
  id: 'apple',

  detect(entry) {
    const url = entry.api || entry.careers_url || '';
    try {
      if (new URL(url).host.toLowerCase() === 'jobs.apple.com') return { url };
    } catch { /* not an absolute URL */ }
    return null;
  },

  async fetch(entry, ctx) {
    const tokenRes = await ctx.fetchResponse(`${ORIGIN}/api/v1/CSRFToken`, { redirect: 'error' });
    const token = tokenRes.headers.get('x-apple-csrf-token');
    if (!token) throw new Error('apple: CSRFToken response carried no x-apple-csrf-token header');
    const cookie = (typeof tokenRes.headers.getSetCookie === 'function' ? tokenRes.headers.getSetCookie() : [])
      .map((c) => c.split(';')[0]).join('; ');

    const locations = locationsOf(entry);
    const ctxCap = Number.isInteger(ctx?.maxPages) && ctx.maxPages > 0 ? ctx.maxPages : Infinity;
    const jobs = [];
    const seen = new Set();
    for (let page = 1; page <= Math.min(MAX_PAGES, ctxCap); page++) {
      const json = /** @type {any} */ (await ctx.fetchJson(`${ORIGIN}/api/v1/search`, {
        method: 'POST',
        redirect: 'error',
        headers: {
          'Content-Type': 'application/json',
          'x-apple-csrf-token': token,
          cookie,
          Origin: ORIGIN,
          Referer: `${ORIGIN}/en-us/search`,
        },
        // `format` looks cosmetic but is required — without it the API answers
        // 200 with totalRecords 0.
        body: JSON.stringify({
          query: '', filters: { locations }, page, locale: 'en-us', sort: 'newest',
          format: { longDate: 'MMMM D, YYYY', mediumDate: 'MMM D, YYYY' },
        }),
      }));
      const results = Array.isArray(json?.res?.searchResults) ? json.res.searchResults : [];
      let fresh = 0;
      for (const r of results) {
        if (!r?.id || seen.has(r.id)) continue;
        seen.add(r.id);
        fresh++;
        const posted = Date.parse(r.postDateInGMT);
        jobs.push({
          title: String(r.postingTitle || '').trim(),
          // Pipeline roles carry id "PIPE-<n>", which 301s to /details/<n>; strip the prefix.
          url: `${ORIGIN}/en-us/details/${encodeURIComponent(String(r.id).replace(/^(PIPE|REQ)-/, ''))}/${r.transformedPostingTitle || 'job'}`,
          company: entry.name,
          location: (r.locations || []).map((l) => l?.name).filter(Boolean).join('; '),
          postedAt: Number.isNaN(posted) ? undefined : posted,
        });
      }
      if (fresh === 0 || results.length < PAGE_SIZE) break;
    }
    return jobs;
  },
};
