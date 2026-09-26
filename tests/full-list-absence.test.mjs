// tests/full-list-absence.test.mjs — the full-list-absence liveness rule.
//
// Seven providers (Ashby, Pinpoint, Breezy, Rippling, Jobvite, Teamtailor,
// Personio) return the tenant's ENTIRE board in one successful response, so
// absence from that list is proof of removal exactly as a per-job 404 is.
// Assertions run in risk order: the errored-fetch branch first — a failed
// fetch must NEVER read as expired, because a false "expired" permanently
// filters a real job out of future scans — then absence-from-success →
// expired, then presence → active. Pure-function tests, no network.
import { pass, fail } from './helpers.mjs';
import { classifyFullListAbsence } from '../liveness-core.mjs';

console.log('\nfull-list-absence — absence from a successful full board fetch');

// Fixture board: two live postings on one Pinpoint tenant.
const board = [
  { title: 'Engineer', url: 'https://acme.pinpointhq.com/en/postings/12345' },
  { title: 'Designer', url: 'https://acme.pinpointhq.com/en/postings/67890' },
];

// ── errored fetch — the load-bearing branch ──────────────────────────────────

// A populated (stale) jobs array arrives WITH the failure and the target is
// absent from it, so only the fetchSucceeded branch — not the array-shape
// guard — can produce the required uncertain.
{
  const v = classifyFullListAbsence({
    fetchSucceeded: false,
    jobs: board,
    targetUrl: 'https://acme.pinpointhq.com/en/postings/99999',
    provider: 'pinpoint',
  });
  v.result === 'uncertain'
    ? pass('an errored fetch classifies uncertain — never expired')
    : fail(`errored fetch read as ${v.result} (${v.code}) — a failed fetch is not proof of removal`);
}

// A "successful" fetch whose payload is not a job list is not a full list either.
{
  const v = classifyFullListAbsence({
    fetchSucceeded: true,
    jobs: null,
    targetUrl: 'https://acme.pinpointhq.com/en/postings/12345',
    provider: 'pinpoint',
  });
  v.result === 'uncertain'
    ? pass('an unreadable jobs payload classifies uncertain — never expired')
    : fail(`unreadable payload read as ${v.result} (${v.code})`);
}

// An EMPTY successful list is not proof either: every provider parser launders
// an unreadable payload into [], so empty and unreadable are indistinguishable
// — classifying expired here would expire every live posting on the tenant.
{
  const v = classifyFullListAbsence({
    fetchSucceeded: true,
    jobs: [],
    targetUrl: 'https://acme.pinpointhq.com/en/postings/12345',
    provider: 'pinpoint',
  });
  v.result === 'uncertain' && v.code === 'full_list_empty'
    ? pass('an empty successful list classifies uncertain — never expired')
    : fail(`empty list read as ${v.result} (${v.code})`);
}

// ── one job removed → expired ────────────────────────────────────────────────

{
  const v = classifyFullListAbsence({
    fetchSucceeded: true,
    jobs: board,
    targetUrl: 'https://acme.pinpointhq.com/en/postings/99999',
    provider: 'pinpoint',
  });
  v.result === 'expired' && v.code === 'full_list_absent'
    ? pass('a job absent from a successful full list classifies expired')
    : fail(`removed job read as ${v.result} (${v.code})`);
  /full-list-absence/.test(v.reason)
    ? pass('the expired verdict names the rule in its evidence')
    : fail(`reason does not name the rule — "${v.reason}"`);
}

// A shared id token must be BOUNDED: the board lists id 12345, which is a
// prefix of target id 12345678, not a match — that job is genuinely absent.
{
  const v = classifyFullListAbsence({
    fetchSucceeded: true,
    jobs: board,
    targetUrl: 'https://acme.pinpointhq.com/en/postings/12345678',
    provider: 'pinpoint',
  });
  v.result === 'expired'
    ? pass('an id that only shares a prefix with a listed id still classifies expired')
    : fail(`prefix-id target read as ${v.result} (${v.code})`);
}

// ── present job → active ─────────────────────────────────────────────────────

{
  const v = classifyFullListAbsence({
    fetchSucceeded: true,
    jobs: board,
    // Query noise and host case never distinguish two postings on one board.
    targetUrl: 'https://ACME.pinpointhq.com/en/postings/12345?utm_source=x',
    provider: 'pinpoint',
  });
  v.result === 'active' && v.code === 'full_list_present'
    ? pass('a present job classifies active (query/case noise ignored)')
    : fail(`present job read as ${v.result} (${v.code})`);
}

// Branded job links (Teamtailor RSS, Jobvite detail URLs) change the host
// without changing the posting — the shared job id token still proves presence.
{
  const v = classifyFullListAbsence({
    fetchSucceeded: true,
    jobs: [{ title: 'Senior Dev', url: 'https://careers.acme.com/jobs/1234567-senior-dev' }],
    targetUrl: 'https://acme.teamtailor.com/jobs/1234567-senior-dev',
    provider: 'teamtailor',
  });
  v.result === 'active'
    ? pass('a branded job link still counts as present via the shared job id')
    : fail(`branded-host present job read as ${v.result} (${v.code})`);
}

// A tracked apply URL extends the feed's detail URL with a suffix path —
// Jobvite ids are alphanumeric, so no shared job id token can rescue the
// match; the path-prefix condition must count it as present.
{
  const v = classifyFullListAbsence({
    fetchSucceeded: true,
    jobs: [{ title: 'PM', url: 'https://jobs.jobvite.com/acme/job/oaBcdEfg' }],
    targetUrl: 'https://jobs.jobvite.com/acme/job/oaBcdEfg/apply',
    provider: 'jobvite',
  });
  v.result === 'active'
    ? pass('a target that extends a listed URL with a suffix path counts as present')
    : fail(`suffix-path target read as ${v.result} (${v.code})`);
}

// ── wiring: a real provider plugin feeds the rule (mocked fetch, no network) ─
// checkLivenessViaFullList must reuse providers/pinpoint.mjs to fetch the
// board, then route the parsed list through the pure rule above.
{
  const { checkLivenessViaFullList } = await import('../liveness-api.mjs');
  const realFetch = globalThis.fetch;
  globalThis.fetch = async () =>
    new Response(JSON.stringify({ data: board }), { status: 200, headers: { 'content-type': 'application/json' } });
  try {
    const live = await checkLivenessViaFullList('https://acme.pinpointhq.com/en/postings/12345');
    live?.result === 'active'
      ? pass('wiring: a listed Pinpoint posting classifies active through the provider plugin')
      : fail(`wiring: listed posting read as ${JSON.stringify(live)}`);

    const gone = await checkLivenessViaFullList('https://acme.pinpointhq.com/en/postings/99999');
    gone?.result === 'expired' && gone?.code === 'full_list_absent'
      ? pass('wiring: a Pinpoint posting missing from its board classifies expired')
      : fail(`wiring: removed posting read as ${JSON.stringify(gone)}`);

    const root = await checkLivenessViaFullList('https://acme.pinpointhq.com/');
    root === null
      ? pass('wiring: a board root URL is not a posting — null, never expired')
      : fail(`wiring: board root read as ${JSON.stringify(root)}`);

    const unknown = await checkLivenessViaFullList('https://example.com/careers/123456');
    unknown === null
      ? pass('wiring: a non-full-list URL falls through as null')
      : fail(`wiring: unknown URL read as ${JSON.stringify(unknown)}`);
  } finally {
    globalThis.fetch = realFetch;
  }

  // Errored board fetch → null (fall back to the browser rung, which can still
  // read the posting page itself), NEVER expired. A different tenant, so the
  // board cache from the assertions above cannot answer for it.
  globalThis.fetch = async () => { throw new Error('network down'); };
  try {
    const errored = await checkLivenessViaFullList('https://beta.pinpointhq.com/en/postings/1');
    errored === null
      ? pass('wiring: an errored board fetch returns null (browser fallback) — never expired')
      : fail(`wiring: errored fetch read as ${JSON.stringify(errored)}`);
  } finally {
    globalThis.fetch = realFetch;
  }

  // A 200 whose payload the parser cannot read is laundered to [] by the
  // provider — it must NOT classify expired; null sends the browser rung to
  // read the actual posting page. A fresh tenant, so no cached board answers.
  globalThis.fetch = async () =>
    new Response(JSON.stringify({ data: null }), { status: 200, headers: { 'content-type': 'application/json' } });
  try {
    const unreadable = await checkLivenessViaFullList('https://gamma.pinpointhq.com/en/postings/1');
    unreadable === null
      ? pass('wiring: a 200 with an unreadable payload returns null (browser fallback) — never expired')
      : fail(`wiring: unreadable payload read as ${JSON.stringify(unreadable)}`);
  } finally {
    globalThis.fetch = realFetch;
  }
}
