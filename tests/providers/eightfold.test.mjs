// tests/providers/eightfold.test.mjs — the PCSX board is rate-limit hostile and
// its list payload carries no dates in the shape the scanner expects, so the
// cases below pin config resolution, pagination bounds, and the two failure
// modes that would silently report a truncated board as a complete one.
import { pass, fail, ROOT } from '../helpers.mjs';
import { join } from 'path';
import { pathToFileURL } from 'url';

console.log('\nProvider — eightfold');

try {
  const eightfold = (await import(pathToFileURL(join(ROOT, 'providers/eightfold.mjs')).href)).default;

  const mkCtx = (fetchJson, extra = {}) => ({
    transport: 'http',
    fetchText: async () => { throw new Error('fetchText should not be called'); },
    fetchJson,
    sleep: async () => {},   // no-op so the 4s backoff never slows the suite
    ...extra,
  });

  const position = (id, over = {}) => ({
    id,
    name: `Engineer ${id}`,
    positionUrl: `/careers/job/${id}`,
    standardizedLocations: ['San Diego, CA'],
    postedTs: 1755000000,
    ...over,
  });
  const pageOf = positions => ({ data: { positions } });

  const QUALCOMM = {
    name: 'Qualcomm',
    provider: 'eightfold',
    careers_url: 'https://careers.qualcomm.com/careers',
    api: 'https://careers.qualcomm.com/api/pcsx/search?domain=qualcomm.com',
  };

  if (eightfold.id === 'eightfold') pass('eightfold.id is "eightfold"');
  else fail(`eightfold.id is ${JSON.stringify(eightfold.id)}`);

  // ── detect() ───────────────────────────────────────────────────────────────

  const hit = eightfold.detect(QUALCOMM);
  if (hit && hit.url === 'https://careers.qualcomm.com/api/pcsx/search?domain=qualcomm.com') {
    pass('eightfold.detect() resolves the PCSX search endpoint from api:');
  } else {
    fail(`eightfold.detect(api) returned ${JSON.stringify(hit)}`);
  }

  // Eightfold is white-labelled onto customer domains, so the hostname alone
  // must never claim an entry — that would shadow whichever provider owns it.
  if (eightfold.detect({ name: 'X', careers_url: 'https://careers.example.com/careers' }) === null) {
    pass('eightfold.detect() returns null without provider: eightfold');
  } else {
    fail('eightfold.detect() claimed an entry that did not opt in');
  }

  const derived = eightfold.detect({ name: 'MS', provider: 'eightfold', careers_url: 'https://apply.careers.microsoft.com/careers' });
  if (derived && derived.url === 'https://apply.careers.microsoft.com/api/pcsx/search?domain=microsoft.com') {
    pass('eightfold.detect() derives domain from a careers_url subdomain');
  } else {
    fail(`eightfold.detect(careers_url) returned ${JSON.stringify(derived)}`);
  }

  // http:// is not https:// — the scanner only talks to TLS endpoints.
  if (eightfold.detect({ name: 'X', provider: 'eightfold', careers_url: 'http://careers.example.com/careers' }) === null) {
    pass('eightfold.detect() rejects a non-HTTPS careers_url');
  } else {
    fail('eightfold.detect() accepted a plaintext URL');
  }

  // ── fetch(): request shape ─────────────────────────────────────────────────

  let firstUrl = null, firstOpts = null;
  await eightfold.fetch(QUALCOMM, mkCtx(async (u, opts) => {
    if (firstUrl === null) { firstUrl = u; firstOpts = opts; }
    return pageOf([]);
  }));
  if (firstOpts?.redirect === 'error') pass('eightfold.fetch() passes redirect:"error"');
  else fail(`eightfold.fetch() should pass redirect:"error", got ${JSON.stringify(firstOpts)}`);

  // Without the Referer the host 403s — this header IS the auth.
  if (firstOpts?.headers?.Referer === 'https://careers.qualcomm.com/careers') {
    pass('eightfold.fetch() sends the careers Referer the host requires');
  } else {
    fail(`eightfold.fetch() Referer was ${JSON.stringify(firstOpts?.headers?.Referer)}`);
  }

  // The location param is accepted but ignored by PCSX; sending it would imply
  // a filter the scanner never actually got.
  if (firstUrl && !/[?&]location=/.test(firstUrl) && firstUrl.startsWith('https://careers.qualcomm.com/api/pcsx/search?domain=qualcomm.com&')) {
    pass('eightfold.fetch() hits the PCSX search path and sends no location param');
  } else {
    fail(`eightfold.fetch() first URL was ${firstUrl}`);
  }

  // ── fetch(): normalization ─────────────────────────────────────────────────

  const jobs = await eightfold.fetch({ ...QUALCOMM, queries: ['engineer'] }, mkCtx(async () => pageOf([position('111')])));
  const j = jobs[0];
  if (jobs.length === 1 && j.url === 'https://careers.qualcomm.com/careers/job/111' && j.company === 'Qualcomm' && j.location === 'San Diego, CA') {
    pass('eightfold.fetch() normalizes a position to an absolute URL, company and location');
  } else {
    fail(`eightfold.fetch() normalized to ${JSON.stringify(j)}`);
  }

  // postedTs is epoch SECONDS. Passing it through unscaled would date every
  // posting to 1970 and make every freshness filter silently drop the board.
  if (j.postedAt === 1755000000 * 1000) pass('eightfold.fetch() converts postedTs seconds to postedAt ms');
  else fail(`eightfold.fetch() postedAt was ${j.postedAt}, expected ${1755000000 * 1000}`);

  const undated = await eightfold.fetch({ ...QUALCOMM, queries: ['engineer'] }, mkCtx(async () => pageOf([position('112', { postedTs: undefined })])));
  if (undated[0].postedAt === undefined) pass('eightfold.fetch() omits postedAt when the position carries no date');
  else fail(`eightfold.fetch() invented postedAt ${undated[0].postedAt}`);

  // The same req comes back under several query terms — the board is a union,
  // not a concatenation.
  const deduped = await eightfold.fetch({ ...QUALCOMM, queries: ['engineer', 'designer'] }, mkCtx(async () => pageOf([position('222')])));
  if (deduped.length === 1) pass('eightfold.fetch() dedupes a position seen under two query terms');
  else fail(`eightfold.fetch() returned ${deduped.length} jobs for one position across two terms`);

  // ── fetch(): pagination bounds ─────────────────────────────────────────────

  let calls = 0;
  await eightfold.fetch({ ...QUALCOMM, queries: ['engineer'], max_pages: 3 }, mkCtx(async () => {
    calls++;
    return pageOf(Array.from({ length: 10 }, (_, i) => position(`${calls}-${i}`)));
  }));
  if (calls === 3) pass('eightfold.fetch() stops at entry.max_pages on a full board');
  else fail(`eightfold.fetch() made ${calls} requests with max_pages: 3`);

  // A short page is the last page. Paging on burns a request against a host
  // that 429s after nine of them.
  calls = 0;
  await eightfold.fetch({ ...QUALCOMM, queries: ['engineer'], max_pages: 10 }, mkCtx(async () => {
    calls++;
    return pageOf(Array.from({ length: 4 }, (_, i) => position(`s${i}`)));
  }));
  if (calls === 1) pass('eightfold.fetch() stops on a short page instead of paging on');
  else fail(`eightfold.fetch() made ${calls} requests after a short page`);

  // verify-portals' liveness probe passes maxPages: 1 and only needs to tell a
  // live board from a broken one — it must not walk seven query terms to do it.
  calls = 0;
  await eightfold.fetch(QUALCOMM, mkCtx(async () => {
    calls++;
    return pageOf(Array.from({ length: 10 }, (_, i) => position(`p${calls}-${i}`)));
  }, { maxPages: 1 }));
  if (calls === 1) pass('eightfold.fetch() honors ctx.maxPages across pages AND query terms');
  else fail(`eightfold.fetch() made ${calls} requests under ctx.maxPages: 1`);

  // ── fetch(): failure modes ─────────────────────────────────────────────────

  // A 429 that recovers must not lose the page it was retrying.
  let attempts = 0;
  const recovered = await eightfold.fetch({ ...QUALCOMM, queries: ['engineer'] }, mkCtx(async () => {
    if (++attempts <= 2) throw new Error('HTTP 429 Too Many Requests');
    return pageOf([position('333')]);
  }));
  if (recovered.length === 1 && attempts === 3) pass('eightfold.fetch() backs off through a 429 and keeps the page');
  else fail(`eightfold.fetch() after transient 429: ${recovered.length} jobs in ${attempts} attempts`);

  // Exhausted retries must throw. Returning what it had would report a
  // truncated board as a complete one — indistinguishable from a real board
  // that shrank, which is how a dead scan looks like a quiet week.
  let threw = null;
  try {
    await eightfold.fetch({ ...QUALCOMM, queries: ['engineer'] }, mkCtx(async () => { throw new Error('HTTP 429 Too Many Requests'); }));
  } catch (e) {
    threw = e;
  }
  if (threw && /rate-limited/.test(threw.message)) pass('eightfold.fetch() throws when retries are exhausted rather than truncating');
  else fail(`eightfold.fetch() should throw on exhausted retries, got ${threw ? threw.message : 'no error'}`);

  // A non-429 error is not a rate limit and must not be retried into silence.
  threw = null;
  try {
    await eightfold.fetch({ ...QUALCOMM, queries: ['engineer'] }, mkCtx(async () => { throw new Error('HTTP 403 Forbidden'); }));
  } catch (e) {
    threw = e;
  }
  if (threw && /403/.test(threw.message)) pass('eightfold.fetch() propagates a non-429 error unretried');
  else fail(`eightfold.fetch() swallowed a 403: ${threw ? threw.message : 'no error'}`);

  threw = null;
  try {
    await eightfold.fetch({ name: 'Nope', careers_url: 'https://example.com/jobs' }, mkCtx(async () => pageOf([])));
  } catch (e) {
    threw = e;
  }
  if (threw && /cannot derive PCSX config/.test(threw.message)) pass('eightfold.fetch() refuses an entry it cannot resolve');
  else fail(`eightfold.fetch() on an unresolvable entry: ${threw ? threw.message : 'no error'}`);
} catch (e) {
  fail(`eightfold provider tests crashed: ${e.message}`);
}
