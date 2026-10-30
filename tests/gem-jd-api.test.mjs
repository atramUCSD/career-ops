// Gem postings, offline. The page is a client-rendered shell, so the JD and the
// liveness verdict both come from the GraphQL batch endpoint the page calls.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fetchJdViaKnownApi, normalizeGemJob } from '../browser-extract.mjs';
import { classifyGemPosting, resolveAtsApi } from '../liveness-api.mjs';

const URL_ = 'https://jobs.gem.com/fixtureco/am9icG9zdDpGSVhUVVJF';
const EXT = 'am9icG9zdDpGSVhUVVJF';
const answer = (posting) => [{ data: { oatsExternalJobPosting: posting } }];
const posting = {
  extId: EXT,
  title: 'Senior Solutions Architect',
  descriptionHtml: '<p>DESCRIPTION_MARKER Design integrations for enterprise customers.</p>',
  jobPostSectionHtml: { introHtml: '<p>INTRO_MARKER</p>', outroHtml: null },
  compensationHtml: '<p>$180,000 - $220,000</p>',
};

async function mocked(fetcher, run) {
  const previous = globalThis.fetch;
  globalThis.fetch = fetcher;
  try { return await run(); } finally { globalThis.fetch = previous; }
}

test('a Gem posting URL resolves to the GraphQL batch POST', () => {
  const resolved = resolveAtsApi(URL_);
  assert.equal(resolved?.ats, 'gem');
  assert.equal(resolved.method, 'POST');
  const [query] = JSON.parse(resolved.body);
  assert.deepEqual(query.variables, { boardId: 'fixtureco', extId: EXT });
  assert.equal(resolveAtsApi('https://jobs.gem.com/fixtureco'), null, 'a board page is not a posting');
});

test('the JD is intro, body and compensation, for this posting only', () => {
  const jd = normalizeGemJob(answer(posting), EXT, URL_);
  assert.equal(jd.title, 'Senior Solutions Architect');
  assert.match(jd.text, /INTRO_MARKER[\s\S]*DESCRIPTION_MARKER[\s\S]*Compensation: \$180,000/);
  assert.equal(normalizeGemJob(answer({ ...posting, extId: 'other' }), EXT, URL_), null);
  assert.equal(normalizeGemJob(answer(null), EXT, URL_), null);
});

test('fetchJdViaKnownApi posts the query and reads the answer', async () => {
  const calls = [];
  const jd = await mocked(async (url, init) => {
    calls.push({ url: String(url), init });
    return new Response(JSON.stringify(answer(posting)));
  }, () => fetchJdViaKnownApi(URL_));
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, 'https://jobs.gem.com/api/public/graphql/batch');
  assert.equal(calls[0].init.method, 'POST');
  assert.equal(calls[0].init.headers.batch, 'true');
  assert.equal(jd?.ats, 'gem');
  assert.match(jd.text, /DESCRIPTION_MARKER/);
});

test('liveness: a null posting is removed, errors are no verdict', () => {
  assert.equal(classifyGemPosting(answer(posting), EXT)?.result, 'active');
  assert.equal(classifyGemPosting(answer(null), EXT)?.result, 'expired');
  assert.equal(classifyGemPosting([{ errors: [{ message: 'boom' }], data: null }], EXT), null);
  assert.equal(classifyGemPosting([{ data: {} }], EXT), null);
  assert.equal(classifyGemPosting({}, EXT), null);
});
