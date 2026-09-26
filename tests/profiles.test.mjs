// tests/profiles.test.mjs — a profile must be a sealed user layer.
//
// The bug worth pinning here is silent cross-contamination: a run "for Alex"
// that reads the repo owner's CV, or writes Alex's postings into the owner's
// tracker. Nothing in the output would say so — the artifact renders fine
// either way, with the wrong person's scores in it.
import { mkdtempSync, existsSync, readFileSync, writeFileSync, rmSync } from 'fs';
import { join, isAbsolute, resolve, dirname } from 'path';
import { fileURLToPath } from 'url';
import { tmpdir } from 'os';
import { pass, fail } from './helpers.mjs';

console.log('\nprofiles — a sealed user layer per person');

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const SANDBOX = mkdtempSync(join(tmpdir(), 'career-ops-profiles-'));
process.env.CAREER_OPS_PROFILES_DIR = SANDBOX;

const { validName, profileDir, profileEnv, scaffold, listProfiles, describe, run } =
  await import('../profiles.mjs');

// ── names are rejected, never sanitized ──────────────────────────────────────

validName('alex') && validName('alex-2') && validName('A_b.c')
  ? pass('ordinary names accepted')
  : fail('a plain profile name was rejected');

['../owner', 'a/b', '', '.', '..', 'a\\b', 'x'.repeat(65)].every(n => !validName(n))
  ? pass('traversal, separators, empty and over-long names rejected')
  : fail('an unsafe profile name was accepted');

try {
  profileDir('../escape');
  fail('profileDir accepted a traversal name instead of throwing');
} catch {
  pass('profileDir throws on a traversal name');
}

// ── every override lands inside the profile ──────────────────────────────────

const dir = join(SANDBOX, 'alex');
const env = profileEnv(dir);

Object.entries(env).every(([, v]) => isAbsolute(v) && resolve(v).startsWith(resolve(dir)))
  ? pass('every override is absolute and inside the profile directory')
  : fail('an override escaped the profile directory — the owner’s files are reachable');

// The four that decide whose search this is. If any of these ever stops being
// overridden, the profile silently borrows the owner's identity and targeting.
['CAREER_OPS_CV', 'CAREER_OPS_PROFILE', 'CAREER_OPS_PORTALS', 'CAREER_OPS_PIPELINE']
  .every(k => k in env)
  ? pass('CV, profile, portals and pipeline are all redirected')
  : fail('a core identity path is not redirected — scores would be the owner’s');

// ── scaffold ─────────────────────────────────────────────────────────────────

const first = scaffold('alex', { root: ROOT });
existsSync(join(dir, 'cv.md')) && existsSync(join(dir, 'data', 'pipeline.md')) &&
existsSync(join(dir, 'portals.yml')) && existsSync(join(dir, 'config', 'profile.yml'))
  ? pass('scaffold writes cv, pipeline, portals and profile')
  : fail('scaffold left a required user-layer file missing');

// lanes.yml missing is not an error anywhere — loadLanes returns [] and every
// posting quietly classifies as `core`. A fresh profile must not start there.
existsSync(join(dir, 'config', 'lanes.yml'))
  ? pass('scaffold ships lanes.yml so classification is not silently disabled')
  : fail('lanes.yml missing — every posting would classify as core with no warning');

writeFileSync(join(dir, 'cv.md'), '# Alex, real CV\n');
const second = scaffold('alex', { root: ROOT });
second.created.length === 0 && readFileSync(join(dir, 'cv.md'), 'utf-8').includes('real CV')
  ? pass('re-scaffolding an in-use profile overwrites nothing')
  : fail('scaffold clobbered an existing profile file');

first.created.length > 0
  ? pass('first scaffold reports what it created')
  : fail('scaffold reported no created files on a fresh profile');

// ── list / describe ──────────────────────────────────────────────────────────

listProfiles().includes('alex')
  ? pass('listProfiles finds the scaffolded profile')
  : fail('listProfiles missed a profile that exists on disk');

writeFileSync(join(dir, 'data', 'pipeline.md'),
  '# Pipeline\n\n## Pending\n\n- [ ] https://a.example/1\n- [ ] https://b.example/2\n- [x] https://c.example/3\n');
describe('alex').pending === 2
  ? pass('describe counts only unchecked pending rows')
  : fail(`describe counted ${describe('alex').pending} pending, expected 2`);

// ── run is sealed ────────────────────────────────────────────────────────────

let seen = null;
run('alex', 'build-artifact.mjs', ['--x'], { root: ROOT, env: { PATH: 'p' }, spawn: (...a) => { seen = a; return { status: 0 }; } });
seen[2].cwd === dir
  ? pass('run executes with cwd inside the profile')
  : fail('run left cwd at the repo root — an unmapped relative path would hit the owner’s data');

seen[2].env.CAREER_OPS_CV === join(dir, 'cv.md') && seen[2].env.PATH === 'p'
  ? pass('run merges the overrides over the caller’s environment')
  : fail('run did not apply the profile overrides');

try {
  run('nope-not-here', 'build-artifact.mjs', [], { root: ROOT, spawn: () => ({ status: 0 }) });
  fail('run accepted a profile that does not exist');
} catch {
  pass('run refuses an unknown profile');
}

rmSync(SANDBOX, { recursive: true, force: true });
delete process.env.CAREER_OPS_PROFILES_DIR;
