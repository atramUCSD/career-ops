// tests/providers/calopps.test.mjs — provider-contract tests for the CalOpps
// table view (providers/calopps.mjs).
//
// Row markup reproduces the live /job-search-list page measured on 2026-09-29:
// a Drupal views table, one <tr> per posting, the label cell linking
// /{agency-slug}/job-{id}, the region in its own cell, and a header row that
// carries the same views-field-label class but no posting link. Agency slugs
// here are fictional.
import { pass, fail, ROOT } from '../helpers.mjs';
import { join } from 'path';
import { pathToFileURL } from 'url';

console.log('\nProvider — calopps');

const row = (slug, id, title, region = 'East Bay') => `
<tr class="odd"> <td class="views-field views-field-label" > <a href="/${slug}/job-${id}">${title}</a> </td>
<td class="views-field views-field-ss-term-name-field-rec-location" > ${region} </td>
<td class="views-field views-field-ss-term-name-field-rec-job-category" > Recreation </td>
<td class="views-field views-field-ss-term-name-field-rec-job-type" > Temporary </td>
<td class="views-field views-field-ss-simple-date-field-rec-close-date" > Until Filled </td> </tr>`;

const page = (rows) => `<html><body><table class="views-table cols-5"><thead><tr>
<th class="views-field views-field-label" scope="col">Job Title</th>
<th class="views-field views-field-ss-term-name-field-rec-location" scope="col">Region</th>
</tr></thead><tbody>${rows.join('')}</tbody></table>
<ul class="pagination"><li><a href="/job-search-list?page=1">2</a></li></ul></body></html>`;

/** A full page of unique postings, ids offset so pages never overlap. */
const fullPage = (n) => page(Array.from({ length: 25 }, (_, i) => row('example-county', 900000 + n * 100 + i, `Analyst ${n}-${i}`)));
const EMPTY = '<html><body><div class="view-empty">No jobs found.</div></body></html>';
const LIST = 'https://www.calopps.org/job-search-list';

/** Swallow and collect console.error lines from `fn`. */
async function captureErrors(fn) {
  const lines = [];
  const orig = console.error;
  console.error = (...a) => lines.push(a.join(' '));
  try { return { value: await fn(), lines }; } finally { console.error = orig; }
}

try {
  const mod = await import(pathToFileURL(join(ROOT, 'providers/calopps.mjs')).href);
  const calopps = mod.default;
  const { parseListingPage, agencyName, buildListUrl, assertParsedSomething } = mod;

  if (calopps.id === 'calopps') pass('calopps.id is "calopps"');
  else fail(`calopps.id is ${JSON.stringify(calopps.id)}`);

  // ── detect(): explicit selection only ──
  const hit = calopps.detect({ name: 'Acme Board', provider: 'calopps' });
  if (hit && hit.url === LIST) pass('detect() resolves provider:calopps with no careers_url');
  else fail(`detect() returned ${JSON.stringify(hit)}`);
  if (calopps.detect({ name: 'Acme', careers_url: LIST }) === null && calopps.detect(null) === null
      && calopps.detect({ provider: 'itviec' }) === null) {
    pass('detect() returns null without provider:calopps');
  } else {
    fail('detect() must require provider:calopps');
  }

  if (buildListUrl(0) === LIST && buildListUrl(3) === `${LIST}?page=3`) pass('buildListUrl(): zero-based pager, page 0 is the bare path');
  else fail(`buildListUrl drift: ${buildListUrl(0)} / ${buildListUrl(3)}`);

  if (agencyName('acme-bridge-highway-and-transportation-district') === 'Acme Bridge Highway and Transportation District'
      && agencyName('the-exampleco-district') === 'The Exampleco District') {
    pass('agencyName() title-cases the slug, small words lowercase except first');
  } else {
    fail(`agencyName drift: ${agencyName('acme-bridge-highway-and-transportation-district')} / ${agencyName('the-exampleco-district')}`);
  }

  // ── parseListingPage() ──
  {
    const html = page([
      row('example-county', '101', 'Parks &amp; Recreation Aide', 'San Francisco/Peninsula'),
      row('acme-water-district', '102', 'Linux Systems Administrator', ''),
      row('acme-water-district', '103', '   '),
      // A lone surrogate cannot reach a posting URL: the slug pattern rejects the row.
      row('bad\uD800slug', '104', 'Dropped Row'),
    ]);
    const { rows, jobs } = parseListingPage(html);
    if (jobs.length === 2 && rows === 3) pass('parseListingPage(): header row and unmatched slug skipped, empty title dropped but counted');
    else fail(`parseListingPage() rows=${rows} jobs=${JSON.stringify(jobs)}`);
    const [a, b] = jobs;
    if (a?.title === 'Parks & Recreation Aide') pass('title entities decode before any keyword match');
    else fail(`title drift: ${JSON.stringify(a?.title)}`);
    if (a?.url === 'https://www.calopps.org/example-county/job-101' && a?.company === 'Example County'
        && a?.location === 'San Francisco/Peninsula, California' && !('postedAt' in a)) {
      pass('row → absolute posting URL, agency from slug, region + state, no invented postedAt');
    } else {
      fail(`row drift: ${JSON.stringify(a)}`);
    }
    if (b?.location === 'California') pass('an empty region still carries the state');
    else fail(`empty region drift: ${JSON.stringify(b)}`);
  }

  // ── The silent-zero guard ──
  {
    let threw = false;
    try { assertParsedSomething(fullPage(0).replace(/views-field-label/g, 'renamed'), LIST); } catch { threw = true; }
    if (threw) pass('assertParsedSomething() throws when posting links are present but unparsed');
    else fail('a page still linking postings must not read as empty');
    let threwEmpty = false;
    try { assertParsedSomething(EMPTY, LIST); } catch { threwEmpty = true; }
    if (!threwEmpty) pass('a genuinely empty page does not throw');
    else fail('an empty board must return [], not throw');
  }

  // ── fetch(): pagination, pacing, redirect policy ──
  {
    const requests = [];
    let slept = 0;
    const pages = new Map([[LIST, fullPage(0)], [`${LIST}?page=1`, page([row('acme-city', '5', 'Clerk')])]]);
    const ctx = {
      sleep: async (ms) => { slept += ms; },
      fetchText: async (url, opts) => { requests.push({ url, opts }); return pages.get(url) ?? EMPTY; },
    };
    const jobs = await calopps.fetch({ name: 'CalOpps' }, ctx);
    if (jobs.length === 26 && requests.length === 2) pass('fetch() stops on a short page');
    else fail(`fetch() returned ${jobs.length} jobs over ${requests.length} requests`);
    if (requests.every((r) => r.opts?.redirect === 'error')) pass("every request passes redirect: 'error'");
    else fail(`redirect drift: ${JSON.stringify(requests.map((r) => r.opts))}`);
    if (slept === 10_000) pass('fetch() waits the robots.txt Crawl-delay (10s) between pages, not before the first');
    else fail(`fetch() slept ${slept}ms`);
  }

  {
    const { value, lines } = await captureErrors(() => calopps.fetch({}, { sleep: async () => {}, fetchText: async () => EMPTY }));
    if (Array.isArray(value) && value.length === 0 && lines.length === 0) pass('an empty board returns [] without a warning');
    else fail(`empty board drift: ${JSON.stringify(value)} ${lines}`);
  }

  {
    let threw = false;
    try {
      await calopps.fetch({}, { sleep: async () => {}, fetchText: async () => fullPage(0).replace(/views-field-label/g, 'renamed') });
    } catch { threw = true; }
    if (threw) pass('fetch() throws when page 1 links postings but parses to nothing');
    else fail('a broken parser must not look like an empty board');
  }

  {
    const asked = [];
    const repeat = { sleep: async () => {}, fetchText: async (url) => { asked.push(url); return fullPage(0); } };
    await calopps.fetch({}, repeat);
    if (asked.length === 2) pass('fetch() stops once a page contributes no new posting');
    else fail(`repeat page drift: ${asked.length} requests`);
  }

  // ── Page limits: entry.max_pages configures, ctx.maxPages caps, MAX_PAGES_CAP clamps ──
  {
    const endless = (asked) => ({
      sleep: async () => {},
      fetchText: async (url) => { asked.push(url); return fullPage(Number(new URL(url).searchParams.get('page') ?? 0)); },
    });
    let asked = [];
    const capped = await captureErrors(() => calopps.fetch({ name: 'CalOpps', max_pages: 2 }, endless(asked)));
    if (asked.length === 2 && capped.lines.some((l) => l.includes('raise max_pages'))) pass('entry.max_pages stops the walk and a cap stop advises raising it');
    else fail(`max_pages drift: ${asked.length} requests, warnings ${JSON.stringify(capped.lines)}`);

    asked = [];
    const probe = await captureErrors(() => calopps.fetch({ max_pages: 5 }, { ...endless(asked), maxPages: 1 }));
    if (asked.length === 1 && probe.lines.length === 0) pass('ctx.maxPages: 1 makes exactly one list request and no cap warning');
    else fail(`probe drift: ${asked.length} requests, warnings ${JSON.stringify(probe.lines)}`);

    asked = [];
    await captureErrors(() => calopps.fetch({}, endless(asked)));
    if (asked.length === 40) pass('DEFAULT_MAX_PAGES (40) bounds an unconfigured entry');
    else fail(`default cap drift: ${asked.length}`);

    asked = [];
    await captureErrors(() => calopps.fetch({ max_pages: 999 }, endless(asked)));
    if (asked.length === 200) pass('an over-large max_pages is clamped to MAX_PAGES_CAP (200)');
    else fail(`MAX_PAGES_CAP drift: ${asked.length}`);
  }

  // ── Transient failure: later pages keep what was read; the probe propagates ──
  {
    const err503 = Object.assign(new Error('HTTP 503'), { status: 503 });
    const ctx = {
      sleep: async () => {},
      fetchText: async (url) => { if (url.includes('page=1')) throw err503; return fullPage(0); },
    };
    const { value, lines } = await captureErrors(() => calopps.fetch({ name: 'CalOpps' }, ctx));
    if (value.length === 25 && lines.some((l) => l.includes('truncated')) && !lines.some((l) => l.includes('raise max_pages'))) {
      pass('a page-2 failure keeps page 1, warns truncated, and does not advise raising max_pages');
    } else {
      fail(`truncation drift: ${value.length} jobs, ${JSON.stringify(lines)}`);
    }

    const probeErr = Object.assign(new Error('HTTP 404'), { status: 404 });
    let caught;
    try {
      await calopps.fetch({}, { maxPages: 1, sleep: async () => {}, fetchText: async () => { throw probeErr; } });
    } catch (e) { caught = e; }
    if (caught === probeErr) pass('a ctx.fetchText rejection under ctx.maxPages propagates unwrapped');
    else fail(`probe rejection drift: ${caught}`);
  }
} catch (e) {
  fail(`calopps provider test crashed: ${e.stack || e.message}`);
}
