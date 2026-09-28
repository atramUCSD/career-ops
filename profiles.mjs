#!/usr/bin/env node
/**
 * profiles.mjs — run career-ops for someone other than the repo owner.
 *
 * THE PROBLEM
 * Every user-layer path in this repo resolves to one person: cv.md,
 * config/profile.yml, portals.yml, data/pipeline.md, data/applications.md.
 * Helping a second person meant a second checkout, or overwriting the first
 * person's files and losing them.
 *
 * WHAT THIS DOES
 * A profile is one directory holding a complete user layer, plus the set of
 * environment variables that point the existing scripts at it. Nothing is
 * reimplemented and no script is forked: this is the same
 * `CAREER_OPS_*`-override mechanism the test suite already uses for isolation,
 * promoted to a user-facing feature.
 *
 *   node profiles.mjs new alex               # scaffold profiles/alex/
 *   node profiles.mjs list
 *   node profiles.mjs run alex scan.mjs --since 10
 *   node profiles.mjs artifact alex          # their own pipeline artifact
 *   node profiles.mjs env alex               # the variables, for a shell
 *
 * Profiles are user layer. `profiles/` is gitignored in full, and nothing here
 * ever writes to the repo owner's files — `run` sets cwd to the profile
 * directory precisely so that a path this map does not cover lands inside the
 * profile rather than on top of the owner's data.
 */
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync, copyFileSync } from 'node:fs';
import { dirname, join, resolve, isAbsolute } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { isMainModule } from './lib/is-main-module.mjs';

const ROOT = dirname(fileURLToPath(import.meta.url));
/**
 * Read at call time, not at module load.
 *
 * The whole suite runs in one process, so whichever test imports this module
 * first would otherwise latch the override for every test after it — and once
 * build-artifact.mjs started importing profileDir, that first importer stopped
 * being the profiles test. A latched PROFILES_DIR does not fail loudly: the
 * scaffold succeeds, just under the repo's own `profiles/` instead of the
 * sandbox, writing into the user layer the test was isolating itself from.
 */
export function profilesDir() {
  return process.env.CAREER_OPS_PROFILES_DIR
    ? resolve(process.env.CAREER_OPS_PROFILES_DIR)
    : join(ROOT, 'profiles');
}

/**
 * A profile name becomes a directory name, so it is restricted rather than
 * sanitized. Silently rewriting "../../etc" into something safe would still
 * create a profile — under a name the caller never asked for, which they would
 * then keep using. Reject it instead.
 */
export function validName(name) {
  return typeof name === 'string' && /^[a-z0-9][a-z0-9._-]{0,63}$/i.test(name) && name !== '.' && name !== '..';
}

export function profileDir(name) {
  if (!validName(name)) {
    throw new Error(`invalid profile name "${name}" — letters, digits, dot, dash and underscore only`);
  }
  return join(profilesDir(), name);
}

/**
 * The variables that move a career-ops run off the repo owner's user layer.
 *
 * Every entry is a path the scripts already consult an override for; this file
 * does not invent new ones. Values are absolute so they survive the cwd change
 * in `run`.
 *
 * Deliberately NOT included: the `*_LOCK_*` timeouts, CAREER_OPS_CLI,
 * CAREER_OPS_MODEL and the update-system variables. Those are machine or
 * session settings that are the same whoever the run is for, and copying them
 * per profile would make them look like per-person configuration.
 */
export function profileEnv(dir) {
  const at = (...p) => join(dir, ...p);
  return {
    // The data root (path-resolver.mjs). Covers every user-layer path a script
    // resolves without its own override; the per-file overrides below remain
    // for scripts that predate the resolver.
    CAREER_OPS_DATA_DIR: dir,
    CAREER_OPS_CV: at('cv.md'),
    CAREER_OPS_ARTICLE_DIGEST: at('article-digest.md'),
    CAREER_OPS_PROFILE: at('config', 'profile.yml'),
    CAREER_OPS_PROFILE_MODE: at('modes', '_profile.md'),
    CAREER_OPS_LANES: at('config', 'lanes.yml'),
    CAREER_OPS_PORTALS: at('portals.yml'),
    CAREER_OPS_PIPELINE: at('data', 'pipeline.md'),
    CAREER_OPS_SCAN_HISTORY: at('data', 'scan-history.tsv'),
    CAREER_OPS_TRACKER: at('data', 'applications.md'),
    CAREER_OPS_TRACKER_DB: at('data', 'tracker.db'),
    CAREER_OPS_FOLLOWUPS: at('data', 'follow-ups.md'),
    CAREER_OPS_ADDITIONS: at('data', 'tracker-additions'),
    CAREER_OPS_INBOX: at('data', 'inbox.md'),
    CAREER_OPS_REPLY_CANDIDATES: at('data', 'reply-candidates.json'),
    CAREER_OPS_BATCH_STATE: at('data', 'batch-state.json'),
    CAREER_OPS_INTAKE_STATE: at('data', 'intake-state.json'),
    CAREER_OPS_PDF_INDEX: at('data', 'pdf-index.json'),
    CAREER_OPS_REPORTS_DIR: at('reports'),
    CAREER_OPS_DOCUMENTS_DIR: at('documents'),
  };
}

const DIRS = ['config', 'modes', 'data', 'data/tracker-additions', 'documents', 'output', 'reports', 'jds'];

const TRACKER_HEADER = [
  '# Applications Tracker',
  '',
  '| # | Date | Company | Role | Score | Status | PDF | Report | Notes |',
  '|---|------|---------|------|-------|--------|-----|--------|-------|',
  '',
].join('\n');

const PIPELINE_HEADER = ['# Pipeline', '', '## Pending', '', ''].join('\n');

const STUB_NOTE = '> Until it is real, every score in this profile is scored against a stub.';

const CV_STUB = [
  '# {NAME}',
  '',
  '> Replace this file with their CV before scanning or evaluating anything.',
  STUB_NOTE,
  '',
  '## Summary',
  '',
  '## Experience',
  '',
  '## Skills',
  '',
].join('\n');

/**
 * A scaffolded cv.md exists, so an existence check calls the profile ready
 * while every evaluation scores against an empty CV. The stub's own note is
 * the marker: a real CV pasted over it drops the line.
 */
export const isStubCv = (text) => text.includes(STUB_NOTE);

/**
 * Scaffold a profile. Copies rather than symlinks the shared config so the
 * second person's lanes and portals can diverge from the owner's — which is
 * the point of a separate profile, and would be impossible through a link.
 *
 * Never overwrites: a re-run tops up whatever is missing and leaves existing
 * files alone, so it is safe to run against a profile already in use.
 */
export function scaffold(name, { root = ROOT } = {}) {
  const dir = profileDir(name);
  const created = [];
  const write = (rel, content) => {
    const p = join(dir, rel);
    if (existsSync(p)) return;
    writeFileSync(p, content);
    created.push(rel);
  };
  const copy = (from, rel) => {
    const p = join(dir, rel);
    if (existsSync(p) || !existsSync(from)) return;
    copyFileSync(from, p);
    created.push(rel);
  };

  mkdirSync(dir, { recursive: true });
  for (const d of DIRS) mkdirSync(join(dir, d), { recursive: true });

  write('cv.md', CV_STUB.replace('{NAME}', name));
  write('data/pipeline.md', PIPELINE_HEADER);
  write('data/applications.md', TRACKER_HEADER);
  copy(join(root, 'config', 'profile.example.yml'), 'config/profile.yml');
  // lanes.yml absent is not an error anywhere — loadLanes returns [] and every
  // posting silently classifies as `core`. Copy it so that never happens by
  // accident in a fresh profile.
  //
  // The EXAMPLE first, the owner's live lanes only as a fallback. Lane keywords
  // are targeting, and a profile that inherits the owner's lanes claims every
  // posting the owner's scan admits — which is exactly the cross-profile bleed
  // a separate profile exists to prevent.
  copy(join(root, 'config', 'lanes.example.yml'), 'config/lanes.yml');
  copy(join(root, 'config', 'lanes.yml'), 'config/lanes.yml');
  copy(join(root, 'templates', 'portals.example.yml'), 'portals.yml');
  copy(join(root, 'modes', '_profile.template.md'), 'modes/_profile.md');

  return { dir, created };
}

export function listProfiles() {
  if (!existsSync(profilesDir())) return [];
  return readdirSync(profilesDir(), { withFileTypes: true })
    .filter(e => e.isDirectory() && validName(e.name))
    .map(e => e.name)
    .sort();
}

/** Unchecked rows in a user layer's data/pipeline.md; 0 when it has none. */
export function pendingCount(dir) {
  const pipelinePath = join(dir, 'data', 'pipeline.md');
  if (!existsSync(pipelinePath)) return 0;
  let pending = 0;
  for (const line of readFileSync(pipelinePath, 'utf-8').split('\n')) {
    if (/^\s*[-*]\s*\[ \]/.test(line)) pending++;
  }
  return pending;
}

/** Rows for `list`: what exists in each profile, without loading any of it. */
export function describe(name) {
  const dir = profileDir(name);
  const pending = pendingCount(dir);
  return {
    name,
    dir,
    cv: existsSync(join(dir, 'cv.md')),
    profile: existsSync(join(dir, 'config', 'profile.yml')),
    portals: existsSync(join(dir, 'portals.yml')),
    pending,
  };
}

/**
 * Run a career-ops script against a profile.
 *
 * cwd is the profile directory on purpose. Every override in profileEnv covers
 * a path the scripts read an override for, but the repo is large and a script
 * that resolves something cwd-relative without one would otherwise write into
 * the owner's data. Pointing cwd at the profile makes the failure mode "a file
 * appears in the profile directory" instead of "the owner's tracker changed".
 */
export function run(name, script, args = [], { root = ROOT, env = process.env, spawn = spawnSync } = {}) {
  const dir = profileDir(name);
  if (!existsSync(dir)) throw new Error(`no such profile "${name}" — create it with: node profiles.mjs new ${name}`);
  const target = isAbsolute(script) ? script : join(root, script);
  if (!existsSync(target)) throw new Error(`no such script "${script}"`);
  return spawn(process.execPath, [target, ...args], {
    cwd: dir,
    env: { ...env, ...profileEnv(dir) },
    stdio: 'inherit',
  });
}

function usage() {
  console.log(`Usage:
  node profiles.mjs new <name>                  scaffold profiles/<name>/
  node profiles.mjs list                        show every profile
  node profiles.mjs env <name>                  print the environment overrides
  node profiles.mjs run <name> <script> [args]  run any career-ops script for that profile
  node profiles.mjs artifact <name> [--out p]   build that profile's pipeline artifact`);
}

function main(argv) {
  const [cmd, name, ...rest] = argv;
  if (!cmd || cmd === '--help' || cmd === '-h') { usage(); return 0; }

  if (cmd === 'list') {
    const names = listProfiles();
    if (!names.length) {
      console.log('No profiles yet. Create one with: node profiles.mjs new <name>');
      return 0;
    }
    for (const n of names) {
      const d = describe(n);
      const missing = ['cv', 'profile', 'portals'].filter(k => !d[k]);
      console.log(`  ${n.padEnd(20)} ${String(d.pending).padStart(5)} pending${missing.length ? `   missing: ${missing.join(', ')}` : ''}`);
    }
    return 0;
  }

  if (!name) { usage(); return 1; }

  if (cmd === 'new') {
    const { dir, created } = scaffold(name);
    console.log(`${dir}`);
    if (created.length) for (const f of created) console.log(`  + ${f}`);
    else console.log('  (already complete — nothing added)');
    console.log(`\nNext: replace ${join(dir, 'cv.md')} with their CV, then edit`);
    console.log(`${join(dir, 'config', 'profile.yml')} and ${join(dir, 'portals.yml')} for their targeting.`);
    console.log(`Then: node profiles.mjs run ${name} scan.mjs --since 10`);
    return 0;
  }

  if (cmd === 'env') {
    const dir = profileDir(name);
    for (const [k, v] of Object.entries(profileEnv(dir))) console.log(`${k}=${v}`);
    return 0;
  }

  if (cmd === 'run') {
    const [script, ...args] = rest;
    if (!script) { usage(); return 1; }
    const res = run(name, script, args);
    return res.status ?? 1;
  }

  if (cmd === 'artifact') {
    const dir = profileDir(name);
    if (!existsSync(dir)) {
      console.error(`no such profile "${name}" — create it with: node profiles.mjs new ${name}`);
      return 1;
    }
    const outIdx = rest.indexOf('--out');
    const out = outIdx >= 0 ? rest[outIdx + 1] : join(dir, 'output', 'pipeline-artifact.html');
    const res = run(name, 'build-artifact.mjs', ['--root', dir, '--out', resolve(out)]);
    return res.status ?? 1;
  }

  usage();
  return 1;
}

if (isMainModule(import.meta.url)) process.exit(main(process.argv.slice(2)));
