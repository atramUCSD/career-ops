// tests/nav-liveness.test.mjs — per-ad liveness for arbeidsplassen.nav.no
// postings via the pam-stilling-feed /api/v1/feedentry/{uuid} endpoint.
// Offline: fetch is stubbed.
//
// The feed needs a ROTATING public JWT (fetched from /api/publicToken per run,
// never hard-coded), retains INACTIVE entries for years — so a dead ad answers
// 200/INACTIVE, not 404 — and 401s a rotated token. These tests pin the token
// plumbing at the wire, both body verdicts, and that a 404 or token outage
// never reads as expired.
//
// ORDER MATTERS: the module caches a successful token per process (failures
// are not cached), so the token-outage case runs first.
import { pass, fail } from './helpers.mjs';
import { resolveAtsApi, checkLivenessViaApi } from '../liveness-api.mjs';

console.log('\nnav-liveness — per-ad feedentry/{uuid} rung');

const eq = (actual, expected, label) =>
  actual === expected ? pass(label) : fail(`${label} — got ${JSON.stringify(actual)}, expected ${JSON.stringify(expected)}`);

const UUID = '018d3f4e-1234-4abc-8def-0123456789ab';
const POSTING = `https://arbeidsplassen.nav.no/stillinger/stilling/${UUID}`;
const FEEDENTRY = `https://pam-stilling-feed.nav.no/api/v1/feedentry/${UUID}`;
const TOKEN_URL = 'https://pam-stilling-feed.nav.no/api/publicToken';
// Same shape extractPublicToken matches in the live body: header.payload.signature.
const JWT = 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJ0ZXN0IiwiYXVkIjoiZmVlZC1hcGktdjIifQ.c2lnbmF0dXJl';
const TOKEN_BODY = `Current public token for Nav Job Vacancy Feed:\n${JWT}`;

// ── URL → API resolution (pure, offline) ────────────────────────────

eq(resolveAtsApi(POSTING)?.apiUrl, FEEDENTRY, 'a stilling URL resolves to the per-ad feedentry endpoint');
eq(resolveAtsApi(`${POSTING}/`)?.apiUrl, FEEDENTRY, 'the trailing-slash variant resolves too');
eq(resolveAtsApi(POSTING)?.api404Authoritative, false, 'a 404 is never authoritative (the feed retains INACTIVE entries for years)');
eq(resolveAtsApi(`https://arbeidsplassen.nav.no/stillinger/stilling/${UUID.toUpperCase()}`), null, 'an uppercase uuid is not the emitted shape — not claimed');
eq(resolveAtsApi('https://arbeidsplassen.nav.no/stillinger/stilling/not-a-uuid'), null, 'a malformed uuid is not claimed (the feed 500s on those)');
eq(resolveAtsApi('https://arbeidsplassen.nav.no/stillinger?q=utvikler'), null, 'the search page is not claimed');

// ── Verdicts (stubbed fetch, no network) ────────────────────────────

const realFetch = globalThis.fetch;
const calls = [];
const countCalls = (url) => calls.filter((c) => c.url === url).length;
// Route by URL: the token GET and the feedentry GET are separate requests.
const stub = (entryImpl, tokenImpl) => {
  globalThis.fetch = async (url, opts) => {
    calls.push({ url: String(url), opts });
    if (String(url) === TOKEN_URL) {
      if (!tokenImpl) throw new Error('unexpected token fetch');
      return tokenImpl(url, opts);
    }
    return entryImpl(url, opts);
  };
};
const res = (status, body) => async () => ({
  status,
  url: '',
  json: async () => { if (typeof body === 'string') throw new Error('not JSON'); return body; },
  text: async () => (typeof body === 'string' ? body : body === undefined ? '' : JSON.stringify(body)),
});
const tokenOk = res(200, TOKEN_BODY);

const ACTIVE_BODY = { uuid: UUID, status: 'ACTIVE', ad_content: { title: 'Utvikler', link: POSTING } };
const INACTIVE_BODY = { uuid: UUID, sistEndret: '2026-08-20T10:00:00', status: 'INACTIVE' };

try {
  // 1. Token outage FIRST (failures are not cached): the rung skips cleanly —
  // no feedentry request, no verdict, browser fallback.
  stub(res(200, ACTIVE_BODY), res(500, 'Internal Server Error'));
  eq(await checkLivenessViaApi(POSTING), null, 'token endpoint down -> null (rung skipped, never classifies)');
  eq(countCalls(FEEDENTRY), 0, 'token outage -> the feedentry request is never fired');

  // 2. Live ad: token fetched, then the entry read.
  stub(res(200, ACTIVE_BODY), tokenOk);
  const live = await checkLivenessViaApi(POSTING);
  eq(live?.result, 'active', '200 status ACTIVE -> active');
  eq(live?.code, 'nav_feedentry_active', 'the live verdict carries its own code');
  // Pinned at the wire: dropping the token plumbing would 401 every request
  // and silently degrade the whole rung to the browser fallback.
  const entryCall = calls.find((c) => c.url === FEEDENTRY);
  eq(entryCall?.opts?.headers?.authorization, `Bearer ${JWT}`, 'the extracted JWT reaches the feedentry request as a bearer');

  // 3. The authoritative tombstone: INACTIVE entries are served for years.
  stub(res(200, INACTIVE_BODY), tokenOk);
  const gone = await checkLivenessViaApi(POSTING);
  eq(gone?.result, 'expired', '200 status INACTIVE -> expired (ad withdrawn)');
  eq(gone?.code, 'nav_feedentry_inactive', 'the tombstone verdict carries its own code');
  eq(countCalls(TOKEN_URL), 2, 'the token is fetched once per run after the outage — not per ad');

  // 4. A 404 (empty body) more likely means a mangled uuid than a removal —
  // and a dead route would 404 wholesale — so it stays inconclusive.
  stub(res(404, undefined), tokenOk);
  eq(await checkLivenessViaApi(POSTING), null, '404 -> null (inconclusive, dead route never mass-expires)');

  // 5. Unrecognized 200 payloads prove nothing.
  stub(res(200, { uuid: UUID }), tokenOk);
  eq(await checkLivenessViaApi(POSTING), null, 'a 200 without a recognized status -> null');
  stub(res(200, 'not json'), tokenOk);
  eq(await checkLivenessViaApi(POSTING), null, 'a 200 with an unparseable body -> null');

  // 6. A 401 means the token rotated mid-run — not a verdict on the ad — and
  // the cached token is dropped so the NEXT ad fetches a fresh one.
  const tokenFetchesBefore401 = countCalls(TOKEN_URL);
  stub(res(401, { title: 'Unauthorized' }), tokenOk);
  eq(await checkLivenessViaApi(POSTING), null, '401 (rotated token) -> null, never expired');
  stub(res(200, ACTIVE_BODY), tokenOk);
  eq((await checkLivenessViaApi(POSTING))?.result, 'active', 'the next ad after a 401 recovers with a fresh token');
  eq(countCalls(TOKEN_URL), tokenFetchesBefore401 + 1, 'the 401 evicted the cached token (one fresh fetch)');

  // 7. 5xx / network failure must NEVER read as expired.
  stub(res(500, 'Javalin error'), tokenOk);
  eq(await checkLivenessViaApi(POSTING), null, '5xx -> null (inconclusive, never expired)');
  stub(async () => { throw new Error('network down'); }, tokenOk);
  eq(await checkLivenessViaApi(POSTING), null, 'network error -> null (inconclusive, never expired)');
} finally {
  globalThis.fetch = realFetch;
}
