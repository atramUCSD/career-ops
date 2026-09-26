// tests/build-hub.test.mjs — the hub is the page that is safe to share.
//
// Everything else about this file is cosmetic; one property is not. Each person
// gets their own artifact URL so that one person's postings, targeting and comp
// floor never appear in another person's page source, and the hub is the single
// page everyone is given. A company name reaching it undoes the whole split, and
// would do so silently — the page still renders, it just says more than it
// should. That is asserted here against a real pipeline fixture.
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { pass, fail } from './helpers.mjs';
import { buildHubModel, renderHub } from '../build-hub.mjs';

console.log('\nbuild-hub — an index with no job data in it');

const NOW = new Date('2026-08-20T12:00:00Z');
const BASE = mkdtempSync(join(tmpdir(), 'career-ops-hub-'));
const ROOT = join(BASE, 'owner');
const PROFILES = join(BASE, 'profiles');
const SAMPLE = join(PROFILES, 'sample');
const BROKEN = join(PROFILES, 'broken');

for (const d of [ROOT, SAMPLE, BROKEN]) {
  mkdirSync(join(d, 'config'), { recursive: true });
  mkdirSync(join(d, 'data'), { recursive: true });
}

const SECRET = 'Hexavolt Dynamics';
writeFileSync(join(ROOT, 'data/pipeline.md'), [
  '# Pipeline', '', '## Pending', '',
  `- [ ] https://boards.greenhouse.io/hexavolt/jobs/1 | ${SECRET} | Front End Engineer | Remote | posted: 2026-08-18`,
  `- [ ] https://boards.greenhouse.io/hexavolt/jobs/2 | ${SECRET} | Clinical Data Manager | Remote | posted: 2026-08-18`,
  '',
].join('\n'));

writeFileSync(join(ROOT, 'portals.yml'), 'max_posting_age_days: 45\ntitle_filter:\n  positive:\n    - engineer\n');

const profileYml = primary => [
  'candidate:', '  full_name: Test Person',
  'target_roles:', '  primary:', `    - ${primary}`, '  archetypes: []', '',
].join('\n');

writeFileSync(join(ROOT, 'config/profile.yml'), profileYml('Front End Engineer'));
writeFileSync(join(SAMPLE, 'config/profile.yml'), profileYml('Clinical Data Manager'));
writeFileSync(join(SAMPLE, 'cv.md'), '# sample\n');
writeFileSync(join(SAMPLE, 'portals.yml'), '{}\n');
// Deliberately unparseable. A profile whose config is broken must still be
// named on the hub — a page that quietly omits a profile is worse than one that
// says it could not read it.
writeFileSync(join(BROKEN, 'config/profile.yml'), 'target_roles: [oops\n');

writeFileSync(join(ROOT, 'config/artifacts.yml'), [
  'owner: https://example.invalid/owner',
  'profiles:',
  '  sample: https://example.invalid/sample',
  '',
].join('\n'));

const prev = process.env.CAREER_OPS_PROFILES_DIR;
process.env.CAREER_OPS_PROFILES_DIR = PROFILES;
let M, html;
try {
  M = buildHubModel({ root: ROOT, now: NOW });
  html = renderHub(M);
} finally {
  if (prev === undefined) delete process.env.CAREER_OPS_PROFILES_DIR;
  else process.env.CAREER_OPS_PROFILES_DIR = prev;
}

const by = Object.fromEntries(M.entries.map(e => [e.name, e]));

// ── the property the split exists for ────────────────────────────────────────

!html.includes(SECRET) && !html.includes('Front End Engineer') && !html.includes('greenhouse.io')
  ? pass('no company, title or posting URL reaches the hub')
  : fail('job data leaked onto the hub — the page everyone is given is no longer safe to share');

// ── counts describe the page the link opens ──────────────────────────────────

by.owner.pending === 2
  ? pass('the owner card counts the pending pipeline')
  : fail(`owner count is ${by.owner.pending}`);

by.sample.pending === 1
  ? pass('a profile card counts its projection, not its own empty pipeline')
  : fail(`a profile card reported ${by.sample.pending} — a projected profile would read as 0 next to a page full of rows`);

// ── a broken profile is named, not dropped ───────────────────────────────────

by.broken && by.broken.pending === null
  ? pass('a profile whose model cannot be built is still listed, with no count')
  : fail('a broken profile was dropped from the hub instead of being reported');

html.includes('—</b> pending')
  ? pass('the unbuildable count renders as a dash rather than a confident zero')
  : fail('a profile with no readable model rendered a number');

// ── publishing state ─────────────────────────────────────────────────────────

by.sample.url === 'https://example.invalid/sample' && by.owner.url === 'https://example.invalid/owner'
  ? pass('published URLs come from config/artifacts.yml')
  : fail('the hub did not read the published URLs');

by.broken.url === null && html.includes('not yet published')
  ? pass('a profile with no URL says so instead of rendering a dead link')
  : fail('an unpublished profile got a link');

M.published === 2 && M.entries.length === 3
  ? pass('the footer count reconciles against the cards')
  : fail(`published ${M.published} of ${M.entries.length}`);

// ── an unconfigured checkout still renders ───────────────────────────────────

rmSync(join(ROOT, 'config/artifacts.yml'));
process.env.CAREER_OPS_PROFILES_DIR = PROFILES;
const bare = buildHubModel({ root: ROOT, now: NOW });
if (prev === undefined) delete process.env.CAREER_OPS_PROFILES_DIR;
else process.env.CAREER_OPS_PROFILES_DIR = prev;

bare.configured === false && bare.published === 0 && bare.entries.length === 3
  ? pass('with no artifacts.yml the hub lists everyone and links nobody')
  : fail('a missing artifacts.yml changed which profiles exist');

rmSync(BASE, { recursive: true, force: true });
pass('fixture cleaned up');
