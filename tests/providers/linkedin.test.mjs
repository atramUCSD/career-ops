// tests/providers/linkedin.test.mjs — offline coverage for the guest search provider.
// Fixture markup is a trimmed copy of a real /jobs-guest/…/search response, so a
// change to LinkedIn's card classes fails here rather than silently returning 0 jobs.
import { pass, fail, ROOT, NODE } from '../helpers.mjs';
import { execFileSync } from 'child_process';
import { join } from 'path';
import { pathToFileURL } from 'url';

console.log('\nProvider — linkedin');

/** One result card, in the shape the guest endpoint actually returns. */
function card({ id, title, company, location, date }) {
  return `
  <li>
    <div class="base-card relative base-card--link job-search-card" data-entity-urn="urn:li:jobPosting:${id}">
      <h3 class="base-search-card__title">
        ${title}
      </h3>
      <h4 class="base-search-card__subtitle">
        <a class="hidden-nested-link" href="https://www.linkedin.com/company/x?trk=abc">
          ${company}
        </a>
      </h4>
      <span class="job-search-card__location">${location}</span>
      ${date ? `<time class="job-search-card__listdate" datetime="${date}">6 days ago</time>` : ''}
      <a class="base-card__full-link" href="https://www.linkedin.com/jobs/view/slug-${id}?position=1&amp;refId=zz&amp;trackingId=qq"></a>
    </div>
  </li>`;
}

const PAGE_A = `<ul>${card({
  id: '4427314049',
  title: 'Machine&nbsp;Learning Engineer',
  company: 'General Atomics Aeronautical Systems',
  location: 'Poway, CA',
  date: '2026-08-21',
})}${card({
  id: '4427314050',
  title: 'Frontend Engineer',
  company: 'Acme Corp',
  location: 'San Diego, CA',
  date: '',
})}</ul>`;

try {
  const mod = await import(pathToFileURL(join(ROOT, 'providers/linkedin.mjs')).href);
  const linkedin = mod.default;
  const { parseSearchCards, buildSearchUrl, jobUrl, resolveQueries } = mod;

  if (linkedin.id === 'linkedin') pass('linkedin.id is "linkedin"');
  else fail(`linkedin.id is ${JSON.stringify(linkedin.id)}`);

  // --- detect() -------------------------------------------------------------
  if (linkedin.detect({ name: 'LinkedIn', provider: 'linkedin' })?.url?.includes('seeMoreJobPostings')) {
    pass('linkedin.detect() claims explicit provider config');
  } else {
    fail('linkedin.detect() should claim provider: linkedin');
  }
  if (linkedin.detect({ provider: 'builtin' }) === null) {
    pass('linkedin.detect() ignores other provider ids');
  } else {
    fail('linkedin.detect() must not claim entries it does not own');
  }
  // The detect() sweep runs this over every provider-less entry; claiming a bare
  // linkedin.com careers_url would swallow company pages and profile links.
  if (linkedin.detect({ careers_url: 'https://www.linkedin.com/company/acme/jobs/' }) === null) {
    pass('linkedin.detect() does not claim bare linkedin.com URLs');
  } else {
    fail('linkedin.detect() claimed a linkedin.com URL without provider: linkedin');
  }

  // --- URL construction -----------------------------------------------------
  const url = new URL(buildSearchUrl('Machine Learning Engineer', 'San Diego, CA', 20));
  if (url.hostname === 'www.linkedin.com' && url.protocol === 'https:') {
    pass('buildSearchUrl() stays on https://www.linkedin.com');
  } else {
    fail(`buildSearchUrl() host/protocol wrong: ${url.href}`);
  }
  if (
    url.searchParams.get('keywords') === 'Machine Learning Engineer' &&
    url.searchParams.get('location') === 'San Diego, CA' &&
    url.searchParams.get('start') === '20'
  ) {
    pass('buildSearchUrl() encodes keywords/location/start');
  } else {
    fail(`buildSearchUrl() params wrong: ${url.search}`);
  }
  const recent = new URL(buildSearchUrl('UX Engineer', '', 0, 86400));
  if (recent.searchParams.get('f_TPR') === 'r86400' && !url.searchParams.has('f_TPR')) {
    pass('buildSearchUrl() adds f_TPR only when a window is given');
  } else {
    fail(`buildSearchUrl() f_TPR wrong: ${recent.search} / ${url.search}`);
  }
  if (!new URL(buildSearchUrl('x', '', 0)).searchParams.has('location')) {
    pass('buildSearchUrl() omits an empty location');
  } else {
    fail('buildSearchUrl() sent an empty location param');
  }

  if (jobUrl('4427314049') === 'https://www.linkedin.com/jobs/view/4427314049') {
    pass('jobUrl() builds the canonical /jobs/view/{id} form');
  } else {
    fail(`jobUrl() returned ${jobUrl('4427314049')}`);
  }

  // --- parsing --------------------------------------------------------------
  const rows = parseSearchCards(PAGE_A);
  if (rows.length === 2) pass('parseSearchCards() reads both cards');
  else fail(`parseSearchCards() returned ${rows.length} rows`);

  const [first, second] = rows;
  if (first?.title === 'Machine Learning Engineer') pass('parseSearchCards() decodes entities in the title');
  else fail(`title was ${JSON.stringify(first?.title)}`);

  if (first?.company === 'General Atomics Aeronautical Systems') pass('parseSearchCards() reads the company');
  else fail(`company was ${JSON.stringify(first?.company)}`);

  if (first?.location === 'Poway, CA') pass('parseSearchCards() reads the location');
  else fail(`location was ${JSON.stringify(first?.location)}`);

  // The tracking-param href would dedup as a new posting on every scan, and the
  // liveness resolver only matches the canonical form.
  if (first?.url === 'https://www.linkedin.com/jobs/view/4427314049') {
    pass('parseSearchCards() emits the canonical URL, not the tracking href');
  } else {
    fail(`url was ${JSON.stringify(first?.url)}`);
  }

  if (first?.postedAt === Date.parse('2026-08-21T12:00:00Z')) {
    pass('parseSearchCards() reads datetime as midday UTC');
  } else {
    fail(`postedAt was ${first?.postedAt}`);
  }

  // A dateless card must omit postedAt rather than invent one — scan.mjs treats
  // a non-finite postedAt as "unknown", and a fabricated date would defeat the
  // max_posting_age_days gate.
  if (second && !('postedAt' in second)) pass('parseSearchCards() omits postedAt when the card has no date');
  else fail(`dateless card got postedAt ${second?.postedAt}`);

  // Fields must never bleed across card boundaries.
  const bleed = parseSearchCards(
    `<ul>${card({ id: '1', title: 'No Location Role', company: 'A Co', location: '', date: '' })}${card({
      id: '2',
      title: 'Second Role',
      company: 'B Co',
      location: 'Austin, TX',
      date: '',
    })}</ul>`,
  );
  if (bleed[0]?.location === '' && bleed[1]?.location === 'Austin, TX') {
    pass('parseSearchCards() does not leak a field from the next card');
  } else {
    fail(`card fields bled: ${JSON.stringify(bleed.map((r) => r.location))}`);
  }

  if (parseSearchCards('<ul></ul>').length === 0 && parseSearchCards(null).length === 0) {
    pass('parseSearchCards() returns [] for empty and non-string input');
  } else {
    fail('parseSearchCards() mishandled empty input');
  }

  // --- query resolution -----------------------------------------------------
  if (JSON.stringify(resolveQueries({ q: '  Design Engineer  ' })) === '["Design Engineer"]') {
    pass('resolveQueries() prefers q: as a single search');
  } else {
    fail(`resolveQueries(q) returned ${JSON.stringify(resolveQueries({ q: 'Design Engineer' }))}`);
  }
  // The whole point: two keywords are two searches, never one AND-ed query.
  const multi = resolveQueries({ keywords: ['Frontend Engineer', 'Design Engineer', 'Frontend Engineer'] });
  if (multi.length === 2 && multi[0] === 'Frontend Engineer' && multi[1] === 'Design Engineer') {
    pass('resolveQueries() keeps keywords as separate deduped searches');
  } else {
    fail(`resolveQueries(keywords) returned ${JSON.stringify(multi)}`);
  }

  // --- fetch walk -----------------------------------------------------------
  /** Records every URL requested and replays canned pages. */
  function ctxFor(pages, { throwOn = null } = {}) {
    const calls = [];
    return {
      calls,
      transport: 'http',
      sleep: async () => {},
      fetchText: async (u) => {
        calls.push(u);
        if (throwOn && u.includes(throwOn)) throw new Error('boom');
        return pages[calls.length - 1] ?? '';
      },
    };
  }

  {
    const ctx = ctxFor([PAGE_A, '']);
    const jobs = await linkedin.fetch({ q: 'Frontend Engineer' }, ctx);
    if (jobs.length === 2) pass('fetch() returns the parsed page');
    else fail(`fetch() returned ${jobs.length} jobs`);
    if (jobs.every((j) => !('id' in j))) pass('fetch() strips the internal id from returned jobs');
    else fail('fetch() leaked the internal id field');
    if (ctx.calls.length === 2 && ctx.calls[1].includes('start=10')) {
      pass('fetch() paginates by 10 and stops on the empty page');
    } else {
      fail(`fetch() made ${ctx.calls.length} calls: ${ctx.calls.join(' | ')}`);
    }
  }

  {
    // Same page served to both queries: the second query adds nothing, so the
    // union must dedup by posting id rather than double-count.
    const ctx = ctxFor([PAGE_A, '', PAGE_A, '']);
    const jobs = await linkedin.fetch({ keywords: ['Frontend Engineer', 'Design Engineer'] }, ctx);
    if (jobs.length === 2) pass('fetch() dedups postings across queries');
    else fail(`fetch() returned ${jobs.length} jobs across two queries`);
    if (ctx.calls.some((u) => u.includes('keywords=Design+Engineer'))) {
      pass('fetch() runs one search per keyword');
    } else {
      fail(`fetch() never searched the second keyword: ${ctx.calls.join(' | ')}`);
    }
  }

  {
    // verify-portals.mjs sets maxPages=1 for its health probe.
    const ctx = ctxFor([PAGE_A, PAGE_A]);
    await linkedin.fetch({ q: 'Frontend Engineer' }, { ...ctx, maxPages: 1 });
    if (ctx.calls.length === 1) pass('fetch() honours ctx.maxPages');
    else fail(`fetch() made ${ctx.calls.length} calls under maxPages=1`);
  }

  {
    const ctx = ctxFor([PAGE_A], { throwOn: 'start=0' });
    let threw = false;
    try {
      await linkedin.fetch({ q: 'Frontend Engineer' }, ctx);
    } catch {
      threw = true;
    }
    // Unreachable must not read as "live but empty" — that would hide a throttle
    // behind a clean portal-health row.
    if (threw) pass('fetch() throws when the first page fails');
    else fail('fetch() swallowed a first-page failure');
  }

  {
    const ctx = ctxFor([PAGE_A], { throwOn: 'start=10' });
    const jobs = await linkedin.fetch({ q: 'Frontend Engineer' }, ctx);
    if (jobs.length === 2) pass('fetch() keeps partial results when a later page fails');
    else fail(`fetch() returned ${jobs.length} jobs after a later-page failure`);
  }

  {
    const ctx = ctxFor([PAGE_A, PAGE_A, PAGE_A]);
    const jobs = await linkedin.fetch({ q: 'Frontend Engineer', max_jobs: 1 }, ctx);
    if (jobs.length === 1) pass('fetch() honours max_jobs');
    else fail(`fetch() returned ${jobs.length} jobs under max_jobs: 1`);
  }

  {
    // No q:, no keywords: and no resolvable profile — an empty board would look
    // like a healthy one, so this must be an error.
    //
    // Runs in a child process rather than inline: _profile-keywords.mjs reads
    // CAREER_OPS_PROFILE once at module load, and the suite runs every test
    // in one process, so by the time this file executes another provider's
    // test has already imported that module with the real profile path. Setting
    // the variable here would do nothing.
    const probe = [
      'const p = (await import(process.env.LINKEDIN_PROVIDER_URL)).default;',
      'try { await p.fetch({}, { fetchText: async () => "" }); console.log("NO_THROW"); }',
      'catch (e) { console.log(e.message.includes("no search terms") ? "THREW" : "WRONG:" + e.message); }',
    ].join('');
    let out = '';
    try {
      // The module under test arrives by env var, not argv: tests/main-guard-convention
      // forbids process.argv[1] outside lib/is-main-module.mjs.
      out = execFileSync(NODE, ['--input-type=module', '-e', probe], {
        encoding: 'utf8',
        env: {
          ...process.env,
          CAREER_OPS_PROFILE: join(ROOT, 'tests', 'no-such-profile.yml'),
          LINKEDIN_PROVIDER_URL: pathToFileURL(join(ROOT, 'providers/linkedin.mjs')).href,
        },
        timeout: 15_000,
      }).trim();
    } catch (err) {
      out = `SPAWN_FAILED: ${err.message}`;
    }
    if (out === 'THREW') pass('fetch() throws when no search terms resolve');
    else fail(`fetch() with no search terms: ${out}`);
  }
} catch (err) {
  fail(`linkedin provider test threw: ${err.message}`);
}
