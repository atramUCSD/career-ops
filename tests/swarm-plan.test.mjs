// tests/swarm-plan.test.mjs — the conductor's pure planning half.
//
// Everything asserted here runs with no child process, no model call and no
// network: parsing pending rows, attaching a lane, and choosing which rows fit
// the budget. Those are the decisions that decide where money goes, so they are
// the ones worth pinning.
import { pass, fail } from './helpers.mjs';
import { parsePendingRows, classifyRows, selectForEvaluation } from '../swarm.mjs';

console.log('\nswarm — triage plan');

const LANES = [
  { id: 'devrel', archetype: 'A', title_keywords: ['Developer Advocate'], max_evaluations: 2 },
  { id: 'gtm', archetype: 'B', title_keywords: ['GTM'], max_evaluations: 2 },
];

// ── parsing ──────────────────────────────────────────────────────────────────

const text = `# Pipeline

## Pending

- [ ] https://x.test/1
- [ ] https://x.test/2 | Acme | Developer Advocate | Remote (US) | posted: 2026-08-01
- [ ] https://x.test/3 | Beta | GTM Engineer | posted: 2026-07-01 | trust: 80
- [!] https://x.test/broken — Error: login required

## Processed

- [x] https://x.test/done | Gamma | Developer Advocate
`;

const rows = parsePendingRows(text);
rows.length === 3
  ? pass('only unchecked Pending rows are parsed (Processed and [!] rows excluded)')
  : fail(`expected 3 pending rows, got ${rows.length}`);

const r2 = rows[1];
r2.company === 'Acme' && r2.title === 'Developer Advocate' && r2.location === 'Remote (US)' && r2.posted === '2026-08-01'
  ? pass('a full 4-column row parses into company/title/location/posted')
  : fail(`bad parse: ${JSON.stringify(r2)}`);

// A labeled segment sits where a positional cell would: read positionally, the
// `posted:` cell becomes the location and everything after it shifts.
const r3 = rows[2];
r3.title === 'GTM Engineer' && r3.location === '' && r3.posted === '2026-07-01'
  ? pass('labeled segments do not shift the positional cells')
  : fail(`labeled segment shifted the row: ${JSON.stringify(r3)}`);

rows[0].url === 'https://x.test/1' && rows[0].title === ''
  ? pass('a bare pasted URL parses with empty metadata')
  : fail(`bad parse of a bare URL: ${JSON.stringify(rows[0])}`);

// ── classification ───────────────────────────────────────────────────────────

const classified = classifyRows(rows, LANES);
classified.map(r => r.lane).join(',') === 'core,devrel,gtm'
  ? pass('rows are classified into lanes, unclaimed rows into core')
  : fail(`unexpected lanes: ${classified.map(r => r.lane).join(',')}`);

// ── selection ────────────────────────────────────────────────────────────────

const many = [];
for (let i = 0; i < 10; i++) many.push({ url: `https://d.test/${i}`, title: 'Developer Advocate', posted: `2026-08-${String(10 + i).padStart(2, '0')}` });
for (let i = 0; i < 10; i++) many.push({ url: `https://g.test/${i}`, title: 'GTM Engineer', posted: `2026-08-${String(10 + i).padStart(2, '0')}` });
for (let i = 0; i < 10; i++) many.push({ url: `https://c.test/${i}`, title: 'Frontend Engineer', posted: `2026-08-${String(10 + i).padStart(2, '0')}` });
const pool = classifyRows(many, LANES);

const picked = selectForEvaluation(pool, { maxEvals: 8, lanes: LANES });
picked.length === 8
  ? pass('the global --max-evals cap holds')
  : fail(`expected 8 picks, got ${picked.length}`);

const perLane = picked.reduce((acc, r) => (acc[r.lane] = (acc[r.lane] || 0) + 1, acc), {});
perLane.devrel === 2 && perLane.gtm === 2
  ? pass('each lane stops at its own max_evaluations')
  : fail(`per-lane caps broken: ${JSON.stringify(perLane)}`);

perLane.core === 4
  ? pass('the remaining budget spills into core rather than going unspent')
  : fail(`expected 4 core picks, got ${perLane.core}`);

picked.filter(r => r.lane === 'devrel').every(r => r.posted >= '2026-08-18')
  ? pass('within a lane the freshest postings are taken first')
  : fail('a stale posting was taken over a fresher one');

// A budget smaller than the number of lanes must still touch every lane, or the
// last lane in the file never gets evaluated at all.
const tight = selectForEvaluation(pool, { maxEvals: 3, lanes: LANES });
new Set(tight.map(r => r.lane)).size === 3
  ? pass('a tight budget interleaves lanes instead of draining the first one')
  : fail(`a lane was starved: ${tight.map(r => r.lane).join(',')}`);

JSON.stringify(selectForEvaluation(pool, { maxEvals: 8, lanes: LANES })) === JSON.stringify(picked)
  ? pass('selection is stable — a resumed run dispatches the same set')
  : fail('selection is not deterministic');

// Fewer rows than budget must terminate, not spin.
selectForEvaluation(classifyRows(rows, LANES), { maxEvals: 100, lanes: LANES }).length === 3
  ? pass('a budget larger than the pool returns the whole pool')
  : fail('an oversized budget did not return every row');
