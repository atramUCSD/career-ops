// enrich-jd's fetch pass, offline. A Greenhouse board embedded on the employer's
// own domain (?gh_jid only) resolves to the embed endpoint, which answers with a
// redirect, never JSON; enrich-jd used to call res.json() on it and record the
// row as unreadable.
import { test } from 'node:test';
import assert from 'node:assert/strict';

process.env.CAREER_OPS_PORTALS = 'nonexistent-portals.yml';
const { fetchJd } = await import('../enrich-jd.mjs');

async function mocked(fetcher, run) {
  const previous = globalThis.fetch;
  globalThis.fetch = fetcher;
  try { return await run(); } finally { globalThis.fetch = previous; }
}

test('an embedded Greenhouse posting is read through the board API', async () => {
  const body = `<p>EMBED_MARKER ${'Build the payments platform. '.repeat(20)}</p>`;
  const seen = [];
  const text = await mocked(async (url) => {
    seen.push(String(url));
    if (String(url).startsWith('https://boards.greenhouse.io/embed/job_app?token=8207939')) {
      return new Response(null, { status: 302, headers: { location: 'https://boards.greenhouse.io/embed/job_app?for=fixtureco&token=8207939' } });
    }
    if (String(url).startsWith('https://boards-api.greenhouse.io/v1/boards/fixtureco/jobs/8207939')) {
      return new Response(JSON.stringify({ title: 'Engineer', content: body }));
    }
    return new Response('blocked', { status: 403 });
  }, () => fetchJd('https://jobs.fixtureco.example/jobs?gh_jid=8207939'));
  assert.match(text, /EMBED_MARKER/);
  assert.ok(seen.some(u => u.startsWith('https://boards-api.greenhouse.io/')), 'the board API was asked');
});
