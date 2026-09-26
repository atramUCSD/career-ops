// tests/francetravail-liveness.test.mjs — per-offer liveness for France
// Travail postings via the authenticated v2 /offres/{id} endpoint. Offline:
// fetch is stubbed, credentials are injected via env and restored after.
//
// DOCUMENTED-ONLY channel (never exercised with real credentials): the
// OpenAPI spec (api id 84) defines 200 = offer, 204 = "L'offre n'existe pas",
// and documents NO 404 — so 204 is the only gone signal and a bare 404 stays
// inconclusive. These tests also pin the wire-level auth: the OAuth
// client-credentials POST shape and the bearer reaching the offer request —
// dropping either would silently degrade the rung.
//
// ORDER MATTERS: the module caches the token per process and poisons the batch
// on a 401/403, so the creds-absent case runs first and the credential-outage
// case runs last.
import { pass, fail } from './helpers.mjs';
import { resolveAtsApi, checkLivenessViaApi } from '../liveness-api.mjs';

console.log('\nfrancetravail-liveness — per-offer v2 /offres/{id} rung');

const eq = (actual, expected, label) =>
  actual === expected ? pass(label) : fail(`${label} — got ${JSON.stringify(actual)}, expected ${JSON.stringify(expected)}`);

const POSTING = 'https://candidat.francetravail.fr/offres/recherche/detail/165YMBS';
const TOKEN_URL = 'https://entreprise.francetravail.fr/connexion/oauth2/access_token';
const OFFER_URL = 'https://api.francetravail.io/partenaire/offresdemploi/v2/offres/165YMBS';

// ── URL → API resolution (pure, offline) ────────────────────────────

eq(resolveAtsApi(POSTING)?.apiUrl, OFFER_URL, 'a candidat detail URL resolves to the v2 per-offer endpoint');
eq(resolveAtsApi(POSTING)?.api404Authoritative, false, 'a bare 404 is never authoritative (the spec documents no 404)');
eq(resolveAtsApi('https://candidat.francetravail.fr/offres/recherche/detail/165YMBS/postuler'), null, 'a deeper path is not claimed');
eq(resolveAtsApi('https://candidat.francetravail.fr/offres/recherche?motsCles=data'), null, 'a search URL is not claimed');
// Partner-origin offers live on partner hosts — this API cannot attest them.
eq(resolveAtsApi('https://www.partnerjobs.example/offre/165YMBS'), null, 'a partner-host offer URL is not claimed');

// ── Verdicts (stubbed fetch + injected env, no network) ─────────────

const realFetch = globalThis.fetch;
const ENV_KEYS = ['FRANCETRAVAIL_CLIENT_ID', 'FRANCETRAVAIL_CLIENT_SECRET'];
const savedEnv = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]));

const calls = [];
const countCalls = (prefix) => calls.filter((c) => c.url.startsWith(prefix)).length;
// Route the stub by URL prefix: the token POST and the offer GET hit different hosts.
const stub = (offerImpl, tokenImpl) => {
  globalThis.fetch = async (url, opts) => {
    calls.push({ url: String(url), opts });
    if (String(url).startsWith(TOKEN_URL)) {
      if (!tokenImpl) throw new Error('unexpected token fetch');
      return tokenImpl(url, opts);
    }
    return offerImpl(url, opts);
  };
};
const res = (status, body) => async () => ({
  status,
  url: '',
  json: async () => { if (typeof body === 'string') throw new Error('not JSON'); return body; },
  text: async () => (typeof body === 'string' ? body : body === undefined ? '' : JSON.stringify(body)),
});
const tokenOk = res(200, { access_token: 'tok-123', token_type: 'Bearer', expires_in: 1499 });

try {
  // 1. CREDENTIALS ABSENT → the rung skips entirely: no token fetch, no offer
  // fetch, no verdict — the offer degrades silently to the browser rung.
  for (const k of ENV_KEYS) delete process.env[k];
  stub(res(200, { id: '165YMBS' }), tokenOk);
  eq(await checkLivenessViaApi(POSTING), null, 'credentials absent -> null (rung skipped, never classifies)');
  eq(calls.length, 0, 'credentials absent -> zero requests fired');

  process.env.FRANCETRAVAIL_CLIENT_ID = 'PAR_test_client';
  process.env.FRANCETRAVAIL_CLIENT_SECRET = 'test_secret';

  // 2. Live offer: token POST then offer GET.
  stub(res(200, { id: '165YMBS', intitule: 'Data Engineer' }), tokenOk);
  const live = await checkLivenessViaApi(POSTING);
  eq(live?.result, 'active', '200 with the matching offer id -> active');
  eq(live?.code, 'francetravail_api_ok', 'the live verdict carries its own code');

  // Wire-level auth, pinned at the request — not just at resolveAtsApi.
  const tokenCall = calls.find((c) => c.url.startsWith(TOKEN_URL));
  const body = String(tokenCall?.opts?.body ?? '');
  eq(tokenCall?.url.includes('realm=%2Fpartenaire'), true, 'the token POST targets the /partenaire realm');
  eq(body.includes('grant_type=client_credentials'), true, 'the token POST is a client-credentials grant');
  eq(body.includes('scope=api_offresdemploiv2+o2dsoffre'), true, 'the token POST carries both scopes');
  eq(body.includes('client_id=PAR_test_client'), true, 'the token POST carries the env client id');
  const offerCall = calls.find((c) => c.url === OFFER_URL);
  eq(offerCall?.opts?.headers?.authorization, 'Bearer tok-123', 'the bearer token reaches the offer request');

  // 3. The documented gone signal: 204, empty body. The token is cached — no
  // second token fetch across the batch.
  stub(res(204, undefined), tokenOk);
  const gone = await checkLivenessViaApi(POSTING);
  eq(gone?.result, 'expired', "204 -> expired (the spec's \"L'offre n'existe pas\")");
  eq(gone?.code, 'francetravail_api_gone', 'the gone verdict carries its own code');
  eq(countCalls(TOKEN_URL), 1, 'the token is fetched once per run, not per offer');

  // A 204 with a body is NOT the documented gone shape → inconclusive.
  stub(res(204, 'unexpected body'), tokenOk);
  eq(await checkLivenessViaApi(POSTING), null, 'a 204 with a body -> null (not the documented shape)');

  // 4. A bare 404 is UNDOCUMENTED for this endpoint — never gone. This is the
  // dead-route guard: if the route 404s wholesale, nothing mass-expires.
  stub(res(404, { message: 'not found' }), tokenOk);
  eq(await checkLivenessViaApi(POSTING), null, '404 -> null (undocumented status, dead route never mass-expires)');

  // 5. A 200 without a matching offer id proves nothing either way.
  stub(res(200, { id: 'OTHER99' }), tokenOk);
  eq((await checkLivenessViaApi(POSTING))?.result, 'uncertain', '200 with a different offer id -> uncertain');
  stub(res(200, '<html>maintenance</html>'), tokenOk);
  eq((await checkLivenessViaApi(POSTING))?.result, 'uncertain', '200 with an unparseable body -> uncertain (never gone, never live)');

  // 6. 5xx / network failure must NEVER read as expired.
  stub(res(500, { error: 'oops' }), tokenOk);
  eq(await checkLivenessViaApi(POSTING), null, '5xx -> null (inconclusive, never expired)');
  stub(async () => { throw new Error('network down'); }, tokenOk);
  eq(await checkLivenessViaApi(POSTING), null, 'network error -> null (inconclusive, never expired)');

  // 7. LAST (poisons the batch): a 401 is a credential outage, not per-offer
  // evidence — and the whole batch degrades instead of hammering the API.
  stub(res(401, undefined), tokenOk);
  eq(await checkLivenessViaApi(POSTING), null, '401 -> null (credential outage, not a verdict on the offer)');
  const before = calls.length;
  stub(res(200, { id: '165YMBS' }), tokenOk);
  eq(await checkLivenessViaApi(POSTING), null, 'after a 401, subsequent offers skip the rung (batch degraded)');
  eq(calls.length, before, 'the degraded batch fires no further requests');
} finally {
  globalThis.fetch = realFetch;
  for (const k of ENV_KEYS) {
    if (savedEnv[k] === undefined) delete process.env[k];
    else process.env[k] = savedEnv[k];
  }
}
