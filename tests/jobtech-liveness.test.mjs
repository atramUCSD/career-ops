// tests/jobtech-liveness.test.mjs — per-ad liveness for Platsbanken postings
// via the zero-auth JobSearch /ad/{id} endpoint. Offline: fetch is stubbed.
//
// JobTech answers removals with a 200 TOMBSTONE (removed: true) long before an
// ad is purged to a true 404, and its 404s come in two shapes with opposite
// meanings: posting-level ('Ad not found' in the body) and route/gateway-level
// ({tracking_id, cause}). These tests pin the tombstone reading and the
// dead-route guard — a dead route must never mass-expire the channel (#2494).
import { pass, fail } from './helpers.mjs';
import { resolveAtsApi, checkLivenessViaApi } from '../liveness-api.mjs';

console.log('\njobtech-liveness — per-ad /ad/{id} rung');

const eq = (actual, expected, label) =>
  actual === expected ? pass(label) : fail(`${label} — got ${JSON.stringify(actual)}, expected ${JSON.stringify(expected)}`);

const POSTING = 'https://arbetsformedlingen.se/platsbanken/annonser/29357173';
const API = 'https://jobsearch.api.jobtechdev.se/ad/29357173';

// ── URL → API resolution (pure, offline) ────────────────────────────

eq(resolveAtsApi(POSTING)?.apiUrl, API, 'a Platsbanken annons URL resolves to the per-ad JobSearch endpoint');
eq(resolveAtsApi('https://www.arbetsformedlingen.se/platsbanken/annonser/29357173/')?.apiUrl, API, 'the www + trailing-slash variant resolves too');
eq(resolveAtsApi(POSTING)?.timeoutMs, 15_000, 'the slow-gateway timeout rides along (8s default would time out live ads)');
eq(resolveAtsApi('https://arbetsformedlingen.se/platsbanken/annonser/abc123'), null, 'a non-numeric id is not claimed');
eq(resolveAtsApi('https://arbetsformedlingen.se/platsbanken/sok?q=data'), null, 'a Platsbanken search page is not claimed');
eq(resolveAtsApi('https://arbetsformedlingen.se/'), null, 'the portal root is not claimed');

// ── Verdicts (stubbed fetch, no network) ────────────────────────────

const realFetch = globalThis.fetch;
const stub = (impl) => { globalThis.fetch = impl; };
const res = (status, body) => async () => ({
  status,
  url: '',
  json: async () => { if (typeof body === 'string') throw new Error('not JSON'); return body; },
  text: async () => (typeof body === 'string' ? body : JSON.stringify(body)),
});

try {
  stub(res(200, { id: '29357173', headline: 'Data Engineer', removed: false }));
  eq((await checkLivenessViaApi(POSTING))?.result, 'active', '200 removed:false -> active');

  // Some payload variants omit `removed` entirely; a headline is the live signal then.
  stub(res(200, { id: '29357173', headline: 'Data Engineer' }));
  eq((await checkLivenessViaApi(POSTING))?.result, 'active', '200 with a headline and no removed field -> active');

  // The tombstone: the API keeps serving removed ads as 200 with removed:true,
  // removed_date set, headline null — the authoritative gone-proof, seen long
  // before the ad is purged to a real 404.
  stub(res(200, { id: '29357173', removed: true, removed_date: '2026-08-28T10:00:00', headline: null }));
  const tomb = await checkLivenessViaApi(POSTING);
  eq(tomb?.result, 'expired', '200 removed:true -> expired (tombstone)');
  eq(tomb?.code, 'jobtech_removed_tombstone', 'the tombstone verdict carries its own code');

  stub(res(200, '<html>gateway error page</html>'));
  eq(await checkLivenessViaApi(POSTING), null, 'a 200 with an unparseable body -> null (browser fallback)');

  // A 200 that parses but matches neither shape (no removed, no headline) is
  // an unrecognized payload — never a verdict.
  stub(res(200, { message: 'unexpected shape' }));
  eq(await checkLivenessViaApi(POSTING), null, 'a 200 with an unrecognized JSON shape -> null');

  // Posting-level 404 carries 'Ad not found' in its body — trustworthy gone.
  stub(res(404, 'Ad not found. You have requested this URI [/ad/29357173] but did you mean /ad/29357173 ?'));
  const gone = await checkLivenessViaApi(POSTING);
  eq(gone?.result, 'expired', "404 with 'Ad not found' -> expired (ad purged)");
  eq(gone?.code, 'jobtech_api_gone', 'the purge verdict carries its own code');

  // Route/gateway-level 404 has a DIFFERENT body shape and no marker — the
  // dead-route case. It must stay inconclusive, never mass-expire the channel.
  stub(res(404, { tracking_id: 'abc', cause: { code: '404', message: 'resource_not_found' } }));
  eq(await checkLivenessViaApi(POSTING), null, "a 404 without 'Ad not found' -> null (dead route, never expired)");

  // 5xx / network failure must NEVER read as expired.
  stub(res(500, { error: 'oops' }));
  eq(await checkLivenessViaApi(POSTING), null, '5xx -> null (inconclusive, never expired)');

  stub(async () => { throw new Error('network down'); });
  eq(await checkLivenessViaApi(POSTING), null, 'network error -> null (inconclusive, never expired)');
} finally {
  globalThis.fetch = realFetch;
}
