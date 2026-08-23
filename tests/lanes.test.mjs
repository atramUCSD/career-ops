// tests/lanes.test.mjs — role families as a checked contract.
//
// The bug these tests pin is the expensive one: a family registered on the scan
// side but not on the evaluation side. The postings arrive, get scored as some
// other archetype, and the report reads perfectly plausibly — nothing about the
// output says "this was judged as the wrong kind of job".
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { pass, fail } from './helpers.mjs';
import { loadLanes, laneForTitle, laneGate, checkLaneRegistration, LANES_PATH } from '../lanes.mjs';

console.log('\nlanes — role families as a checked contract');

const LANES = [
  {
    id: 'devrel',
    archetype: 'Developer Relations / Developer Advocate',
    title_keywords: ['Developer Relations', 'Developer Advocate', 'DevRel'],
    jd_gate: { positive: ['community', 'documentation'], negative: ['quota'] },
    max_evaluations: 2,
  },
  {
    id: 'tcsm',
    archetype: 'Technical Customer Success Manager',
    title_keywords: ['Customer Success', 'Technical Account Manager'],
    max_evaluations: 3,
  },
  {
    id: 'gtm',
    archetype: 'GTM Engineer',
    title_keywords: ['GTM', 'RevOps'],
  },
];

// ── classification ───────────────────────────────────────────────────────────

laneForTitle('Senior Developer Advocate', LANES)?.id === 'devrel'
  ? pass('"Senior Developer Advocate" lands in devrel')
  : fail('devrel did not claim "Senior Developer Advocate"');

laneForTitle('Technical Account Manager', LANES)?.id === 'tcsm'
  ? pass('"Technical Account Manager" lands in tcsm')
  : fail('tcsm did not claim "Technical Account Manager"');

laneForTitle('Staff Frontend Engineer', LANES) === null
  ? pass('an unrelated title claims no lane')
  : fail('a lane claimed "Staff Frontend Engineer"');

// GTM is 3 letters, so scan.mjs compiles it to a word-boundary regex. If lanes
// ever stopped reusing compileKeyword, this fires: plain substring matching puts
// every "Algorithm" title into the gtm lane.
laneForTitle('GTM Engineer', LANES)?.id === 'gtm'
  ? pass('"GTM Engineer" lands in gtm')
  : fail('gtm did not claim "GTM Engineer"');

laneForTitle('Algorithm Engineer', LANES) === null
  ? pass('"GTM" does not fire inside "Algorithm" (word-boundary matching preserved)')
  : fail('"GTM" matched as a substring — compileKeyword semantics were lost');

// ── jd gate ──────────────────────────────────────────────────────────────────

laneGate('You will build community programs and write documentation.', LANES[0]).pass
  ? pass('the devrel gate accepts a community/docs JD')
  : fail('the devrel gate rejected a matching JD');

laneGate('Own a quota and grow the developer community.', LANES[0]).pass === false
  ? pass('one negative term rejects, even with positives present')
  : fail('a negative gate term did not reject');

laneGate('Manage stakeholders and run the weekly sync.', LANES[0]).pass === false
  ? pass('a JD with no positive term is rejected')
  : fail('a JD with no positive term passed the gate');

laneGate('anything at all', LANES[1]).pass
  ? pass('a lane with no jd_gate accepts everything')
  : fail('a lane with no jd_gate rejected a JD');

// ── validation ───────────────────────────────────────────────────────────────

const tmp = mkdtempSync(join(tmpdir(), 'lanes-test-'));
const write = (name, body) => { const p = join(tmp, name); writeFileSync(p, body); return p; };

try {
  loadLanes(write('dupes.yml', 'lanes:\n  - id: a\n    archetype: A\n    title_keywords: ["x"]\n  - id: a\n    archetype: B\n    title_keywords: ["y"]\n'));
  fail('a duplicate lane id was accepted');
} catch (e) {
  /duplicate lane id/.test(e.message) ? pass('a duplicate lane id is rejected') : fail(`wrong error: ${e.message}`);
}

try {
  loadLanes(write('noarch.yml', 'lanes:\n  - id: a\n    title_keywords: ["x"]\n'));
  fail('a lane with no archetype was accepted');
} catch (e) {
  /archetype/.test(e.message) ? pass('a lane with no archetype is rejected') : fail(`wrong error: ${e.message}`);
}

loadLanes(join(tmp, 'does-not-exist.yml')).length === 0
  ? pass('a missing lanes.yml is an empty lane list, not a crash')
  : fail('a missing lanes.yml did not return []');

// ── registration drift ───────────────────────────────────────────────────────

// A fixture repo where devrel is registered on the scan side and nowhere else —
// the exact shape of the DevRel-scored-as-AI-Platform bug.
const fixture = join(tmp, 'repo');
mkdirSync(join(fixture, 'modes'), { recursive: true });
mkdirSync(join(fixture, 'batch'), { recursive: true });
mkdirSync(join(fixture, 'config'), { recursive: true });
writeFileSync(join(fixture, 'portals.yml'),
  'title_filter:\n  positive:\n    - "Developer Relations"\n    - "Developer Advocate"\n    - "DevRel"\n  negative:\n    - "Junior"\n');
writeFileSync(join(fixture, 'modes', '_profile.md'), '| **Developer Relations / Developer Advocate** | ... |\n');
writeFileSync(join(fixture, 'modes', '_shared.md'), '| AI Platform | ... |\n');
writeFileSync(join(fixture, 'batch', 'batch-prompt.md'), '| AI Platform | ... |\n');
writeFileSync(join(fixture, 'config', 'profile.yml'), 'target_roles:\n  archetypes:\n    - name: "AI Platform"\n');

const drift = checkLaneRegistration([LANES[0]], { root: fixture });
const missingSites = drift.filter(f => f.severity === 'error').map(f => f.site).sort();
JSON.stringify(missingSites) === JSON.stringify(['batch/batch-prompt.md', 'config/profile.yml', 'modes/_shared.md'])
  ? pass('an archetype missing from the evaluation-side files is reported at every site')
  : fail(`unexpected drift report: ${JSON.stringify(drift, null, 1)}`);

drift.some(f => f.site === 'modes/_profile.md')
  ? fail('a site that DOES carry the archetype was reported as drift')
  : pass('a correctly registered site produces no finding');

// The "Account Manager" trap: negatives are absolute in buildTitleFilter
// (hasPositive && !hasNegative), so one stray negative silently nullifies a
// whole lane no matter how many positives it has.
writeFileSync(join(fixture, 'portals.yml'),
  'title_filter:\n  positive:\n    - "Technical Account Manager"\n  negative:\n    - "Account Manager"\n');
const blocked = checkLaneRegistration(
  [{ id: 'tcsm', archetype: 'Technical Customer Success Manager', title_keywords: ['Technical Account Manager'] }],
  { root: fixture },
);
blocked.some(f => f.site === 'portals.yml' && /blocked by a title_filter.negative/.test(f.message))
  ? pass('a positive keyword nullified by a negative is reported')
  : fail(`the negative-shadowing trap was not caught: ${JSON.stringify(blocked, null, 1)}`);

// ── the real config, when the user has one ───────────────────────────────────

const realLanes = loadLanes(LANES_PATH);
if (realLanes.length === 0) {
  pass('no config/lanes.yml in this checkout — registration check skipped (expected on a clean clone)');
} else {
  const realErrors = checkLaneRegistration(realLanes).filter(f => f.severity === 'error');
  realErrors.length === 0
    ? pass(`all ${realLanes.length} configured lane(s) are registered everywhere they must be`)
    : fail(`lane registration drift: ${realErrors.map(f => `[${f.lane}] ${f.site}`).join(', ')}`);
}

rmSync(tmp, { recursive: true, force: true });
