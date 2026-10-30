// enrich-jd's browser read, against a page double: Chromium is not installed
// in the test job. A page that keeps polling never reaches networkidle, so a
// goto that waited for it threw and the loaded description was discarded.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readPage } from '../enrich-jd.mjs';

const DESCRIPTION = `<main>READ_MARKER ${'Design the claims workflow. '.repeat(30)}</main>`;

function neverIdleContext() {
  const timeout = () => Promise.reject(Object.assign(new Error('Timeout exceeded'), { name: 'TimeoutError' }));
  return {
    newPage: async () => ({
      goto: async (_url, { waitUntil }) => (waitUntil === 'networkidle' ? timeout() : { status: () => 200 }),
      waitForLoadState: async (state) => (state === 'networkidle' ? timeout() : undefined),
      frames: () => [{ content: async () => `<html><body>${DESCRIPTION}</body></html>` }],
      evaluate: async () => '',
      title: async () => 'Lead UX Designer in Atlanta, Georgia | Careers',
      close: async () => {},
    }),
  };
}

test('a page that never goes network-idle is still read once loaded', async () => {
  const { text, location } = await readPage(neverIdleContext(), 'https://careers-x.icims.com/jobs/1/job');
  assert.match(text, /READ_MARKER/);
  assert.equal(location, 'Atlanta, Georgia');
});
