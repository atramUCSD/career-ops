// tests/providers/jobtech.test.mjs — JobTech (Arbetsformedlingen) provider.
// Fixtures mirror the live shapes probed 2026-08-28 (see providers/jobtech.mjs
// header). Fully offline: every fetch goes through a mock ctx.
import { pass, fail, ROOT, rmSync } from '../helpers.mjs';
import { join } from 'path';
import { pathToFileURL } from 'url';
import { mkdtempSync, mkdirSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';

console.log('\nProvider — jobtech');

try {
  const mod = await import(pathToFileURL(join(ROOT, 'providers/jobtech.mjs')).href);
  const jobtech = mod.default;
  const { parseJobtechConfig, normalizeJob, buildLocation } = mod;

  if (jobtech.id === 'jobtech') pass('jobtech.id is "jobtech"');
  else fail(`jobtech.id is ${JSON.stringify(jobtech.id)}`);

  // parseJobtechConfig — defaults when block is absent
  const def = parseJobtechConfig({});
  if (def.keywords.length === 0 && def.days === 30 && def.size === 100) {
    pass('parseJobtechConfig applies defaults (days 30, size 100)');
  } else {
    fail(`parseJobtechConfig defaults = ${JSON.stringify(def)}`);
  }

  // parseJobtechConfig — sanitizes keywords and clamps numbers
  const cfg = parseJobtechConfig({
    jobtech: { keywords: ['  python  ', '', 7, 'python', 'data engineer'], size: 0, days: -3 },
  });
  if (cfg.keywords.length === 2 && cfg.keywords[0] === 'python' && cfg.keywords[1] === 'data engineer') {
    pass('parseJobtechConfig trims, dedups, and drops empty/non-string keywords');
  } else {
    fail(`parseJobtechConfig keywords = ${JSON.stringify(cfg.keywords)}`);
  }
  if (cfg.size === 1 && cfg.days === 1) pass('parseJobtechConfig clamps size/days at their lower bound');
  else fail(`parseJobtechConfig lower clamp = ${JSON.stringify(cfg)}`);
  const high = parseJobtechConfig({ jobtech: { keywords: ['x'], size: 999, days: 999999 } });
  if (high.size === 100 && high.days === 1000) pass('parseJobtechConfig clamps size/days at their upper bound');
  else fail(`parseJobtechConfig upper clamp = ${JSON.stringify(high)}`);

  // A hit as the live /search endpoint returns it (probed 2026-08-28), trimmed
  // to the fields the provider reads plus a few it must ignore.
  const liveHit = (id, headline, extra = {}) => ({
    relevance: 1.0,
    id: String(id),
    external_id: null,
    webpage_url: `https://arbetsformedlingen.se/platsbanken/annonser/${id}`,
    headline,
    application_deadline: '2026-09-12T23:59:59',
    description: { text: 'Vi soker en utvecklare.' },
    employer: { name: 'Independent Tech Sweden AB', workplace: 'Independtech', organization_number: '5593267684' },
    workplace_address: { municipality: 'Stockholm', region: 'Stockholms län', country: 'Sverige', country_code: '199' },
    publication_date: '2026-03-16T13:53:01',
    removed: false,
    removed_date: null,
    ...extra,
  });

  // normalizeJob — happy path maps JobSearch fields into the Job shape
  const norm = normalizeJob(liveHit(30751757, '  Fullstackutvecklare Python  '));
  if (
    norm && norm.title === 'Fullstackutvecklare Python'
    && norm.url === 'https://arbetsformedlingen.se/platsbanken/annonser/30751757'
    && norm.company === 'Independent Tech Sweden AB'
    && norm.location === 'Stockholm'
    && norm.postedAt === Date.parse('2026-03-16T13:53:01')
    && norm.description === 'Vi soker en utvecklare.'
    && norm.id === '30751757'
  ) {
    pass('normalizeJob maps JobSearch fields to the Job shape and builds the Platsbanken URL');
  } else {
    fail(`normalizeJob = ${JSON.stringify(norm)}`);
  }

  // normalizeJob — employer.name is primary (workplace is free text employers
  // often fill with a location, observed live), workplace only a fallback.
  const noName = normalizeJob(liveHit(1, 'X', { employer: { workplace: 'Brand Only' } }));
  if (noName && noName.company === 'Brand Only') pass('normalizeJob falls back to employer.workplace when name is missing');
  else fail(`normalizeJob company fallback = ${JSON.stringify(noName)}`);

  // normalizeJob — null without id/title, and on a removal tombstone.
  // A removed ad's tombstone (live-probed via /ad/{id} minutes after removal)
  // is removed:true with headline null — it must never surface as a Job.
  const tombstone = { id: '31299407', removed: true, removed_date: '2026-08-29T03:06:54', headline: null };
  if (
    normalizeJob({ headline: 'No id' }) === null
    && normalizeJob({ id: '1', headline: '  ' }) === null
    && normalizeJob(tombstone) === null
    && normalizeJob(liveHit(2, 'Removed but titled', { removed: true })) === null
  ) {
    pass('normalizeJob returns null without id/title and for removed tombstones');
  } else {
    fail('normalizeJob should return null for tombstones and id/title-less hits');
  }

  // buildLocation — Sweden stays city-only, a foreign country is appended
  if (
    buildLocation({ municipality: 'Stockholm', country: 'Sverige' }) === 'Stockholm'
    && buildLocation({ municipality: 'Oslo', country: 'Norge' }) === 'Oslo, Norge'
    && buildLocation(null) === ''
    && buildLocation({ country: 'Danmark' }) === 'Danmark'
  ) {
    pass('buildLocation keeps Swedish cities bare and appends non-SE countries');
  } else {
    fail('buildLocation returned an unexpected value');
  }

  // fetch() — happy path: sends the probed query params, dedups across
  // keywords, and strips the internal id from the output.
  {
    const urls = [];
    let sentOpts = null;
    const mkCtx = (byQ) => ({
      fetchJson: async (url, opts) => {
        urls.push(url);
        sentOpts = opts;
        const u = new URL(url);
        const pages = byQ[u.searchParams.get('q')] || [];
        const page = Math.trunc(Number(u.searchParams.get('offset')) / Number(u.searchParams.get('limit')));
        return { total: { value: 1 }, hits: pages[page] || [] };
      },
    });
    const fetched = await jobtech.fetch(
      { name: 'JobTech', jobtech: { keywords: ['python', 'data'], days: 30, size: 100 } },
      mkCtx({
        python: [[liveHit(1, 'Python Dev')]],
        data: [[liveHit(1, 'Python Dev'), liveHit(2, 'Data Engineer')]],
      }),
    );
    const first = new URL(urls[0]);
    if (
      first.origin + first.pathname === 'https://jobsearch.api.jobtechdev.se/search'
      && first.searchParams.get('q') === 'python'
      && first.searchParams.get('limit') === '100'
      && first.searchParams.get('offset') === '0'
      && first.searchParams.get('published-after') === String(30 * 1440)
    ) {
      pass('jobtech.fetch() sends q/limit/offset/published-after to the search endpoint');
    } else {
      fail(`jobtech.fetch() first request = ${urls[0]}`);
    }
    if (sentOpts?.redirect === 'error') pass('jobtech.fetch() passes redirect:"error" (SSRF hardening)');
    else fail(`jobtech.fetch() opts = ${JSON.stringify(sentOpts)}`);
    if (fetched.length === 2 && fetched.every(j => !('id' in j))) {
      pass('jobtech.fetch() dedups by ad id across keywords and strips id from output');
    } else {
      fail(`jobtech.fetch() returned ${JSON.stringify(fetched)}`);
    }
  }

  // fetch() — pagination: full page → next offset; short page → stop.
  {
    const offsets = [];
    const paged = await jobtech.fetch(
      { name: 'JobTech', jobtech: { keywords: ['python'], size: 2 } },
      {
        fetchJson: async (url) => {
          const u = new URL(url);
          const offset = Number(u.searchParams.get('offset'));
          offsets.push(offset);
          if (offset === 0) return { hits: [liveHit(1, 'A'), liveHit(2, 'B')] }; // full page
          return { hits: [liveHit(3, 'C')] }; // short page → stop
        },
      },
    );
    if (paged.length === 3 && offsets.length === 2 && offsets[1] === 2) {
      pass('jobtech.fetch() paginates by offset until a short page is returned');
    } else {
      fail(`jobtech.fetch() pagination offsets=${JSON.stringify(offsets)}, results=${paged.length}`);
    }
  }

  // fetch() — a run of full pages stops at MAX_PAGES_PER_KEYWORD (20), which
  // also keeps every request at or under the gateway's offset<=2000 cap.
  {
    let calls = 0;
    let maxOffset = -1;
    const capped = await jobtech.fetch(
      { name: 'JobTech', jobtech: { keywords: ['python'], size: 100 } },
      {
        fetchJson: async (url) => {
          calls++;
          const offset = Number(new URL(url).searchParams.get('offset'));
          maxOffset = Math.max(maxOffset, offset);
          return { hits: Array.from({ length: 100 }, (_, i) => liveHit(offset + i, `Job ${offset + i}`)) };
        },
      },
    );
    if (calls === 20 && maxOffset === 1900 && capped.length === 2000) {
      pass('jobtech.fetch() caps pagination at 20 pages (offset stays within the gateway limit)');
    } else {
      fail(`jobtech.fetch() page cap: calls=${calls}, maxOffset=${maxOffset}, results=${capped.length}`);
    }
  }

  // fetch() — probing (ctx.maxPages) caps pages and propagates the first error
  {
    let probeCalls = 0;
    await jobtech.fetch(
      { name: 'JobTech', jobtech: { keywords: ['python'], size: 1 } },
      { maxPages: 1, fetchJson: async () => { probeCalls++; return { hits: [liveHit(1, 'A')] }; } },
    );
    if (probeCalls === 1) pass('jobtech.fetch() honors ctx.maxPages while probing');
    else fail(`jobtech.fetch() probe made ${probeCalls} calls (expected 1)`);

    let probeThrew = false;
    try {
      await jobtech.fetch(
        { name: 'JobTech', jobtech: { keywords: ['a', 'b'] } },
        { maxPages: 1, fetchJson: async () => { throw new Error('HTTP 503'); } },
      );
    } catch (e) { probeThrew = /503/.test(e.message); }
    if (probeThrew) pass('jobtech.fetch() propagates the first error as-is while probing');
    else fail('jobtech.fetch() should rethrow the original error when probing');
  }

  // fetch() — malformed payloads degrade to an empty page, never a throw, and
  // never fabricate offers.
  {
    let threw = false;
    let result;
    try {
      result = await jobtech.fetch(
        { name: 'JobTech', jobtech: { keywords: ['python'] } },
        { fetchJson: async () => ({}) }, // no hits key at all
      );
    } catch { threw = true; }
    if (!threw && Array.isArray(result) && result.length === 0) {
      pass('jobtech.fetch() treats a missing hits key as an empty page, not a throw');
    } else {
      fail(`jobtech.fetch() malformed response: threw=${threw}, result=${JSON.stringify(result)}`);
    }

    let anyThrew = false;
    try {
      await jobtech.fetch({ name: 'J', jobtech: { keywords: ['x'] } }, { fetchJson: async () => ({ hits: null }) });
      await jobtech.fetch({ name: 'J', jobtech: { keywords: ['x'] } }, { fetchJson: async () => ({ hits: 'oops' }) });
      await jobtech.fetch({ name: 'J', jobtech: { keywords: ['x'] } }, { fetchJson: async () => null });
      await jobtech.fetch({ name: 'J', jobtech: { keywords: ['x'] } }, { fetchJson: async () => ({ hits: [null, {}, 42] }) });
    } catch { anyThrew = true; }
    if (!anyThrew) pass('jobtech.fetch() does not throw on null/non-array/garbage hits values');
    else fail('jobtech.fetch() threw on a malformed hits value');
  }

  // fetch() — one keyword fails while another answers → partial success, no throw
  {
    let partialThrew = false;
    let partial;
    try {
      partial = await jobtech.fetch(
        { name: 'JobTech', jobtech: { keywords: ['ok', 'bad'] } },
        {
          fetchJson: async (url) => {
            if (new URL(url).searchParams.get('q') === 'bad') throw new Error('HTTP 500');
            return { hits: [liveHit(1, 'A')] };
          },
        },
      );
    } catch { partialThrew = true; }
    if (!partialThrew && partial.length === 1) {
      pass('jobtech.fetch() tolerates a failed keyword when another succeeds (recall-first)');
    } else {
      fail(`jobtech.fetch() partial failure: threw=${partialThrew}, result=${JSON.stringify(partial)}`);
    }
  }

  // fetch() — total outage (every keyword fails) throws instead of returning
  // an empty board.
  {
    let outageThrew = false;
    try {
      await jobtech.fetch(
        { name: 'JobTech', jobtech: { keywords: ['a', 'b'] } },
        { fetchJson: async () => { throw new Error('HTTP 502'); } },
      );
    } catch (e) { outageThrew = /jobtech: all 2 keyword/.test(e.message); }
    if (outageThrew) pass('jobtech.fetch() throws on total outage instead of reporting an empty board');
    else fail('jobtech.fetch() should throw when every keyword request fails');
  }

  // fetch() — keyword fallback to config/profile.yml's target_roles, and a
  // hard throw when neither source has keywords. Runs in an isolated tmp cwd
  // so the test is hermetic regardless of whether the checkout is onboarded
  // (same pattern as tests/providers/vdab.test.mjs).
  {
    const withTmpCwd = async (setup, run) => {
      const tmp = mkdtempSync(join(tmpdir(), 'career-ops-jobtech-fallback-'));
      const cwdBefore = process.cwd();
      try {
        setup(tmp);
        process.chdir(tmp);
        return await run();
      } finally {
        // chdir back BEFORE removing: Windows refuses to delete the process's
        // own working directory.
        process.chdir(cwdBefore);
        rmSync(tmp, { recursive: true, force: true });
      }
    };

    let sentQ = null;
    await withTmpCwd(
      (tmp) => {
        mkdirSync(join(tmp, 'config'));
        writeFileSync(join(tmp, 'config', 'profile.yml'), 'target_roles:\n  primary:\n    - Data Engineer\n');
      },
      () => jobtech.fetch(
        { name: 'JobTech', jobtech: {} },
        { fetchJson: async (url) => { sentQ = new URL(url).searchParams.get('q'); return { hits: [] }; } },
      ),
    );
    if (sentQ === 'Data Engineer') {
      pass('jobtech.fetch() falls back to config/profile.yml target_roles when jobtech.keywords[] is empty');
    } else {
      fail(`jobtech.fetch() fallback q = ${JSON.stringify(sentQ)}`);
    }

    let threwNoKeywords = false;
    try {
      await withTmpCwd(
        () => {}, // no config/ dir — profile.yml genuinely absent
        () => jobtech.fetch({ name: 'JobTech empty', jobtech: {} }, { fetchJson: async () => ({ hits: [] }) }),
      );
    } catch { threwNoKeywords = true; }
    if (threwNoKeywords) pass('jobtech.fetch() throws when jobtech.keywords[] and the profile fallback are both empty');
    else fail('jobtech.fetch() should throw when no keywords are available from any source');
  }

} catch (e) {
  fail(`jobtech provider tests crashed: ${e.message}`);
}
