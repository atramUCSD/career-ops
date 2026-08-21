// tests/providers/builtin.test.mjs — Built In (builtin.com) SSR listing parser.
//
// The provider parses in two layers on purpose, and the tests hold that line:
// the JSON-LD ItemList is the contract that must keep working, and the card
// markup is enrichment that must degrade to '' rather than take the scan down.
// A test that only checked the happy path would let a card-markup change turn
// into an empty scan, which reads as "this source has no jobs".
import { pass, fail, ROOT } from '../helpers.mjs';
import { join } from 'path';
import { pathToFileURL } from 'url';

console.log('\nProvider — builtin (Built In SSR listing parser)');
try {
  const mod = await import(pathToFileURL(join(ROOT, 'providers/builtin.mjs')).href);
  const builtin = mod.default;
  const { parseJsonLd, parseCards, jobIdFromUrl, assertBuiltInUrl, resolveListUrl } = mod;

  const eq = (actual, expected, label) =>
    actual === expected ? pass(label) : fail(`${label} — got ${JSON.stringify(actual)}, expected ${JSON.stringify(expected)}`);

  eq(builtin.id, 'builtin', 'builtin.id is "builtin"');

  // ── detect: listing pages only ────────────────────────────────────
  eq(builtin.detect({ careers_url: 'https://builtin.com/jobs/dev-engineering' })?.url, 'https://builtin.com/jobs/dev-engineering', 'detect() claims a /jobs listing page');
  eq(builtin.detect({ careers_url: 'https://www.builtin.com/jobs' })?.url, 'https://www.builtin.com/jobs', 'detect() strips www. before matching the host');
  eq(builtin.detect({ careers_url: 'https://builtin.com/job/some-role/123' }), null, 'detect() refuses a single /job/ page (not a feed)');
  eq(builtin.detect({ careers_url: 'https://builtin.com/company/acme' }), null, 'detect() refuses a /company/ page');
  eq(builtin.detect({ careers_url: 'https://notbuiltin.com/jobs' }), null, 'detect() refuses a look-alike host');
  eq(builtin.detect({ careers_url: 'not a url' }), null, 'detect() refuses a malformed URL rather than throwing');

  // ── SSRF guard: the fetched host is pinned, not taken on trust ─────
  let threw = null;
  try { assertBuiltInUrl('https://evil.example.com/jobs'); } catch (e) { threw = e; }
  if (threw) pass('assertBuiltInUrl() refuses an off-site host');
  else fail('assertBuiltInUrl() accepted a non-builtin.com host');
  threw = null;
  try { assertBuiltInUrl('http://builtin.com/jobs'); } catch (e) { threw = e; }
  if (threw) pass('assertBuiltInUrl() refuses plain http');
  else fail('assertBuiltInUrl() accepted an http URL');

  // An inherited ?page= must not offset the walk that starts at page 1.
  eq(resolveListUrl({ api: 'https://builtin.com/jobs/remote?page=7&daysSinceUpdated=1' }).href, 'https://builtin.com/jobs/remote?daysSinceUpdated=1', 'resolveListUrl() drops an inherited page param and keeps the rest');

  eq(jobIdFromUrl('https://builtin.com/job/software-engineer-ii/9711781'), '9711781', 'jobIdFromUrl() reads the trailing numeric id');
  eq(jobIdFromUrl('https://builtin.com/company/acme'), null, 'jobIdFromUrl() returns null off a non-job URL');

  // ── JSON-LD: the primary layer ────────────────────────────────────
  //
  // Built In emits the type attribute HTML-ESCAPED as `application/ld&#x2B;json`.
  // A parser that only matches the literal `application/ld+json` finds nothing
  // here and reads the page as having no structured data at all — which is the
  // opposite of true. Both spellings must parse.
  const itemList = (items) =>
    JSON.stringify({ '@context': 'https://schema.org', '@type': 'ItemList', itemListElement: items });
  const item = (id, name, description = '') => ({
    '@type': 'ListItem',
    name,
    description,
    url: `https://builtin.com/job/slug-${id}/${id}`,
  });

  const escaped = `<script type="application/ld&#x2B;json">${itemList([item('111', 'Senior Engineer', 'Build things.')])}</script>`;
  const rows = parseJsonLd(escaped);
  eq(rows.length, 1, 'parseJsonLd() reads the &#x2B;-escaped ld+json type attribute');
  eq(rows[0]?.id, '111', 'parseJsonLd() keys rows by the job id in the URL');
  eq(rows[0]?.title, 'Senior Engineer', 'parseJsonLd() reads the posting title');
  eq(rows[0]?.description, 'Build things.', 'parseJsonLd() keeps the free description from the ItemList');

  eq(parseJsonLd(`<script type="application/ld+json">${itemList([item('222', 'Unescaped')])}</script>`).length, 1, 'parseJsonLd() also reads the unescaped spelling');

  // A broken block must not discard the good ones, and non-ItemList JSON-LD
  // (Organization, BreadcrumbList) must be ignored rather than mis-read.
  const mixed =
    '<script type="application/ld+json">{ not json }</script>' +
    '<script type="application/ld+json">{"@type":"Organization","name":"Built In"}</script>' +
    `<script type="application/ld&#x2B;json">${itemList([item('333', 'Survivor'), item('333', 'Dupe'), { '@type': 'ListItem', name: 'No URL' }])}</script>`;
  const mixedRows = parseJsonLd(mixed);
  eq(mixedRows.length, 1, 'parseJsonLd() survives a malformed block, skips non-ItemList nodes, dedupes by id, and drops URL-less entries');
  eq(mixedRows[0]?.title, 'Survivor', 'parseJsonLd() kept the first of the duplicate ids');
  eq(parseJsonLd('<html>no structured data</html>').length, 0, 'parseJsonLd() returns [] rather than throwing when the ItemList is gone');

  // ── Cards: the enrichment layer ───────────────────────────────────
  //
  // The metadata rows carry no aria-label or data-id — the FontAwesome icon
  // class is the only label, so `fa-location-dot` must not be confused with the
  // salary (`fa-sack-dollar`) or seniority (`fa-trophy`) rows beside it.
  const metaRow = (icon, inner) =>
    `<div class="d-flex align-items-start gap-sm"><div class="d-flex"><i class="fa-regular ${icon} fs-xs text-pretty-blue"></i></div> ${inner}</div>`;
  const card = (id, company, rowsHtml) =>
    `<div class="job-card" id="job-card-${id}">` +
    `<div data-id="company-title"><a href="/company/x"><span class="fw-bold">${company}</span></a></div>` +
    rowsHtml +
    metaRow('fa-sack-dollar', '<span>166K-182K Annually</span>') +
    metaRow('fa-trophy', '<span>Senior level</span>') +
    '</div>';

  const single = card('111', 'SoFi', metaRow('fa-house-building', '<span>Hybrid</span>') + metaRow('fa-location-dot', '<div><span>San Francisco, CA, USA</span></div>'));
  // Multi-site roles show "4 Locations" and hide the real list in a doubly
  // escaped Bootstrap tooltip. "4 Locations" is worthless to a location filter,
  // so the tooltip has to win.
  const tooltip = '&lt;div class=&#x27;text-truncate&#x27;&gt;Plano, TX, USA&lt;/div&gt;&lt;div class=&#x27;text-truncate&#x27;&gt;Houston, TX, USA&lt;/div&gt;';
  const multi = card('222', 'Capital One', metaRow('fa-house-building', '<span>Remote or Hybrid</span>') + metaRow('fa-location-dot', `<div><span data-bs-toggle="tooltip" aria-label="Job locations" data-bs-title="${tooltip}">2 Locations </span></div>`));

  const cards = parseCards('<html>' + single + multi + '</html>');
  eq(cards.size, 2, 'parseCards() yields one entry per job-card id');
  eq(cards.get('111')?.company, 'SoFi', 'parseCards() reads the company from data-id="company-title"');
  eq(cards.get('111')?.location, 'Hybrid · San Francisco, CA, USA', 'parseCards() joins arrangement and a single location');
  eq(cards.get('222')?.location, 'Remote or Hybrid · Plano, TX, USA · Houston, TX, USA', 'parseCards() expands the tooltip instead of keeping "2 Locations"');

  // Degradation: a card whose markup changed loses its metadata, nothing more.
  const bare = parseCards('<html><div class="job-card" id="job-card-999"><span>redesigned</span></div></html>');
  eq(bare.get('999')?.company, '', 'parseCards() yields "" for a card whose company markup changed');
  eq(bare.get('999')?.location, '', 'parseCards() yields "" for a card whose location markup changed');
  eq(parseCards(null).size, 0, 'parseCards() returns an empty map on non-string input');

  // ── fetch: pagination, the join, and end-of-walk ───────────────────
  //
  // Built In does NOT stop serving results past the last page — ?page=99 comes
  // back full — so a page with no NEW id is the only reliable stop signal.
  const page = (ids) =>
    `<script type="application/ld&#x2B;json">${itemList(ids.map((id) => item(id, `Role ${id}`)))}</script>` +
    ids.map((id) => card(id, `Co ${id}`, metaRow('fa-location-dot', '<div><span>Remote</span></div>'))).join('');

  const requested = [];
  const ctx = {
    sleep: async () => {},
    async fetchText(url, opts) {
      requested.push({ url, redirect: opts?.redirect });
      const n = Number(new URL(url).searchParams.get('page') || '1');
      // Pages 1-2 are distinct; page 3 repeats page 2 the way the real site does.
      return page(n === 1 ? ['1', '2'] : ['3', '4']);
    },
  };
  const jobs = await builtin.fetch({ careers_url: 'https://builtin.com/jobs/remote' }, ctx);
  eq(jobs.length, 4, 'fetch() walks pages until one yields no new id');
  eq(requested.length, 3, 'fetch() stopped after the first repeat page (did not run to MAX_PAGES)');
  eq(requested[0].url, 'https://builtin.com/jobs/remote', 'fetch() requests page 1 without a page param');
  eq(requested[1].url, 'https://builtin.com/jobs/remote?page=2', 'fetch() paginates with ?page=N, 1-based');
  if (requested.every((r) => r.redirect === 'error')) pass('fetch() passes redirect:"error" on every request (a 3xx off builtin.com is an SSRF vector)');
  else fail('fetch() must pass redirect:"error" on every request');
  eq(jobs[0]?.company, 'Co 1', 'fetch() joins card enrichment onto the JSON-LD row by job id');
  eq(jobs[0]?.location, 'Remote', 'fetch() carries the parsed location through');

  // max_jobs is a cap the caller sets, and it must actually bound the result.
  const capped = await builtin.fetch({ careers_url: 'https://builtin.com/jobs/remote', max_jobs: 3 }, ctx);
  eq(capped.length, 3, 'fetch() honours max_jobs');

  // Page 1 failing before anything succeeded is an unreachable source, not an
  // empty one — throwing is what makes scan record a failure instead of "0 jobs".
  const dead = { sleep: async () => {}, fetchText: async () => { throw new Error('HTTP 503'); } };
  threw = null;
  try { await builtin.fetch({ careers_url: 'https://builtin.com/jobs/remote' }, dead); } catch (e) { threw = e; }
  if (threw) pass('fetch() throws when page 1 fails (unreachable ≠ empty)');
  else fail('fetch() swallowed a page-1 failure and returned an empty list');

  // A LATER page failing keeps what was already collected.
  let calls = 0;
  const flaky = {
    sleep: async () => {},
    async fetchText() {
      calls++;
      if (calls > 1) throw new Error('HTTP 500');
      return page(['1', '2']);
    },
  };
  eq((await builtin.fetch({ careers_url: 'https://builtin.com/jobs/remote' }, flaky)).length, 2, 'fetch() keeps partial results when a later page fails');

  // No ItemList at all (markup rewritten) ends the walk quietly rather than looping.
  const empty = { sleep: async () => {}, fetchText: async () => '<html>nothing</html>' };
  eq((await builtin.fetch({ careers_url: 'https://builtin.com/jobs/remote' }, empty)).length, 0, 'fetch() ends the walk when a page carries no ItemList');
} catch (err) {
  fail(`builtin provider tests crashed: ${err.message}`);
}
