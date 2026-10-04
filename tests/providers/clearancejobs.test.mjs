// tests/providers/clearancejobs.test.mjs — offline unit tests for
// providers/clearancejobs.mjs. Fixtures follow the live search response shape
// probed 2026-10-04: { data: [...], meta: { pagination: { total_pages, ... } } }.
// No network: the provider only talks through ctx.fetchJson, stubbed here.
import { pass, fail, ROOT } from '../helpers.mjs';
import { join } from 'path';
import { pathToFileURL } from 'url';

console.log('\nProvider — clearancejobs');

const item = (id, title, extra = {}) => ({
  id,
  created_at: '2026-08-24T10:27:30-05:00',
  job_name: title,
  job_url: `https://www.clearancejobs.com/jobs/${id}/slug`,
  company_name: 'Independent Software',
  locations: [{ location: 'San Diego, CA', type: 'On-Site/Office' }, { location: 'Remote', type: 'Remote' }],
  clearance: 'TS/SCI',
  polygraph: 'Polygraph',
  preview_text: 'Who are we?',
  ...extra,
});
const page = (rows, totalPages = 1) => ({ data: rows, meta: { pagination: { total_pages: totalPages, per_page: 20 } } });

try {
  const mod = await import(pathToFileURL(join(ROOT, 'providers/clearancejobs.mjs')).href);
  const cj = mod.default;
  const { parseClearanceJobsConfig, normalizeItem } = mod;

  if (cj.id === 'clearancejobs') pass('clearancejobs.id is "clearancejobs"');
  else fail(`clearancejobs.id is ${JSON.stringify(cj.id)}`);

  const def = parseClearanceJobsConfig({});
  const snapped = parseClearanceJobsConfig({ clearancejobs: { received: 5, max_pages: 9999, queries: [{ loc: '5' }, { keywords: ' ux ', loc: [5, 'x'] }] } });
  if (def.received === 7 && def.maxPages === 10
      && snapped.received === 7 && snapped.maxPages === 100
      && snapped.queries.length === 1 && snapped.queries[0].keywords === 'ux' && snapped.queries[0].loc.join() === '5') {
    pass('parseClearanceJobsConfig defaults, snaps received to 1/3/7/31, caps pages, drops scalar loc');
  } else {
    fail(`parseClearanceJobsConfig = ${JSON.stringify({ def, snapped })}`);
  }

  const norm = normalizeItem(item(9113995, ' Software Engineer '));
  if (norm && norm.title === 'Software Engineer'
      && norm.url === 'https://www.clearancejobs.com/jobs/9113995/slug'
      && norm.location === 'San Diego, CA; Remote'
      && norm.description === 'TS/SCI · Polygraph — Who are we?'
      && norm.postedAt === Date.parse('2026-08-24T10:27:30-05:00')) {
    pass('normalizeItem maps title/url/locations/clearance/date');
  } else {
    fail(`normalizeItem = ${JSON.stringify(norm)}`);
  }
  if (normalizeItem(item(1, 'T', { job_url: 'https://evil.example.com/jobs/1' })) === null
      && normalizeItem(item(1, 'T', { job_url: 'http://www.clearancejobs.com/jobs/1' })) === null
      && normalizeItem(item(1, '')) === null && normalizeItem(null) === null) {
    pass('normalizeItem rejects foreign/non-https URLs and missing titles');
  } else {
    fail('normalizeItem should reject foreign/non-https URLs and missing titles');
  }

  // fetch — POST body, pagination until a short page, dedup across queries
  const sent = [];
  const fetched = await cj.fetch(
    { name: 'C', clearancejobs: { received: 3, queries: [{ keywords: 'software', loc: [5] }, { keywords: 'ux', remote: true }] } },
    { fetchJson: async (url, opts) => {
        const body = JSON.parse(opts.body);
        sent.push({ url, method: opts.method, body });
        if (body.keywords === 'software') {
          return body.page === 1
            ? page(Array.from({ length: 20 }, (_, i) => item(i + 1, `Job ${i + 1}`)), 5)
            : page([item(100, 'Last')], 5);
        }
        return page([item(1, 'Job 1')]); // duplicate of software p1
      } },
  );
  const sw = sent.filter(s => s.body.keywords === 'software');
  if (fetched.length === 21 && sw.length === 2 && sent.length === 3) {
    pass('clearancejobs.fetch() pages until a short page and dedups by URL');
  } else {
    fail(`clearancejobs.fetch() returned ${fetched.length} jobs over ${sent.length} requests`);
  }
  const first = sent[0];
  const ux = sent.find(s => s.body.keywords === 'ux');
  if (first.url === 'https://api.clearancejobs.com/api/v1/jobs/search' && first.method === 'POST'
      && first.body.received === '3' && Array.isArray(first.body.loc) && first.body.loc[0] === 5 && first.body.page === 1
      && ux && ux.body.remote === '1' && !('loc' in ux.body)) {
    pass('clearancejobs.fetch() sends POST JSON with received/loc[]/remote/page');
  } else {
    fail(`clearancejobs.fetch() sent ${JSON.stringify(sent.slice(0, 1))}`);
  }

  // max_pages bounds the walk even when the source reports more pages
  let calls = 0;
  await cj.fetch(
    { name: 'C', clearancejobs: { max_pages: 2, queries: [{ keywords: 'x' }] } },
    { fetchJson: async () => { calls++; return page(Array.from({ length: 20 }, (_, i) => item(calls * 100 + i, 'J')), 9999); } },
  );
  if (calls === 2) pass('clearancejobs.fetch() stops at max_pages regardless of reported total_pages');
  else fail(`clearancejobs.fetch() made ${calls} calls with max_pages 2`);

  const empty = await cj.fetch({ name: 'C', clearancejobs: { keywords: ['none'] } }, { fetchJson: async () => page([], 0) });
  if (Array.isArray(empty) && empty.length === 0) pass('clearancejobs.fetch() returns [] for a zero-hit answer');
  else fail(`clearancejobs.fetch() empty = ${JSON.stringify(empty)}`);

  let malformed = '';
  try {
    await cj.fetch({ name: 'C', clearancejobs: { keywords: ['x'] } }, { fetchJson: async () => ({ message: 'The loc must be an array.' }) });
  } catch (err) { malformed = err.message; }
  if (malformed.includes('unexpected response') && malformed.includes('message')) pass('clearancejobs.fetch() throws when every query answers malformed');
  else fail(`clearancejobs.fetch() malformed error = ${JSON.stringify(malformed) || 'did not throw'}`);

  let partialThrew = false;
  let partial;
  try {
    partial = await cj.fetch(
      { name: 'C', clearancejobs: { keywords: ['OK', 'BAD'] } },
      { fetchJson: async (_url, opts) => {
          if (JSON.parse(opts.body).keywords === 'BAD') throw new Error('HTTP 503');
          return page([item(7, 'Analyst')]);
        } },
    );
  } catch { partialThrew = true; }
  if (!partialThrew && partial.length === 1) pass('clearancejobs.fetch() keeps partial results when one query fails');
  else fail(`clearancejobs.fetch() partial threw=${partialThrew}, result=${JSON.stringify(partial)}`);
} catch (e) {
  fail(`clearancejobs provider tests crashed: ${e.message}`);
}
