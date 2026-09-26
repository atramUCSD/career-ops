// tests/artifact-build.test.mjs — the page must stay a build output.
//
// The bug these pin is the one the artifact already had once: a page whose
// rows were typed by hand, so it silently disagreed with the pipeline it
// claimed to show. Everything here runs on a fixture repo — no network, no
// model, no writes outside a temp dir.
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { pass, fail } from './helpers.mjs';
import { buildModel, renderHtml, segmentFor, freshnessBands, bandFor, keywordYield } from '../build-artifact.mjs';

console.log('\nartifact — generated pipeline page');

// ── pure helpers ─────────────────────────────────────────────────────────────

segmentFor('San Diego, CA') === 'San Diego' && segmentFor('Remote, US') === 'Remote'
  ? pass('locations bucket into corridor segments')
  : fail('segment bucketing is wrong');

segmentFor('Austin, TX') === 'Other / unknown'
  ? pass('an off-corridor location gets a visible bucket, not a silent drop')
  : fail('an off-corridor location was not bucketed');

// The old page hardcoded 14/45/120/365 while portals.yml said 45. Bands are
// derived now, so the two can no longer disagree.
const bands = freshnessBands(45);
bands.map(b => b.id).join(',') === '≤7d,≤14d,≤30d,≤45d,46d+'
  ? pass('freshness bands derive from max_posting_age_days')
  : fail(`unexpected bands: ${bands.map(b => b.id).join(',')}`);

freshnessBands(30).map(b => b.id).join(',') === '≤7d,≤14d,≤30d,31d+'
  ? pass('a narrower scan window collapses the duplicate band instead of repeating it')
  : fail(`bands did not dedupe: ${freshnessBands(30).map(b => b.id).join(',')}`);

bandFor(null, bands) === 'unknown' && bandFor(3, bands) === '≤7d' && bandFor(900, bands) === '46d+'
  ? pass('ages map to bands, and a missing date is its own band')
  : fail('band assignment is wrong');

const y = keywordYield(
  ['Frontend', 'React'],
  [{ title: 'Frontend Engineer' }, { title: 'React Frontend Engineer' }, { title: 'Rapid Reaction Lead' }],
  [],
);
const react = y.find(k => k.keyword === 'React');
react.added === 2 && react.unique === 1 && react.sample === 'Rapid Reaction Lead'
  ? pass('unique yield isolates what only one keyword caught, substring noise included')
  : fail(`bad yield: ${JSON.stringify(react)}`);

// ── the model, over a fixture repo ───────────────────────────────────────────

const tmp = mkdtempSync(join(tmpdir(), 'artifact-test-'));
const repo = join(tmp, 'repo');
mkdirSync(join(repo, 'data'), { recursive: true });
mkdirSync(join(repo, 'config'), { recursive: true });
writeFileSync(join(repo, 'portals.yml'),
  'max_posting_age_days: 45\ntitle_filter:\n  positive:\n    - "Developer Advocate"\n    - "GTM"\n    - "Frontend"\n    - "Solutions Architect"\n  negative:\n    - "Junior"\n');
writeFileSync(join(repo, 'config', 'lanes.yml'),
  'lanes:\n  - id: devrel\n    archetype: "Developer Relations / Developer Advocate"\n    title_keywords: ["Developer Advocate"]\n    max_evaluations: 5\n  - id: gtm\n    archetype: "GTM Engineer"\n    title_keywords: ["GTM"]\n');
writeFileSync(join(repo, 'config', 'profile.yml'),
  'candidate:\n  full_name: Test Person\n  location: Remote\ntarget_roles:\n  primary:\n    - Developer Advocate\n  archetypes: []\ncompensation:\n  minimum: "$130K"\n  currency: USD\n');
writeFileSync(join(repo, 'data', 'pipeline.md'), `# Pipeline

## Pending

- [ ] https://x.test/1 | Acme | Senior Developer Advocate | San Diego, CA | posted: 2026-08-18
- [ ] https://x.test/2 | Beta <script> | GTM Engineer | Remote, US
- [ ] https://x.test/3 | Gamma | Frontend Engineer | Austin, TX | posted: 2026-06-01

## Processed

- [x] https://x.test/done | Delta | Frontend Engineer
`);
writeFileSync(join(repo, 'data', 'scan-history.tsv'),
  'url\tfirst_seen\tportal\ttitle\tcompany\tstatus\tlocation\tfingerprint\tposted_at\ttrust_score\ttrust_flags\n' +
  'https://x.test/2\t2026-08-01\tgreenhouse\tGTM Engineer\tBeta\tadded\tRemote\tf1\t2026-08-11\t72\tno_comp\n' +
  'https://x.test/9\t2026-08-01\tlever\tFrontend Engineer\tZeta\tadded\tRemote\tf2\t2026-07-01\t\t\n');
// The tracker carries an EXTRA inserted Location column (#946) on purpose:
// positional parsing would read Location as the score and the score as the
// status, so the tracker-join assertions below fail on any non-header-aware
// reader.
writeFileSync(join(repo, 'data', 'applications.md'),
  '# Applications Tracker\n\n| # | Date | Company | Role | Location | Score | Status | PDF | Report | Notes |\n|---|---|---|---|---|---|---|---|---|---|\n| 1 | 2026-08-20 | Acme | Senior Developer Advocate | San Diego, CA | 4.2 | applied | — | — | — |\n');
writeFileSync(join(repo, 'data', 'expired-jobs.md'),
  '# Expired Jobs\n\n_2 postings recorded._\n\n| Removed (est.) | Company | Title | Posted | Source | Evidence | URL |\n|---|---|---|---|---|---|---|\n| 2026-08-21 | Acme | Old Role | — | api | greenhouse_api_gone | https://x.test/gone |\n');
writeFileSync(join(repo, 'data', 'discard.log'),
  '2026-08-21T00:00:00Z\thttps://x.test/junk\ttitle-filter cleanup: matched only a removed keyword\n');

const model = buildModel({ root: repo, now: new Date('2026-08-21T00:00:00Z') });

model.rows.length === 3
  ? pass('every pending row reaches the page — the count cannot drift from pipeline.md')
  : fail(`expected 3 rows, got ${model.rows.length}`);

model.rows.every(r => r.lane)
  ? pass('every row carries a lane')
  : fail('a row reached the page with no lane');

model.rows.map(r => r.lane).join(',') === 'devrel,gtm,core'
  ? pass('lanes are assigned from the matched title keyword')
  : fail(`unexpected lanes: ${model.rows.map(r => r.lane).join(',')}`);

// The pipeline row for x.test/2 has no `posted:`; scan-history does. Without
// this backfill a fifth of the live rows would read "unknown" while the date
// sat one file over.
model.rows[1].p === '2026-08-11' && model.rows[1].age === 10
  ? pass('a missing posted date is backfilled from scan-history')
  : fail(`backfill failed: ${JSON.stringify({ p: model.rows[1].p, age: model.rows[1].age })}`);

model.rows[1].trust === 72 && model.hasTrust
  ? pass('trust score is read from scan-history and enables the column')
  : fail('trust score was not picked up');

model.rows[0].score === 4.2 && model.rows[0].status === 'applied'
  ? pass('an evaluated posting shows its score and status despite an inserted tracker column')
  : fail(`tracker join failed: ${JSON.stringify(model.rows[0])}`);

model.rows[2].status === 'pending' && model.rows[2].score === null
  ? pass('an unevaluated posting reads pending with no score')
  : fail('an unevaluated posting was given a score');

model.rows[2].seg === 'Other / unknown' && model.processed === 1
  ? pass('off-corridor rows and the processed count are carried')
  : fail(`seg/processed wrong: ${model.rows[2].seg} / ${model.processed}`);

// The fixture's prose claims "_2 postings recorded._" while the table holds
// one row — deliberate: the count must come from the rows (a hand-deleted row
// stays deleted; expired-log.mjs regenerates the prose from the table anyway).
model.expired.count === 1 && model.discards.length === 1
  ? pass('expired count derives from table rows, not the prose sentence')
  : fail(`expired/discard parsing failed: count=${model.expired.count}`);

const dead = model.yields.find(k => k.keyword === 'Frontend');
dead && model.yields[0].added === 0
  ? pass('keyword yield is computed against scan-history, lowest first')
  : fail(`yield table is wrong: ${JSON.stringify(model.yields)}`);

model.dead.length === 1 && model.dead[0] === 'Solutions Architect'
  ? pass('a positive keyword no pending row matched is listed as dead')
  : fail(`dead keywords wrong: ${JSON.stringify(model.dead)}`);

model.who.primary.join(',') === 'Developer Advocate' && model.who.currency === 'USD'
  ? pass('the model carries the profile primary targets and comp currency')
  : fail(`who.primary/currency wrong: ${JSON.stringify(model.who)}`);

model.lanes.find(l => l.id === 'devrel').max === 5 && model.lanes.find(l => l.id === 'gtm').max === null
  ? pass('a lane evaluation cap is carried, and its absence stays null')
  : fail(`lane max wrong: ${JSON.stringify(model.lanes)}`);

model.rows[0].kw.includes('Developer Advocate') && model.rows[1].portal === 'greenhouse'
  ? pass('rows carry the lane keyword that claimed them and the ingestion portal')
  : fail(`kw/portal wrong: ${JSON.stringify({ kw: model.rows[0].kw, portal: model.rows[1].portal })}`);

model.rows[0].family === 'primary' && model.rows[1].family === 'lane' && model.rows[2].family === 'unmatched'
  ? pass("rows carry the scorer's own title-family verdict")
  : fail(`family wrong: ${model.rows.map(r => r.family).join(',')}`);

model.expired.rows[0].title === 'Old Role' && model.discards[0].url === 'https://x.test/junk'
  ? pass('expired rows keep their title and discards keep their URL')
  : fail(`expired title / discard url missing: ${JSON.stringify({ e: model.expired.rows[0], d: model.discards[0] })}`);

// ── rendering ────────────────────────────────────────────────────────────────

const html = renderHtml(model);

!html.includes('<script>') || html.split('<script>').length === 2
  ? pass('the page carries exactly one script block')
  : fail('unexpected script blocks in the output');

// A company literally named `Beta <script>` must not be able to close the data
// blob or inject a tag — the rows come from scraped third-party text.
!/Beta <script>/.test(html) && html.includes('Beta \\u003cscript>')
  ? pass('scraped text is escaped inside the embedded JSON')
  : fail('a job field escaped the JSON blob unescaped');

html.includes('<title>Corridor Pipeline</title>') && html.includes('prefers-color-scheme: dark')
  ? pass('title and the dark-theme block are present')
  : fail('title or theme block missing');

!/<!doctype|<html|<head>|<body>/i.test(html)
  ? pass('no document skeleton — the artifact host supplies it')
  : fail('the page emitted its own document skeleton');

// The render side of each newly exposed field. The model rides into the page
// as one JSON blob, so a field can be "carried" yet never shown — these pin
// the markup that actually displays it.
['Title family', 'Lane keywords', 'Ingestion portal'].every(s => html.includes(s))
  ? pass('the row drawer renders family, lane keywords and portal')
  : fail('drawer classification block missing');

html.includes('<th>Title</th>') && html.includes('${esc(r.title)}')
  ? pass('the expired table renders a Title column')
  : fail('expired title column missing');

html.includes('href="${esc(d.url)}"')
  ? pass('discards render their URL as a link')
  : fail('discard URL link missing');

html.includes('Eval cap') && html.includes("${l.max ?? '—'}")
  ? pass('the lanes table renders the evaluation cap')
  : fail('lane cap column missing');

html.includes('Primary targets') && html.includes('esc(W.currency)')
  ? pass('the profile panel renders primary targets and the comp currency')
  : fail('who.primary / who.currency not rendered');

html.includes('${M.processed}</b> rows already processed') && html.includes('dead keyword')
  ? pass('coverage renders the processed count and the dead-keyword list')
  : fail('processed / dead not rendered');

html.includes('"dead":["Solutions Architect"]')
  ? pass('the embedded JSON carries the dead keyword the page lists')
  : fail('dead keywords absent from the data blob');

// ── charts ───────────────────────────────────────────────────────────────────
// Server-rendered from the model through web/src/lib/chart-geometry.mjs.
// These pin presence and wiring; the geometry itself is unit-tested in
// web/tests/lib/chart-geometry.test.mjs.

const fn = model.funnel;
fn[0].n === 2 && fn[1].n === 3
  && fn.find(s => s.label === 'Applied').n === 1
  && fn.find(s => s.label === 'Reached interview').n === 0
  && fn.find(s => s.label === 'Offer').n === 0
  ? pass('funnel stages count scanner-added, pending and the tracker tail')
  : fail(`funnel wrong: ${JSON.stringify(fn)}`);

model.channelSeries.length === 2
  && model.channelSeries.every(c => c.weeks.length === 12 && c.total === 1)
  ? pass('channel series bucket scan-history additions into shared 12-week rows')
  : fail(`channelSeries wrong: ${JSON.stringify(model.channelSeries)}`);

model.jd.gates.every(g => typeof g.w === 'number')
  ? pass('gate reasons carry a bar width computed by the shared geometry')
  : fail(`gate widths missing: ${JSON.stringify(model.jd.gates)}`);

(html.match(/role="img"/g) || []).length >= 6
  ? pass('every chart carries role="img" with an aria-label takeaway')
  : fail(`too few role="img" charts: ${(html.match(/role="img"/g) || []).length}`);

html.includes('Progress funnel') && /too small to read as rates/.test(html)
  ? pass('the funnel renders as baseline bars with the small-n caveat')
  : fail('funnel or its small-n caveat missing');

html.includes('id="cbhist"') && html.includes('data-cbband="strong"')
  ? pass('the score histogram renders with band regions')
  : fail('histogram or its band regions missing');

html.includes("chip.click(); selectTab('pipeline'")
  ? pass('a histogram band click forwards to the existing cbband chip wiring')
  : fail('histogram click is not wired through the existing filter');

html.includes('Age mix by match band') && html.includes('class="strips"')
  ? pass('the age-by-band strips render')
  : fail('age strips missing');

html.includes('class="hbars sparks"') && html.includes('<path d="M')
  ? pass('channel sparklines render as SVG paths')
  : fail('sparklines missing');

// The shared y-scale itself: with peaks of 4 and 2, the quiet channel's peak
// must render at half height (y=10 of 20) and only the busy channel may touch
// the top (y=0). A per-row rescale — the mutation this pins — puts both peaks
// at y=0 and no other assertion notices.
const sparkHtml = renderHtml({
  ...model,
  channelSeries: [
    { portal: 'busy', weeks: [0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 4], total: 4 },
    { portal: 'quiet', weeks: [0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 2], total: 2 },
  ],
});
const sparkPath = p => (sparkHtml.match(new RegExp(`mono">${p}</span><svg class="spark"[^>]*><path d="([^"]*)"`)) || [])[1] || '';
sparkPath('busy').endsWith('120,0') && sparkPath('quiet').endsWith('120,10')
  ? pass('a quiet channel keeps the shared y-scale instead of rescaling to its own peak')
  : fail(`sparkline scale not shared: busy="${sparkPath('busy')}" quiet="${sparkPath('quiet')}"`);

html.includes('Pending rows by channel and age') && html.includes('color-mix(in srgb, var(--accent)')
  ? pass('the heatmap renders as a shaded table off the accent token')
  : fail('heatmap missing or shading is not token-based');

html.includes('Company concentration')
  ? pass('company concentration bars render')
  : fail('company concentration missing');

html.includes('${g.w||0}%')
  ? pass('the gate table extends the .pct bar pattern with model widths')
  : fail('gate bars missing from the gate table');

// Charts are additions: the tables they sit next to must all still be there.
['Rule that fired', 'Keyword yield', 'Every channel that has produced a row'].every(s => html.includes(s))
  ? pass('the underlying tables survive alongside the charts')
  : fail('a chart replaced its table');

// ── analytics panels — degrade path on the sparse fixture ────────────────────
// repo has no scan-runs, alert-log, salary observations or linked reports:
// every analytics field must read absent, and the build must not throw.

model.runStats === null && model.alerts.length === 0 && model.salary === null && model.upskill === null
  ? pass('missing analytics side files degrade to null/empty, never throw')
  : fail(`degrade path wrong: ${JSON.stringify({ runStats: model.runStats, alerts: model.alerts.length, salary: model.salary, upskill: model.upskill })}`);

model.patterns && model.patterns.error && /Not enough data/.test(model.patterns.error)
  ? pass('analyze-patterns carries its own not-enough-data verdict instead of hiding it')
  : fail(`patterns error missing: ${JSON.stringify(model.patterns)}`);

model.velocity && model.velocity.hops.length === 4 && model.velocity.waiting.inFlight === 1
  ? pass('funnel-velocity folds the tracker even without a status log')
  : fail(`velocity wrong: ${JSON.stringify(model.velocity)}`);

// ── analytics panels — populated, on their own fixture repo ──────────────────
// A second repo so the counts the S5 chart assertions pin (history.added,
// channelSeries) stay untouched by the extra scan-history rows a repost
// cluster needs.

const repo2 = join(tmp, 'repo2');
mkdirSync(join(repo2, 'data'), { recursive: true });
mkdirSync(join(repo2, 'config'), { recursive: true });
mkdirSync(join(repo2, 'reports'), { recursive: true });
writeFileSync(join(repo2, 'portals.yml'),
  'max_posting_age_days: 45\ntitle_filter:\n  positive:\n    - "Developer Advocate"\n');
writeFileSync(join(repo2, 'config', 'lanes.yml'),
  'lanes:\n  - id: devrel\n    archetype: "Developer Relations"\n    title_keywords: ["Developer Advocate"]\n');
writeFileSync(join(repo2, 'config', 'profile.yml'),
  'candidate:\n  full_name: Test Person\ntarget_roles:\n  primary:\n    - Developer Advocate\n  archetypes: []\ncompensation:\n  minimum: "$130K"\n  target_range: "$150K"\n  currency: USD\n');
writeFileSync(join(repo2, 'data', 'pipeline.md'),
  '# Pipeline\n\n## Pending\n\n- [ ] https://x.test/a1 | Acme | Senior Developer Advocate | Remote, US | posted: 2026-08-15\n');
// Two `added` appearances of the same company+title, 45 days apart: a repost
// cluster inside the 90-day window.
writeFileSync(join(repo2, 'data', 'scan-history.tsv'),
  'url\tfirst_seen\tportal\ttitle\tcompany\tstatus\tlocation\tfingerprint\tposted_at\ttrust_score\ttrust_flags\n' +
  'https://x.test/a1\t2026-07-01\tgreenhouse\tSenior Developer Advocate\tAcme\tadded\tRemote\tf1\t\t\t\n' +
  'https://x.test/a2\t2026-08-15\tgreenhouse\tSenior Developer Advocate\tAcme\tadded\tRemote\tf2\t\t\t\n');
writeFileSync(join(repo2, 'data', 'applications.md'),
  '# Applications Tracker\n\n| # | Date | Company | Role | Score | Status | PDF | Report | Notes |\n|---|---|---|---|---|---|---|---|---|\n| 1 | 2026-08-01 | Acme | Senior Developer Advocate | 2.5 | applied | — | [r](../reports/001-acme.md) | — |\n');
// Low-fit report naming two gap skills; no Machine Summary needed — the Global
// row and the Gap/Severity table are the legacy path parseReportGaps reads.
writeFileSync(join(repo2, 'reports', '001-acme.md'),
  '# Acme — Senior Developer Advocate\n\n| Axis | Score |\n|---|---|\n| Global | 2.5/5 |\n\n| Gap | Severity | Note |\n|---|---|---|\n| Kubernetes | High | required |\n| Terraform | Medium | preferred |\n\n');
writeFileSync(join(repo2, 'data', 'salary-observations.tsv'),
  '# num\tdate\ttype\tamount\tcurrency\tsource\tnote\n' +
  '1\t2026-08-01\tadvertised\t$140K\tUSD\tjd\tfrom posting\n' +
  '1\t2026-08-10\tactual\t$150K\tUSD\toffer-letter\toffer\n');
writeFileSync(join(repo2, 'data', 'scan-runs.tsv'),
  'timestamp\tstatus\tcompanies\tboards\tfound\tfiltered_title\tfiltered_tier\tfiltered_location\tfiltered_salary\tfiltered_content\tfiltered_cooldown\tdupes\tnew_added\terrors\n' +
  '2026-08-01T08:00:00Z\tcompleted\t45\t3\t100\t30\t5\t20\t2\t6\t1\t30\t6\t0\n' +
  '2026-08-08T08:00:00Z\tcompleted\t45\t3\t140\t50\t5\t20\t2\t6\t1\t46\t10\t1\n' +
  '2026-08-15T08:00:00Z\tfailed\t45\t3\t0\t0\t0\t0\t0\t0\t0\t0\t0\t1\n');
writeFileSync(join(repo2, 'data', 'alert-log.tsv'),
  'when\tstage\tresult\n' +
  '2026-08-15T06:00:00Z\ttriage\tok\n' +
  '2026-08-15T06:01:00Z\tartifact\tok\n' +
  '2026-08-15T06:02:00Z\talert\tFAILED - state left untouched, next run re-alerts\n');

const model2 = buildModel({ root: repo2, now: new Date('2026-08-21T00:00:00Z') });

model2.runStats && model2.runStats.totalRuns === 3 && model2.runStats.failedRuns === 1
  && model2.runStats.runs.length === 3 && model2.runStats.runs[0].newAdded === 6
  ? pass('scan-runs.tsv folds into run stats plus the per-run series')
  : fail(`runStats wrong: ${JSON.stringify(model2.runStats)}`);

model2.alerts.length === 3 && model2.alerts.filter(a => !a.ok).length === 1
  && model2.alerts[2].stage === 'alert'
  ? pass('alert-log.tsv becomes the hydration-reliability timeline')
  : fail(`alerts wrong: ${JSON.stringify(model2.alerts)}`);

model2.reposts.scanned && model2.reposts.clusters.length === 1
  && model2.reposts.clusters[0].company === 'Acme' && model2.reposts.clusters[0].n === 2
  ? pass('a repeated company+title in scan-history surfaces as a repost cluster')
  : fail(`reposts wrong: ${JSON.stringify(model2.reposts)}`);

model2.companyCards['Acme'] && model2.companyCards['Acme'].churn === 'reposts-detected'
  && model2.companyCards['Acme'].clusters.length === 1
  ? pass('the pipeline company gets a company-history card with its churn verdict')
  : fail(`companyCards wrong: ${JSON.stringify(model2.companyCards)}`);

model2.salary && model2.salary.applications.length === 1
  && model2.salary.applications[0].advToActPct !== null
  && model2.salary.byCurrency.USD.confirmed === 1
  ? pass('salary observations fold into an advertised-vs-actual trail')
  : fail(`salary wrong: ${JSON.stringify(model2.salary)}`);

model2.upskill && model2.upskill.reports === 1
  && model2.upskill.gaps.some(g => /kubernetes/i.test(g.skill))
  ? pass('linked evaluation reports aggregate into named skill gaps')
  : fail(`upskill wrong: ${JSON.stringify(model2.upskill)}`);

model2.patterns && model2.patterns.error
  ? pass('patterns on a one-row tracker reports not-enough-data, not a crash')
  : fail(`patterns wrong: ${JSON.stringify(model2.patterns)}`);

const html2 = renderHtml(model2);

['Scanner runs — new postings per run', 'Hydration reliability — alert log', 'Repost patterns',
 'Salary — advertised vs actual', 'Skill gaps named by evaluation reports', 'Outcome patterns',
 'Stage velocity', 'Waiting on a reply'].every(t => html2.includes(t))
  ? pass('every analytics panel renders its section')
  : fail('an analytics section is missing from the rendered page');

/right-censored/.test(html2)
  ? pass('the right-censoring caveat is rendered on the page, not laundered away')
  : fail('right-censoring caveat missing');

html2.includes('id="panel-outcomes"') && html2.includes("{ id: 'outcomes', label: 'Outcomes'")
  ? pass('the Outcomes tab and panel exist')
  : fail('Outcomes tab/panel missing');

html2.includes('Company history') && html2.includes('M.companyCards')
  ? pass('the row drawer renders the company-history card')
  : fail('drawer company-history block missing');

html2.includes('class="alertstrip"') && html2.includes('FAILED - state left untouched')
  ? pass('the alert strip renders cells and names the failing stage result')
  : fail('alert strip missing or failure detail hidden');

rmSync(tmp, { recursive: true, force: true });
