// tests/prune-pipeline.test.mjs — pruning dead and stale entries out of the
// pending pipeline.
//
// The property that matters most here is the one that is easy to get wrong: a
// pruned line must still expose its URL to scan.mjs's dedup regex. The mode docs
// used to suggest a struck-through `~~url~~` form, which hides the URL from
// `- [x] (https?://\S+)` — the posting would then look brand new to the next
// scan and be re-added days after it was confirmed dead.
import { pass, fail } from './helpers.mjs';
import { planPrune } from '../prune-pipeline.mjs';
import { loadSeenUrls, normalizeUrlForDedup } from '../scan.mjs';

console.log('\nprune-pipeline — keeping the pending list applicable');

const DEAD = 'https://job-boards.greenhouse.io/axon/jobs/5414654003';
const LIVE = 'https://job-boards.greenhouse.io/axon/jobs/7826098003';

const pipeline = (extra = '') => `# Pipeline — Pending URLs

## Pending

- [ ] ${DEAD} | Axon | Data Solutions Engineer II | Scottsdale | posted: 2022-11-18
- [ ] ${LIVE} | Axon | Solutions Architect | New York | posted: 2026-08-04
${extra}
## Processed

- [x] https://example.com/old | Done
`;

const dead = new Map([[DEAD, { removed: '2026-08-20', evidence: 'greenhouse_api_gone' }]]);
const today = '2026-08-21';

// ── expired ──────────────────────────────────────────────────────────────────

const out = planPrune(pipeline(), dead, { today });
out.moved.length === 1 && out.moved[0].kind === 'expired' && out.pending === 1
  ? pass('a URL in the expired log is moved out of Pending')
  : fail(`expected 1 expired move, got ${JSON.stringify(out.moved)}`);

out.text.includes(`- [x] ${DEAD}`) && out.text.includes('expired (confirmed 2026-08-20, greenhouse_api_gone)')
  ? pass('the moved line carries the confirmation date and the evidence code')
  : fail('moved line is missing the reason');

// The regression this file exists for.
[...out.text.matchAll(/- \[[ x]\] (https?:\/\/\S+)/g)].some((m) => m[1] === DEAD)
  ? pass("the moved URL still matches scan.mjs's dedup regex (no strikethrough)")
  : fail('pruned URL is invisible to dedup — the next scan will re-add it');

out.text.includes(`- [ ] ${LIVE}`)
  ? pass('a live entry is left in Pending')
  : fail('a live entry was pruned');

// Idempotent: the second run has nothing left to move.
planPrune(out.text, dead, { today }).moved.length === 0
  ? pass('re-running finds nothing to move')
  : fail('prune is not idempotent');

// Tracking params differ between the pipeline line and the log; dedup
// normalization must still match them.
planPrune(
  pipeline(),
  new Map([[`${DEAD}?gh_src=abc`, { removed: '2026-08-20', evidence: '' }]]),
  { today }
).moved.length === 1
  ? pass('log and pipeline URLs match after dedup normalization')
  : fail('a tracking param defeated the match');

// ── stale ────────────────────────────────────────────────────────────────────

planPrune(pipeline(), new Map(), { today }).moved.length === 0
  ? pass('without --stale, an old-but-live posting is left alone')
  : fail('stale pruning ran without being asked for');

const staled = planPrune(pipeline(), new Map(), { today, staleDays: 60 });
staled.moved.length === 1 && staled.moved[0].url === DEAD && staled.moved[0].kind === 'stale'
  ? pass('--stale moves a posting older than the threshold')
  : fail(`stale prune wrong — ${JSON.stringify(staled.moved)}`);

staled.text.includes('stale (posted 2022-11-18,')
  ? pass('the stale line records the posted date and the threshold')
  : fail('stale reason missing');

// A line with no posted: date is a judgement we cannot make — leave it.
planPrune(
  `# P\n\n## Pending\n\n- [ ] https://example.com/1 | Acme | Engineer\n`,
  new Map(),
  { today, staleDays: 1 }
).moved.length === 0
  ? pass('an entry with no posted: date is never pruned as stale')
  : fail('pruned an entry with no posting date');

// ── file shape ───────────────────────────────────────────────────────────────

const noProcessed = planPrune(`# P\n\n## Pending\n\n- [ ] ${DEAD} | Axon\n`, dead, { today });
noProcessed.text.includes('## Processed') && noProcessed.text.includes(`- [x] ${DEAD}`)
  ? pass('a Processed section is created when the file has none')
  : fail('no Processed section was created');

planPrune('# P\n\nno sections here\n', dead, { today }).moved.length === 0
  ? pass('a file with no Pending section is left untouched')
  : fail('touched a file with no Pending section');

// ── the memory feedback loop ─────────────────────────────────────────────────
//
// scan.mjs must treat the expired log as a permanent skip list. Otherwise
// pruning a dead posting out of pipeline.md removes the only thing stopping the
// next scan from re-adding it.
const seenSrc = String(loadSeenUrls);
seenSrc.includes('EXPIRED_LOG_PATH') && seenSrc.includes('parseExpiredLog')
  ? pass('loadSeenUrls seeds dedup from the expired log')
  : fail('loadSeenUrls does not read the expired log — pruned dead URLs will come back');

normalizeUrlForDedup(`${DEAD}?gh_src=x`) === normalizeUrlForDedup(DEAD)
  ? pass('dedup normalization is shared between the log, the pipeline and the scanner')
  : fail('normalization mismatch between prune and scan');

// Scan runs append their own `## Targeted-company run — <date>` sections of
// `- [ ]` lines. Those are pending work too; only Processed is off limits.
const extraSection = planPrune(
  `# P\n\n## Pending\n\n- [ ] ${LIVE} | Axon\n\n## Targeted-company run — 2026-08-17\n\n- [ ] ${DEAD} | Axon\n\n## Processed\n\n- [x] https://example.com/old | Done\n`,
  dead,
  { today }
);
extraSection.moved.length === 1 && extraSection.pending === 1
  ? pass('entries in a later scan-run section are pruned too')
  : fail(`later-section entry was missed — ${JSON.stringify(extraSection.moved)}`);

extraSection.text.indexOf(`- [x] ${DEAD}`) > extraSection.text.indexOf('## Processed')
  ? pass('the moved entry lands under Processed, not in place')
  : fail('moved entry was not placed under Processed');
