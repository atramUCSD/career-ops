// tests/usajobs-liveness.test.mjs — per-announcement liveness for USAJOBS
// postings via the public /job/{controlNumber} page. Offline: fetch is stubbed.
//
// USAJOBS keeps CLOSED announcements serving 200 indefinitely with a
// server-rendered closed marker, so the strong signal is in the body; a 404
// means removed/never-existed but is BARE (no posting-level body marker), so
// the gone path must confirm the /job route against a sentinel before
// trusting it — a broken route must never mass-expire every federal posting.
//
// ORDER MATTERS: the module caches a SUCCESSFUL sentinel probe per process
// (failures are not cached), so the dead-route case runs before any case that
// proves the route healthy.
import { pass, fail } from './helpers.mjs';
import { resolveAtsApi, checkLivenessViaApi } from '../liveness-api.mjs';
import { BROWSER_LIKE_USER_AGENT } from '../user-agent.mjs';

console.log('\nusajobs-liveness — per-announcement /job/{controlNumber} rung');

const eq = (actual, expected, label) =>
  actual === expected ? pass(label) : fail(`${label} — got ${JSON.stringify(actual)}, expected ${JSON.stringify(expected)}`);

const POSTING = 'https://www.usajobs.gov/job/842506100';
const SENTINEL = 'https://www.usajobs.gov/job/309472900';

// ── URL → API resolution (pure, offline) ────────────────────────────

eq(resolveAtsApi(POSTING)?.apiUrl, POSTING, 'a /job/{cn} URL is checked against the page itself (no API key exists for a per-job lookup)');
eq(resolveAtsApi('https://usajobs.gov/job/842506100/')?.apiUrl, POSTING, 'the bare-host + trailing-slash variant normalizes to www');
// Legacy PositionURI form 301s to /job/{cn}; redirects are refused module-wide,
// so the rung normalizes instead of following.
eq(resolveAtsApi('https://www.usajobs.gov/GetJob/ViewDetails/842506100')?.apiUrl, POSTING, 'the legacy GetJob/ViewDetails form normalizes to /job/{cn}');
eq(resolveAtsApi('https://www.usajobs.gov/search/results/?k=engineer'), null, 'a search URL is not claimed');
eq(resolveAtsApi('https://www.usajobs.gov/job/not-a-number'), null, 'a non-numeric control number is not claimed');
// The Akamai edge 403s non-browser UAs before the origin is reached.
eq(resolveAtsApi(POSTING)?.headers?.['user-agent'], BROWSER_LIKE_USER_AGENT, 'the browser-like UA rides on the request (the edge 403s the plain one)');

// ── Verdicts (stubbed fetch, no network) ────────────────────────────

const realFetch = globalThis.fetch;
let lastPostingOpts = null;
// Route by URL: the posting and the route-health sentinel are separate requests.
const stub = (postingImpl, sentinelImpl) => {
  globalThis.fetch = async (url, opts) => {
    if (String(url) === SENTINEL) {
      if (!sentinelImpl) throw new Error('unexpected sentinel fetch');
      return sentinelImpl(url, opts);
    }
    lastPostingOpts = opts;
    return postingImpl(url, opts);
  };
};
const res = (status, body = '') => async () => ({
  status,
  url: '',
  json: async () => JSON.parse(body),
  text: async () => body,
});

const LIVE_HTML = '<html><h1>Software Engineer</h1><button>Apply</button></html>';
const CLOSED_HTML = '<html><div>This job announcement has closed</div></html>';

try {
  // Dead route FIRST (sentinel failures are not cached; successes are): the
  // posting 404s and so does the sentinel — the route is broken, and the 404
  // proves nothing about THIS announcement.
  stub(res(404), res(404));
  eq(await checkLivenessViaApi(POSTING), null, 'a 404 with the sentinel also 404ing -> null (dead route, never mass-expires)');

  // Sentinel unreachable (edge block, network) — still inconclusive.
  stub(res(404), async () => { throw new Error('edge reset'); });
  eq(await checkLivenessViaApi(POSTING), null, 'a 404 with the sentinel unreachable -> null');

  // The strong signal: closed announcements serve 200 with the marker forever.
  stub(res(200, CLOSED_HTML));
  const closed = await checkLivenessViaApi(POSTING);
  eq(closed?.result, 'expired', '200 with "This job announcement has closed" -> expired');
  eq(closed?.code, 'usajobs_page_closed', 'the closed verdict carries its own code');

  // The embedded-JSON variant of the same marker.
  stub(res(200, '<html><script>{"ClockDisplay": "JobClosed"}</script></html>'));
  eq((await checkLivenessViaApi(POSTING))?.result, 'expired', '200 with "ClockDisplay": "JobClosed" -> expired');

  stub(res(200, LIVE_HTML));
  eq((await checkLivenessViaApi(POSTING))?.result, 'active', '200 without a closed marker -> active');
  // Pinned at the wire: dropping the UA plumbing would 403 every request and
  // silently degrade the whole rung to the browser fallback.
  eq(lastPostingOpts?.headers?.['user-agent'], BROWSER_LIKE_USER_AGENT, 'the browser-like UA reaches the actual request');
  eq(lastPostingOpts?.headers?.accept, 'text/html', 'the request asks for HTML (it parses HTML)');

  // Posting-level gone: the 404 is bare, so the sentinel (a permanently-200
  // closed announcement) confirms the route first.
  stub(res(404), res(200, CLOSED_HTML));
  const gone = await checkLivenessViaApi(POSTING);
  eq(gone?.result, 'expired', 'a 404 with the sentinel answering 200 -> expired (announcement removed)');
  eq(gone?.code, 'usajobs_page_gone', 'the gone verdict carries its own code');

  // A healthy sentinel is cached for the run — the next 404 needs no re-probe.
  stub(res(404), null);
  eq((await checkLivenessViaApi(POSTING))?.result, 'expired', 'a later 404 reuses the cached route-health probe');

  // Akamai edge 403 (bot management, HTML 'Access Denied') is the edge
  // talking, not the posting — inconclusive, never gone.
  stub(res(403, '<html>Access Denied</html>'));
  eq(await checkLivenessViaApi(POSTING), null, 'an Akamai 403 -> null (edge block, not a verdict)');

  // 5xx / network failure must NEVER read as expired.
  stub(res(500));
  eq(await checkLivenessViaApi(POSTING), null, '5xx -> null (inconclusive, never expired)');
  stub(async () => { throw new Error('network down'); });
  eq(await checkLivenessViaApi(POSTING), null, 'network error -> null (inconclusive, never expired)');
} finally {
  globalThis.fetch = realFetch;
}
