// tests/arbeitsagentur-liveness.test.mjs — per-job liveness for Arbeitsagentur
// postings via the v4 jobdetails endpoint. Offline: fetch is stubbed.
//
// providers/arbeitsagentur.mjs records that the v4 search+detail endpoints 404'd
// on 2026-08-04 (#2494). The v4 DETAIL endpoint answers this public client key
// again (probed 2026-08-28: 200 JSON for ten live refnrs sampled from a fresh
// v6 search, 404 STELLENANGEBOT_NICHT_GEFUNDEN for an unknown one), while every
// v5/v6 detail variant 403s the key — so v4 jobdetails is the only per-job rung
// available, and these tests pin the mapping and verdicts it rests on.
import { pass, fail } from './helpers.mjs';
import { resolveAtsApi, checkLivenessViaApi } from '../liveness-api.mjs';

console.log('\narbeitsagentur-liveness — per-job v4 jobdetails rung');

const eq = (actual, expected, label) =>
  actual === expected ? pass(label) : fail(`${label} — got ${JSON.stringify(actual)}, expected ${JSON.stringify(expected)}`);

const POSTING = 'https://www.arbeitsagentur.de/jobsuche/jobdetail/16012-44394245-821-S';

// ── URL → API resolution (pure, offline) ────────────────────────────

const resolved = resolveAtsApi(POSTING);
eq(
  resolved?.apiUrl,
  'https://rest.arbeitsagentur.de/jobboerse/jobsuche-service/pc/v4/jobdetails/MTYwMTItNDQzOTQyNDUtODIxLVM',
  'jobdetail URL resolves to the v4 per-job API with a base64url refnr',
);
eq(resolved?.headers?.['X-API-Key'], 'jobboerse-jobsuche', 'the public client key rides on the request (the endpoint 403s without it)');

// Partner refnrs carry "_"; base64url keeps the path segment SAFE_SEGMENT-clean
// either way, so the raw refnr never reaches the URL.
eq(
  resolveAtsApi('https://www.arbeitsagentur.de/jobsuche/jobdetail/12265-346369_JB5232982-S')?.apiUrl,
  `https://rest.arbeitsagentur.de/jobboerse/jobsuche-service/pc/v4/jobdetails/${Buffer.from('12265-346369_JB5232982-S').toString('base64url')}`,
  'a partner refnr with an underscore is base64url-encoded, never sent raw',
);

// Only the jobdetail shape is claimed — everything else on the portal belongs
// to the browser rung.
eq(resolveAtsApi('https://www.arbeitsagentur.de/jobsuche/suche?was=Data+Scientist'), null, 'a jobsuche search URL is not claimed');
eq(resolveAtsApi('https://www.arbeitsagentur.de/'), null, 'the portal root is not claimed');

// ── Verdicts (stubbed fetch, no network) ────────────────────────────

const realFetch = globalThis.fetch;
let lastFetchOpts = null;
const stub = (impl) => { globalThis.fetch = async (url, opts) => { lastFetchOpts = opts; return impl(url, opts); }; };
const res = (status, body = {}) => async () => ({
  status,
  url: '',
  json: async () => body,
  text: async () => JSON.stringify(body),
});

try {
  stub(res(200, { stellenangebotsTitel: 'Data Scientist (w/m/d)' }));
  eq((await checkLivenessViaApi(POSTING))?.result, 'active', '200 -> active (per-job endpoint, the 200 is itself proof)');
  // Pinned at the wire, not just at resolveAtsApi — dropping the headers
  // plumbing would make every request 403 and silently degrade the whole rung
  // to the browser fallback.
  eq(lastFetchOpts?.headers?.['X-API-Key'], 'jobboerse-jobsuche', 'the API key reaches the actual request');

  stub(res(404, { messages: [{ code: 'STELLENANGEBOT_NICHT_GEFUNDEN' }] }));
  const gone = await checkLivenessViaApi(POSTING);
  eq(gone?.result, 'expired', '404 -> expired (posting removed)');
  eq(gone?.code, 'arbeitsagentur_api_gone', 'the expiry is coded as this provider\'s API verdict');

  // A 404 WITHOUT the posting-level code is a route-level 404 — the #2494
  // failure mode. It must stay inconclusive, never mass-expire the channel.
  stub(res(404, { error: 'no such route' }));
  eq(await checkLivenessViaApi(POSTING), null, 'a 404 without STELLENANGEBOT_NICHT_GEFUNDEN -> null (dead route, never expired)');

  // 5xx / network failure must NEVER read as expired — null hands the URL to
  // the browser rung (or --api-only reports it skipped) instead of guessing.
  stub(res(500));
  eq(await checkLivenessViaApi(POSTING), null, '5xx -> null (inconclusive, never expired)');

  stub(async () => { throw new Error('network down'); });
  eq(await checkLivenessViaApi(POSTING), null, 'network error -> null (inconclusive, never expired)');
} finally {
  globalThis.fetch = realFetch;
}
