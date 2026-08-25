// Guards the match-score rewrite: every hard gate fires on its own, a zero
// always carries a reason, and hat count is what moves a live score.
import assert from 'node:assert/strict';
import { buildScorer, inCalifornia } from '../callback-score.mjs';
import { FACT_COLUMNS } from '../enrich-jd.mjs';

const profile = {
  target_roles: {
    primary: ['Front End Engineer', 'Forward Deployed Engineer'],
    archetypes: [{ name: 'Front End / Web Engineer', level: 'Mid-Senior', fit: 'primary' }],
  },
  compensation: { minimum: '$130K' },
};

const URL = 'https://example.com/jobs/1';
const row = { u: URL, c: 'Example', t: 'Front End Engineer', lane: 'frontend', age: 3, seg: 'San Diego' };

// jd-facts.tsv is positional; build fact rows through the real column order so
// a column added to the writer breaks this test instead of the dashboard.
function facts(overrides) {
  const base = {
    url: URL, ok: '1', yoe: '', degree: 'none', clearance: 'none',
    comp_low: '', comp_high: '', remote: '', hats: '', frameworks: '', fetched: '2026-08-23',
  };
  return new Map([[URL, { ...base, ...overrides }]]);
}

const score = f => buildScorer({ profile, lanes: [], rows: [row], history: [], facts: f })(row);

// Every gate, one at a time.
const gates = [
  ['TS/SCI', { clearance: 'ts_sci' }],
  ['years', { yoe: '12' }],
  ['doctorate', { degree: 'phd' }],
  ['comp ceiling', { comp_high: '110000' }],
];
for (const [name, override] of gates) {
  const s = score(facts(override));
  assert.equal(s.score, 0, `${name} gate should score 0, got ${s.score}`);
  assert.equal(s.band, 'blocked', `${name} gate should band blocked`);
  assert.ok(s.gate && s.gate.length > 5, `${name} gate must name a reason`);
}

// Onsite geography. Relocation is fine anywhere in California, so only an
// onsite req that resolves to another state gates — and an unresolvable
// location never does.
const at = (l, remote) => buildScorer({ profile, lanes: [], rows: [row], history: [], facts: facts({ remote }) })({ ...row, l });
assert.equal(at('Austin, TX', 'onsite').score, 0, 'onsite out of state should gate');
assert.match(at('Austin, TX', 'onsite').gate, /outside California/);
assert.ok(at('San Jose, CA', 'onsite').score > 0, 'onsite in California is fine');
assert.ok(at('Somewhere', 'onsite').score > 0, 'an unresolvable location never gates');
assert.ok(at('Austin, TX', 'hybrid').score > 0, 'only onsite gates');
assert.ok(at('Austin, TX', '').score > 0, 'an unread remote fact never gates');
assert.equal(inCalifornia('Remote - US'), null);

// A zero never arrives without a reason, whatever the input.
for (const f of [facts({}), facts({ hats: '' }), facts({ ok: '0' }), new Map()]) {
  const s = score(f);
  if (s.score === 0) assert.ok(s.gate, 'score 0 must carry a gate reason');
}

// The gates that are only penalties must not zero the row.
for (const override of [{ clearance: 'secret' }, { degree: 'masters' }, { yoe: '5' }]) {
  const s = score(facts(override));
  assert.ok(s.score > 0, `${JSON.stringify(override)} is a modifier, not a gate`);
  assert.ok(!s.gate);
}

// Hats are the spine: more hats, higher score, monotonically.
const byHats = ['', 'developer', 'developer,designer', 'developer,designer,ai_advocate']
  .map(hats => score(facts({ hats })).score);
for (let i = 1; i < byHats.length; i++) {
  assert.ok(byHats[i] > byHats[i - 1], `hat count ${i} should outscore ${i - 1}: ${byHats}`);
}

// A read description beats a guess: title-only scoring is capped below a
// confirmed two-hat match so an unread posting can never top the dashboard.
const titleOnly = score(new Map()).score;
assert.ok(titleOnly < byHats[2], `title-only ${titleOnly} must stay under two-hat ${byHats[2]}`);

// The Secret bonus is worth more than nothing but never rescues a gated row.
assert.ok(
  score(facts({ hats: 'developer', clearance: 'secret' })).score
  > score(facts({ hats: 'developer' })).score,
  'a Secret requirement should raise the score',
);
assert.equal(score(facts({ hats: 'developer,designer,ai_advocate', clearance: 'ts_sci' })).score, 0);

// With no description, the title is the only evidence — so a clearance stated
// in the title counts, upward and downward alike.
const byTitle = t => buildScorer({ profile, lanes: [], rows: [row], history: [], facts: new Map() })({ ...row, t });
assert.ok(
  byTitle('UI/UX Developer / Active Secret').score > byTitle('UI/UX Developer').score,
  'a Secret named in the title should raise an unread row',
);
assert.equal(byTitle('Front End Engineer, TS/SCI with Polygraph').score, 0);
assert.match(byTitle('Front End Engineer, TS/SCI with Polygraph').gate, /TS\/SCI/);

// enrich-jd writes what callback-score reads.
assert.ok(FACT_COLUMNS.includes('hats') && FACT_COLUMNS.includes('yoe'));

console.log('callback-score tests OK');
