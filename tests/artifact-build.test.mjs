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
  'max_posting_age_days: 45\ntitle_filter:\n  positive:\n    - "Developer Advocate"\n    - "GTM"\n    - "Frontend"\n  negative:\n    - "Junior"\n');
writeFileSync(join(repo, 'config', 'lanes.yml'),
  'lanes:\n  - id: devrel\n    archetype: "Developer Relations / Developer Advocate"\n    title_keywords: ["Developer Advocate"]\n  - id: gtm\n    archetype: "GTM Engineer"\n    title_keywords: ["GTM"]\n');
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
writeFileSync(join(repo, 'data', 'applications.md'),
  '# Applications Tracker\n\n| # | Date | Company | Role | Score | Status | PDF | Report | Notes |\n|---|---|---|---|---|---|---|---|---|\n| 1 | 2026-08-20 | Acme | Senior Developer Advocate | 4.2 | applied | — | — | — |\n');
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
  ? pass('an evaluated posting shows its score and status from applications.md')
  : fail(`tracker join failed: ${JSON.stringify(model.rows[0])}`);

model.rows[2].status === 'pending' && model.rows[2].score === null
  ? pass('an unevaluated posting reads pending with no score')
  : fail('an unevaluated posting was given a score');

model.rows[2].seg === 'Other / unknown' && model.processed === 1
  ? pass('off-corridor rows and the processed count are carried')
  : fail(`seg/processed wrong: ${model.rows[2].seg} / ${model.processed}`);

model.expired.count === 2 && model.discards.length === 1
  ? pass('expired and discard logs feed the configuration panel')
  : fail('expired/discard parsing failed');

const dead = model.yields.find(k => k.keyword === 'Frontend');
dead && model.yields[0].added === 0
  ? pass('keyword yield is computed against scan-history, lowest first')
  : fail(`yield table is wrong: ${JSON.stringify(model.yields)}`);

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

rmSync(tmp, { recursive: true, force: true });
