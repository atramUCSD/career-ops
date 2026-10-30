// Himalayas postings, offline. Every himalayas.app page answers a Cloudflare
// challenge, so the JD and a live verdict come from the public search API,
// matched on the guid because the API has no lookup by id.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fetchJdViaKnownApi, normalizeHimalayasJob } from '../browser-extract.mjs';
import { checkLivenessViaApi, findHimalayasJob, resolveAtsApi } from '../liveness-api.mjs';

const PAGE = 'https://himalayas.app/companies/fixtureco/jobs/senior-servicenow-developer-350?utm_source=api';
const GUID = 'https://himalayas.app/companies/fixtureco/jobs/senior-servicenow-developer-350';
const job = (guid, marker) => ({ guid, title: 'Senior ServiceNow Developer', description: `<p>${marker} Build ITSM workflows.</p>` });
const answer = { jobs: [
  job('https://himalayas.app/companies/fixtureco/jobs/senior-servicenow-developer-351', 'SIBLING_MARKER'),
  job(GUID, 'POSTING_MARKER'),
] };

async function mocked(fetcher, run) {
  const previous = globalThis.fetch;
  globalThis.fetch = fetcher;
  try { return await run(); } finally { globalThis.fetch = previous; }
}

test('a posting URL resolves to a company search on the slug words', () => {
  const resolved = resolveAtsApi(PAGE);
  assert.equal(resolved?.ats, 'himalayas');
  const api = new URL(resolved.apiUrl);
  assert.equal(api.searchParams.get('company'), 'fixtureco');
  assert.equal(api.searchParams.get('q'), 'senior servicenow developer', 'the disambiguating number is dropped');
  assert.equal(resolveAtsApi('https://himalayas.app/companies/fixtureco'), null, 'a company page is not a posting');
});

test('the match is on the guid, not the title, and ignores the query string', () => {
  const parts = resolveAtsApi(PAGE).parts;
  assert.equal(findHimalayasJob(answer, parts)?.guid, GUID);
  assert.equal(findHimalayasJob({ jobs: [answer.jobs[0]] }, parts), null, 'a same-titled sibling is not this posting');
  const jd = normalizeHimalayasJob(answer, parts, PAGE);
  assert.match(jd.text, /POSTING_MARKER/);
  assert.doesNotMatch(jd.text, /SIBLING_MARKER/);
});

test('fetchJdViaKnownApi reads the JD from the search answer', async () => {
  const jd = await mocked(async () => new Response(JSON.stringify(answer)), () => fetchJdViaKnownApi(PAGE));
  assert.equal(jd?.ats, 'himalayas');
  assert.match(jd.text, /POSTING_MARKER/);
});

test('liveness: a listed posting is live, an unlisted one is no verdict', async () => {
  const listed = await mocked(async () => new Response(JSON.stringify(answer)), () => checkLivenessViaApi(PAGE));
  assert.equal(listed?.result, 'active');
  const missing = await mocked(async () => new Response(JSON.stringify({ jobs: [] })), () => checkLivenessViaApi(PAGE));
  assert.equal(missing, null);
});
