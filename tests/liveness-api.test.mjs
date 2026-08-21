// tests/liveness-api.test.mjs — the API rung must cover the ATSs the browser rung
// gets WRONG, and must never turn an ambiguous answer into an expiry.
//
// Two of these providers exist because the Playwright classifier actively
// misreports them: iCIMS serves the posting in an iframe (headless reads
// nav/footer only), and Greenhouse's embedded board puts the posting on the
// employer's own domain, which the classifier has no ATS knowledge of at all.
//
// The Greenhouse-embed case carries a trap worth stating: its board token is
// INFERRED from the hostname, and the per-job endpoint answers "Job not found"
// both for a removed posting and for a board that never existed. Trusting that
// 404 would purge live postings on every domain whose label is not its token.
import { pass, fail } from './helpers.mjs';
import { resolveAtsApi, isAtsPosting, checkLivenessViaApi } from '../liveness-api.mjs';

console.log('\nliveness-api — ATS coverage and ambiguous-404 handling');

const eq = (actual, expected, label) =>
  actual === expected ? pass(label) : fail(`${label} — got ${JSON.stringify(actual)}, expected ${JSON.stringify(expected)}`);

// ── URL → API resolution (pure, offline) ────────────────────────────

const r = (url) => resolveAtsApi(url);

eq(
  r('https://careers-peraton.icims.com/jobs/169611/full-stack-microservices-developer/job')?.apiUrl,
  'https://careers-peraton.icims.com/jobs/169611/job?in_iframe=1',
  'iCIMS posting resolves to the iframe URL (which returns the posting body over plain HTTP)',
);

eq(r('https://careers-peraton.icims.com/jobs/169611/x/job')?.accept, 'text/html', 'iCIMS requests HTML, not JSON');

eq(
  r('https://databricks.com/company/careers/open-positions/job?gh_jid=8546367002')?.apiUrl,
  'https://boards-api.greenhouse.io/v1/boards/databricks/jobs/8546367002',
  'Greenhouse embed on a vanity domain resolves to the per-job API',
);

eq(
  r('https://careers.airbnb.com/positions/x?gh_jid=123')?.parts?.board,
  'airbnb',
  'careers. subdomain is stripped before inferring the board token',
);

eq(
  r('https://jobs.smartrecruiters.com/ServiceNow/744000142224909-staff-ux-researcher')?.apiUrl,
  'https://api.smartrecruiters.com/v1/companies/ServiceNow/postings/744000142224909',
  'SmartRecruiters posting resolves to its per-posting API',
);

// A greenhouse.io URL stating its real board must never fall through to the
// guess-the-token provider — the path is authoritative, the hostname is not.
eq(
  r('https://job-boards.greenhouse.io/acme/jobs/123?gh_jid=123')?.ats,
  'greenhouse',
  'a greenhouse.io URL uses its path board token, not the hostname guess',
);

// Coverage must never be claimed by guessing: a host this module does not know
// belongs to the browser rung, whatever its URL looks like.
eq(isAtsPosting('https://jobs.example.com/careers/job/123'), false, 'unknown ATS is still browser-only (no false coverage claim)');
eq(isAtsPosting('http://databricks.com/x?gh_jid=1'), false, 'non-https is refused');
eq(r('https://databricks.com/careers/job'), null, 'a vanity domain WITHOUT gh_jid is not claimed');
eq(r('https://databricks.com/careers/job?gh_jid=not-a-number'), null, 'a non-numeric gh_jid is refused rather than sent to the API');

// ── The ambiguous 404 (stubbed fetch, offline) ──────────────────────
//
// Greenhouse answers `{"error":"Job not found"}` for a removed posting AND for a
// board that does not exist, so the 404 alone cannot be trusted. The board
// endpoint is what separates them.
const realFetch = globalThis.fetch;
const stubFetch = (routes) => {
  globalThis.fetch = async (url) => {
    for (const [pattern, response] of routes) {
      if (url.includes(pattern)) return response();
    }
    throw new Error(`unstubbed fetch: ${url}`);
  };
};
const res = (status, body = {}) => () => ({
  status,
  url: '',
  json: async () => body,
  text: async () => JSON.stringify(body),
});

try {
  // Posting 404s, board exists → the token was right, so the posting is gone.
  stubFetch([
    ['/jobs/', res(404, { status: 404, error: 'Job not found' })],
    ['/v1/boards/databricks', res(200, { name: 'Databricks' })],
  ]);
  const gone = await checkLivenessViaApi('https://databricks.com/careers/job?gh_jid=1');
  eq(gone?.result, 'expired', 'posting 404 + board 200 -> expired');

  // Posting 404s, board 404s → the hostname was not the token. Inconclusive.
  stubFetch([
    ['/jobs/', res(404, { status: 404, error: 'Job not found' })],
    ['/v1/boards/', res(404, { status: 404, error: 'Job board not found' })],
  ]);
  const guessed = await checkLivenessViaApi('https://www.pinterestcareers.com/careers?gh_jid=1');
  eq(guessed, null, 'posting 404 + board 404 (bad token guess) -> null, NOT expired');

  // The board check itself failing must not decide anything either.
  stubFetch([
    ['/jobs/', res(404, { status: 404, error: 'Job not found' })],
    ['/v1/boards/', res(500)],
  ]);
  eq(await checkLivenessViaApi('https://databricks.com/careers/job?gh_jid=1'), null, 'board check 5xx -> null, not expired');

  // Providers WITHOUT the ambiguity keep trusting a bare 404/410 — iCIMS's 410
  // comes from the tenant's own host and means exactly one thing.
  stubFetch([['icims.com', res(410)]]);
  const icimsGone = await checkLivenessViaApi('https://careers-peraton.icims.com/jobs/999999/x/job');
  eq(icimsGone?.result, 'expired', 'iCIMS 410 -> expired without a second request');

  stubFetch([['icims.com', res(200)]]);
  const icimsLive = await checkLivenessViaApi('https://careers-peraton.icims.com/jobs/169611/x/job');
  eq(icimsLive?.result, 'active', 'iCIMS 200 -> active (the verdict the browser rung got wrong)');
} finally {
  globalThis.fetch = realFetch;
}

// ── Eightfold: the last browser-only ATS ────────────────────────────
//
// Eightfold serves each employer from that employer's OWN host, so there is no
// vendor suffix to key on — which is why these postings had no API rung and why
// the Playwright classifier cannot recognize them either. The host allowlist is
// what keeps "fetch a fixed, known host" true for this provider.

eq(
  r('https://careers.qualcomm.com/careers/job/446714907756')?.apiUrl,
  'https://careers.qualcomm.com/api/apply/v2/jobs/446714907756',
  'Eightfold posting resolves to the per-job API on the same branded host',
);

eq(
  r('https://apply.careers.microsoft.com/careers/job/1970393556927681')?.ats,
  'eightfold',
  'a second branded Eightfold host resolves through the same provider',
);

eq(r('https://acme.eightfold.ai/careers/job/123')?.ats, 'eightfold', 'a first-party *.eightfold.ai host needs no allowlist entry');

// `/careers/job/{digits}` is a common enough path that matching it anywhere
// would send requests to arbitrary hosts — the allowlist, not the path, decides.
eq(r('https://careers.example.com/careers/job/123'), null, 'an unlisted host is NOT claimed on path shape alone');
eq(r('https://careers.qualcomm.com/careers/job/not-a-number'), null, 'a non-numeric Eightfold job id is refused');

// The `?domain=` param other Eightfold callers send is deliberately omitted: a
// WRONG domain 404s, so guessing one could manufacture a false expiry.
if (!r('https://careers.qualcomm.com/careers/job/446714907756')?.apiUrl.includes('domain='))
  pass('the guessable ?domain= param is not sent (a wrong value 404s — that would be a false expiry)');
else fail('Eightfold API URL should not carry a guessed ?domain= param');

try {
  // Unlike embedded Greenhouse, nothing here is inferred, so a bare 404 is a real
  // answer about this posting and needs no second request to confirm.
  stubFetch([['/api/apply/v2/jobs/', res(404, { message: 'Job with ID 1 not found' })]]);
  eq((await checkLivenessViaApi('https://careers.qualcomm.com/careers/job/1'))?.result, 'expired', 'Eightfold 404 -> expired (nothing about the request was guessed)');

  stubFetch([['/api/apply/v2/jobs/', res(200, { id: 446714907756, name: 'LLM Serving Engineer' })]]);
  eq((await checkLivenessViaApi('https://careers.qualcomm.com/careers/job/446714907756'))?.result, 'active', 'Eightfold 200 -> active');
} finally {
  globalThis.fetch = realFetch;
}
