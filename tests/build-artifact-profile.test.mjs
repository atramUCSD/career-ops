// tests/build-artifact-profile.test.mjs — one corpus, one view per person.
//
// A second person's artifact is a projection of the repo owner's scan, not a
// second scan. That makes exactly one thing dangerous: the projection filter.
// Too loose and someone reads a page full of roles aimed at another person;
// too tight and a job both people want disappears from one of their pages with
// nothing on screen saying it was removed. Both failures render as a normal,
// confident-looking artifact, so they are pinned here rather than eyeballed.
//
// The relevance test is `family !== 'unmatched'` — the scorer's own verdict, so
// there is no second matching implementation that can drift from the first.
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { pass, fail } from './helpers.mjs';
import { buildModel } from '../build-artifact.mjs';

console.log('\nbuild-artifact --as-profile — projection isolation');

const NOW = new Date('2026-08-20T00:00:00Z');
const BASE = mkdtempSync(join(tmpdir(), 'career-ops-projection-'));
const ROOT = join(BASE, 'owner');
const SAMPLE = join(BASE, 'sample');

for (const d of [ROOT, SAMPLE]) {
  mkdirSync(join(d, 'config'), { recursive: true });
  mkdirSync(join(d, 'data'), { recursive: true });
}

// Four postings: one for each person alone, one both target, one neither.
const POSTINGS = [
  ['https://boards.greenhouse.io/acme/jobs/1', 'Acme', 'Front End Engineer'],
  ['https://boards.greenhouse.io/acme/jobs/2', 'Acme', 'Clinical Data Manager'],
  ['https://boards.greenhouse.io/beta/jobs/3', 'Beta', 'AI Solutions Architect'],
  ['https://boards.greenhouse.io/beta/jobs/4', 'Beta', 'Warehouse Forklift Operator'],
];

writeFileSync(join(ROOT, 'data/pipeline.md'), [
  '# Pipeline', '', '## Pending', '',
  ...POSTINGS.map(([u, c, t]) => `- [ ] ${u} | ${c} | ${t} | Remote | posted: 2026-08-18`),
  '',
].join('\n'));

writeFileSync(join(ROOT, 'portals.yml'), [
  'max_posting_age_days: 45',
  'title_filter:',
  '  positive:',
  '    - engineer',
  '    - architect',
  '',
].join('\n'));

const profileYml = (primary) => [
  'candidate:',
  '  full_name: Test Person',
  '  location: Remote',
  'compensation:',
  '  minimum: "$130K"',
  'target_roles:',
  '  primary:',
  ...primary.map(p => `    - ${p}`),
  '  archetypes: []',
  '',
].join('\n');

writeFileSync(join(ROOT, 'config/profile.yml'), profileYml(['Front End Engineer', 'AI Solutions Architect']));
writeFileSync(join(SAMPLE, 'config/profile.yml'), profileYml(['Clinical Data Manager', 'AI Solutions Architect']));

// No lanes on either side. `family` falls back to the lane only when the title
// matches nothing, and this suite is about the title test — a lane would let a
// row through for a reason the assertions below are not measuring.

const titles = m => m.rows.map(r => r.t).sort();

const owner = buildModel({ root: ROOT, now: NOW });
const sample = buildModel({ root: ROOT, now: NOW, profileRoot: SAMPLE, profileName: 'sample' });

// ── the owner's build is untouched by the flag existing ──────────────────────

owner.rows.length === 4
  ? pass('the owner sees the whole corpus, including rows nothing of theirs matches')
  : fail(`the no-flag build dropped rows (${owner.rows.length} of 4) — the projection leaked into the owner's page`);

owner.projection === null && owner.who.name === null
  ? pass('no projection accounting on the owner build')
  : fail('the owner build reported a projection it never applied');

// ── the assertions that matter: what each projection may contain ─────────────

const st = titles(sample);

!st.includes('Front End Engineer')
  ? pass("a row matching only the owner's targeting is absent from the sample projection")
  : fail("another person's role rendered on the sample page — the projection is not isolating");

st.includes('Clinical Data Manager')
  ? pass("a row matching only the sample's targeting is present")
  : fail('the projection dropped a row this profile explicitly targets');

st.includes('AI Solutions Architect') && titles(owner).includes('AI Solutions Architect')
  ? pass('a row both people target appears on both pages — relevance, not ownership')
  : fail('the overlap case was assigned to one profile instead of both');

!st.includes('Warehouse Forklift Operator')
  ? pass('a row neither profile targets is dropped from the projection')
  : fail('an unmatched row survived the projection');

sample.rows.every(r => r.family !== 'unmatched')
  ? pass('every surviving row carries a family — the filter is the scorer, not a second matcher')
  : fail('a row with family "unmatched" survived the projection');

// ── the drop is published, not silent ────────────────────────────────────────

sample.projection && sample.projection.kept === 2 && sample.projection.dropped === 2
  ? pass('kept and dropped counts are reported, so a misconfigured profile is visible')
  : fail(`projection accounting is wrong: ${JSON.stringify(sample.projection)}`);

sample.projection.kept + sample.projection.dropped === owner.rows.length
  ? pass('kept plus dropped reconciles against the full corpus')
  : fail('the projection accounting does not add up to the corpus it projected');

// ── the corpus properties are read off the corpus, not the slice ─────────────

// Beta has two open reqs in the corpus and one in the sample projection. If the
// prior were computed after filtering, the score for the shared row would move
// purely because of who is looking at it.
const ownerShared = owner.rows.find(r => r.t === 'AI Solutions Architect');
const sampleShared = sample.rows.find(r => r.t === 'AI Solutions Architect');
ownerShared.cb === sampleShared.cb
  ? pass('the shared row scores identically in both views — scoring precedes projection')
  : fail(`the same posting scored ${ownerShared.cb} for the owner and ${sampleShared.cb} for the sample`);

// ── the channels panel stays a property of the corpus ────────────────────────

sample.channels.total === owner.channels.total
  ? pass('ingestion trust is computed from the shared scan, not the projected slice')
  : fail('the channels report changed under a projection');

// ── whose page this is ───────────────────────────────────────────────────────

sample.who.name === 'sample' && sample.who.primary.includes('Clinical Data Manager') &&
!sample.who.primary.includes('Front End Engineer')
  ? pass("the Profile panel reads the profile's own targeting, not the owner's")
  : fail("the projected build described the owner's targeting");

rmSync(BASE, { recursive: true, force: true });
pass('fixture cleaned up');
