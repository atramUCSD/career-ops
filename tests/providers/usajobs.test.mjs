// tests/providers/usajobs.test.mjs — offline unit tests for providers/usajobs.mjs.
// Fixtures follow the documented Position Search response shape
// (developer.usajobs.gov/api-reference/get-api-search):
// SearchResult.SearchResultItems[].MatchedObjectDescriptor, with
// MatchedObjectId as the control number. The provider is auth-gated
// (Authorization-Key + registered-email User-Agent from the environment), so
// every test pins USAJOBS_API_KEY/USAJOBS_EMAIL and restores them in a finally.
// No network: the provider only ever talks through ctx.fetchJson, which is
// stubbed here (globalThis.fetch is never touched by the provider).
import { pass, fail, ROOT } from '../helpers.mjs';
import { join } from 'path';
import { pathToFileURL } from 'url';

console.log('\nProvider — usajobs');

/** One SearchResultItems entry in the documented shape. */
const item = (id, title, extra = {}) => ({
  MatchedObjectId: id,
  MatchedObjectDescriptor: {
    PositionID: 'SW62210-05-1716110PB411413H',
    PositionTitle: title,
    PositionURI: `https://www.usajobs.gov/GetJob/ViewDetails/${id}`,
    PositionLocationDisplay: 'San Diego, California',
    PositionLocation: [{ LocationName: 'San Diego, California', CountryCode: 'United States' }],
    OrganizationName: 'Space and Naval Warfare Systems Command',
    DepartmentName: 'Department of the Navy',
    QualificationSummary: 'One year of specialized experience.',
    PublicationStartDate: '2016-06-05T00:00:00Z',
    ApplicationCloseDate: '2016-12-01T00:00:00Z',
    ...extra,
  },
});

/** A documented search response wrapping the given items. */
const page = (...items) => ({
  LanguageCode: 'EN',
  SearchParameters: {},
  SearchResult: { SearchResultCount: items.length, SearchResultCountAll: items.length, SearchResultItems: items },
});

const savedKey = process.env.USAJOBS_API_KEY;
const savedEmail = process.env.USAJOBS_EMAIL;
try {
  const mod = await import(pathToFileURL(join(ROOT, 'providers/usajobs.mjs')).href);
  const usajobs = mod.default;
  const { parseUsajobsConfig, normalizeItem } = mod;

  if (usajobs.id === 'usajobs') pass('usajobs.id is "usajobs"');
  else fail(`usajobs.id is ${JSON.stringify(usajobs.id)}`);

  // parseUsajobsConfig — defaults when the block is absent
  const def = parseUsajobsConfig({});
  if (def.keywords.length === 0 && def.locationName === '' && def.radius === 0 && def.days === 30 && def.size === 500) {
    pass('parseUsajobsConfig applies defaults (days 30, size 500)');
  } else {
    fail(`parseUsajobsConfig defaults = ${JSON.stringify(def)}`);
  }

  // parseUsajobsConfig — sanitizes keywords, clamps to the documented API caps
  const cfg = parseUsajobsConfig({
    usajobs: { keywords: ['  software engineer  ', '', 7], locationName: ' Washington, DC ', radius: -5, days: 999, size: 9999 },
  });
  if (cfg.keywords.length === 1 && cfg.keywords[0] === 'software engineer'
      && cfg.locationName === 'Washington, DC' && cfg.radius === 0 && cfg.days === 60 && cfg.size === 500) {
    pass('parseUsajobsConfig trims keywords and clamps days≤60, size≤500 (API caps)');
  } else {
    fail(`parseUsajobsConfig sanitized = ${JSON.stringify(cfg)}`);
  }

  // normalizeItem — happy path: control-number URL, agency, location, date
  const norm = normalizeItem(item('21947200', '  IT SPECIALIST  '));
  if (norm && norm.title === 'IT SPECIALIST'
      && norm.url === 'https://www.usajobs.gov/job/21947200'
      && norm.company === 'Space and Naval Warfare Systems Command'
      && norm.location === 'San Diego, California'
      && norm.description === 'One year of specialized experience.'
      && norm.postedAt === Date.parse('2016-06-05T00:00:00Z')) {
    pass('normalizeItem builds the /job/{controlNumber} URL and maps descriptor fields');
  } else {
    fail(`normalizeItem = ${JSON.stringify(norm)}`);
  }

  // normalizeItem — non-numeric MatchedObjectId falls back to PositionURI on a
  // usajobs.gov host only; a foreign host in a poisoned payload is rejected.
  const fb = normalizeItem({ MatchedObjectId: 'x', MatchedObjectDescriptor: { PositionTitle: 'T', PositionURI: 'https://www.usajobs.gov/GetJob/ViewDetails/5' } });
  const evil = normalizeItem({ MatchedObjectId: 'x', MatchedObjectDescriptor: { PositionTitle: 'T', PositionURI: 'https://evil.example.com/job/5' } });
  if (fb && fb.url === 'https://www.usajobs.gov/GetJob/ViewDetails/5' && evil === null) {
    pass('normalizeItem PositionURI fallback accepts usajobs.gov only');
  } else {
    fail(`normalizeItem fallback = ${JSON.stringify(fb)}, foreign host = ${JSON.stringify(evil)}`);
  }
  if (normalizeItem(null) === null && normalizeItem({}) === null
      && normalizeItem({ MatchedObjectId: '1', MatchedObjectDescriptor: { PositionTitle: '' } }) === null) {
    pass('normalizeItem returns null for missing descriptor/title/url');
  } else {
    fail('normalizeItem should return null for missing descriptor/title/url');
  }

  // fetch() — no key configured → one warning line, empty result, zero requests
  delete process.env.USAJOBS_API_KEY;
  delete process.env.USAJOBS_EMAIL;
  let requests = 0;
  let warnings = 0;
  const realErr = console.error;
  console.error = (msg) => { if (String(msg).includes('usajobs')) warnings++; };
  let noKey, noKey2;
  try {
    const ctx = { fetchJson: async () => { requests++; return page(); } };
    noKey = await usajobs.fetch({ name: 'U', usajobs: { keywords: ['x'] } }, ctx);
    noKey2 = await usajobs.fetch({ name: 'U', usajobs: { keywords: ['x'] } }, ctx);
  } finally {
    console.error = realErr;
  }
  if (Array.isArray(noKey) && noKey.length === 0 && noKey2.length === 0 && requests === 0) {
    pass('usajobs.fetch() returns [] without touching the network when the key is absent');
  } else {
    fail(`usajobs.fetch() no-key = ${JSON.stringify(noKey)}, requests = ${requests}`);
  }
  if (warnings === 1) pass('usajobs.fetch() warns exactly once across repeated keyless calls');
  else fail(`usajobs.fetch() keyless warnings = ${warnings}`);

  // From here on the key is configured.
  process.env.USAJOBS_API_KEY = 'test-key';
  process.env.USAJOBS_EMAIL = 'probe@example.com';

  // fetch() — happy path: auth headers, query params, dedup across keywords
  let sentHeaders = null;
  let sentUrl = null;
  const byKeyword = (map) => ({
    fetchJson: async (url, opts) => {
      sentHeaders = opts?.headers;
      sentUrl = url;
      const kw = new URL(url).searchParams.get('Keyword');
      return page(...(map[kw] || []));
    },
  });
  const fetched = await usajobs.fetch(
    { name: 'U', usajobs: { keywords: ['software', 'engineer'], locationName: 'Washington, DC', radius: 50 } },
    byKeyword({
      software: [item('100', 'Software Engineer')],
      engineer: [item('100', 'Software Engineer'), item('200', 'IT Specialist')], // 100 duplicates
    }),
  );
  if (fetched.length === 2 && fetched[0].url === 'https://www.usajobs.gov/job/100' && fetched[1].url === 'https://www.usajobs.gov/job/200') {
    pass('usajobs.fetch() dedups by URL across keywords');
  } else {
    fail(`usajobs.fetch() returned ${JSON.stringify(fetched)}`);
  }
  if (sentHeaders && sentHeaders['Authorization-Key'] === 'test-key' && sentHeaders['user-agent'] === 'probe@example.com') {
    pass('usajobs.fetch() sends Authorization-Key and the registered email as user-agent');
  } else {
    fail(`usajobs.fetch() headers = ${JSON.stringify(sentHeaders)}`);
  }
  const sentParams = new URL(sentUrl).searchParams;
  if (sentUrl.startsWith('https://data.usajobs.gov/api/search?')
      && sentParams.get('LocationName') === 'Washington, DC' && sentParams.get('Radius') === '50'
      && sentParams.get('ResultsPerPage') === '500' && sentParams.get('DatePosted') === '30') {
    pass('usajobs.fetch() sends LocationName/Radius/ResultsPerPage/DatePosted');
  } else {
    fail(`usajobs.fetch() url = ${sentUrl}`);
  }

  // fetch() — a legitimately empty answer is an empty array, not an error
  const empty = await usajobs.fetch(
    { name: 'U', usajobs: { keywords: ['nothing'] } },
    { fetchJson: async () => page() },
  );
  if (Array.isArray(empty) && empty.length === 0) pass('usajobs.fetch() returns [] for a zero-hit answer');
  else fail(`usajobs.fetch() empty = ${JSON.stringify(empty)}`);

  // fetch() — a 200 with a non-documented body must not masquerade as an
  // empty board: with every keyword malformed, fetch throws.
  let malformedErr = '';
  try {
    await usajobs.fetch(
      { name: 'U', usajobs: { keywords: ['x'] } },
      { fetchJson: async () => ({ error: 'nope' }) },
    );
  } catch (err) { malformedErr = err.message; }
  if (malformedErr.includes('unexpected response') && malformedErr.includes('SearchResult.SearchResultItems')) {
    pass('usajobs.fetch() throws when every keyword answers with a malformed payload');
  } else {
    fail(`usajobs.fetch() malformed error = ${JSON.stringify(malformedErr) || 'did not throw'}`);
  }

  // fetch() — total outage (HTTP error on every keyword) throws; the live 401
  // shape is application/problem+json {"title":"Unauthorized","status":401}
  // which _http.mjs surfaces as an HTTP 401 error.
  let outageErr = '';
  try {
    await usajobs.fetch(
      { name: 'U', usajobs: { keywords: ['a', 'b'] } },
      { fetchJson: async () => { throw new Error('HTTP 401 Unauthorized'); } },
    );
  } catch (err) { outageErr = err.message; }
  if (outageErr.includes('all 2 keyword request(s) failed') && outageErr.includes('HTTP 401')) {
    pass('usajobs.fetch() throws on total outage (no silent empty)');
  } else {
    fail(`usajobs.fetch() outage error = ${JSON.stringify(outageErr) || 'did not throw'}`);
  }

  // fetch() — one keyword succeeds (empty) while another fails → NOT an
  // outage; partial success must not throw and must keep the good results.
  let partialThrew = false;
  let partial;
  try {
    partial = await usajobs.fetch(
      { name: 'U', usajobs: { keywords: ['OK', 'BAD'] } },
      { fetchJson: async (url) => {
          if (new URL(url).searchParams.get('Keyword') === 'BAD') throw new Error('HTTP 503');
          return page(item('300', 'Analyst'));
        } },
    );
  } catch { partialThrew = true; }
  if (!partialThrew && Array.isArray(partial) && partial.length === 1 && partial[0].url === 'https://www.usajobs.gov/job/300') {
    pass('usajobs.fetch() keeps partial results when one keyword fails');
  } else {
    fail(`usajobs.fetch() partial threw=${partialThrew}, result=${JSON.stringify(partial)}`);
  }

  // queries[] — structured params, one request each, and they win over keywords
  const queryParams = [];
  await usajobs.fetch(
    { name: 'Q', usajobs: { keywords: ['ignored'], queries: [{ series: '2210', keyword: 'web' }, { title: 'UX' }, { bogus: 1 }] } },
    { fetchJson: async (url) => { queryParams.push(Object.fromEntries(new URL(url).searchParams)); return page(); } },
  );
  if (queryParams.length === 2
      && queryParams[0].JobCategoryCode === '2210' && queryParams[0].Keyword === 'web' && !queryParams[0].PositionTitle
      && queryParams[1].PositionTitle === 'UX' && !queryParams[1].Keyword && !queryParams[1].JobCategoryCode) {
    pass('usajobs.fetch() maps queries[] to JobCategoryCode/Keyword/PositionTitle and overrides keywords');
  } else {
    fail(`usajobs.fetch() queries sent ${JSON.stringify(queryParams)}`);
  }
} catch (e) {
  fail(`usajobs provider tests crashed: ${e.message}`);
} finally {
  if (savedKey === undefined) delete process.env.USAJOBS_API_KEY;
  else process.env.USAJOBS_API_KEY = savedKey;
  if (savedEmail === undefined) delete process.env.USAJOBS_EMAIL;
  else process.env.USAJOBS_EMAIL = savedEmail;
}
