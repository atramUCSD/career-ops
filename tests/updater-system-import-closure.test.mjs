// tests/updater-system-import-closure.test.mjs — every relative static import in
// a SYSTEM_PATHS .mjs file must land on a file SYSTEM_PATHS also ships.
//
// `apply` checks out SYSTEM_PATHS from the target ref and leaves USER_PATHS
// alone. A system file that statically imports a user-layer file therefore
// reaches installs that never had the dependency, and ESM resolves static
// imports before any code runs, so the importer dies with ERR_MODULE_NOT_FOUND
// at load time; no try/catch inside it can help. That is how doctor.mjs broke
// on installs upgraded from upstream, twice (gmail-send.mjs in b737b75b,
// personalization.mjs after it). The coverage validator cannot see this: both
// files are covered, just by different layers.
//
// Dynamic import() is exempt because the importer can catch the failure, which
// is the sanctioned way for a system file to use an optional fork-local module.
//
// Files under tests/ are exempt too. They ride the tests/ prefix, so a
// fork-local test of a fork-local module reaches an upgraded install without
// its subject, but that fails only that install's test run, never a command.
// ponytail: scoped to runtime crashes; give fork-local tests their own layer if
// downstream test runs ever matter.
//
// Specifiers come from V8's own module parser (vm.SourceTextModule) rather than
// a regex: a regex also matches import statements inside fixture strings,
// template literals and comments, and this repo has plenty of all three. The
// parser is behind --experimental-vm-modules, so it runs in a child process.
import { existsSync, readFileSync } from 'fs';
import { join, posix } from 'path';
import { extractArrayFromSource } from '../update-system.mjs';
import { pass, fail, run, formatRunFailure, ROOT, GIT_NO_FSMONITOR } from './helpers.mjs';

console.log('\nupdate-system.mjs — SYSTEM_PATHS imports stay inside SYSTEM_PATHS');

let src = null;
try {
  src = readFileSync(join(ROOT, 'update-system.mjs'), 'utf-8');
} catch (err) {
  fail(`update-system.mjs is unreadable at ${ROOT} (${err.code || err.message}) — the manifest was never parsed, so this is not a clean result`);
}

const systemPaths = src ? extractArrayFromSource(src, 'SYSTEM_PATHS') : [];
if (src && systemPaths.length === 0) fail('could not parse SYSTEM_PATHS — this guard would pass vacuously');

// Same rule as covered() in validate-system-paths-coverage.mjs: a trailing
// slash is a directory prefix, anything else an exact path.
const isSystem = (file) => systemPaths.some((p) => (p.endsWith('/') ? file.startsWith(p) : file === p));

const listing = systemPaths.length > 0 ? run('git', [...GIT_NO_FSMONITOR, 'ls-files', '-z']) : null;
const files = (listing ?? '').split('\0').filter((f) => f.endsWith('.mjs') && isSystem(f) && !f.startsWith('tests/'));

if (systemPaths.length > 0 && files.length === 0) {
  // An empty listing means this run could not look, not that nothing is wrong.
  fail(`no tracked SYSTEM_PATHS .mjs files found from ${ROOT} — git ls-files saw nothing to check${formatRunFailure()}`);
}

// moduleRequests replaced dependencySpecifiers in newer Node; the package
// still supports Node 18, which only has the latter.
const PARSE = `
const vm = require('vm'), fs = require('fs');
const out = {};
for (const f of JSON.parse(fs.readFileSync(0, 'utf8'))) {
  try {
    const m = new vm.SourceTextModule(fs.readFileSync(f, 'utf8'), { identifier: f });
    out[f] = m.moduleRequests ? m.moduleRequests.map((r) => r.specifier) : m.dependencySpecifiers;
  } catch (e) {
    out[f] = { error: String(e && e.message) };
  }
}
process.stdout.write(JSON.stringify(out));
`;

if (files.length > 0) {
  const raw = run('node', ['--experimental-vm-modules', '--no-warnings', '-e', PARSE], {
    input: JSON.stringify(files),
    maxBuffer: 64 * 1024 * 1024,
  });
  let specs = null;
  try {
    specs = JSON.parse(raw);
  } catch {
    // raw is null when the child failed; formatRunFailure() carries its stderr.
  }
  if (!specs || typeof specs !== 'object') {
    fail(`module parser child produced no usable result${formatRunFailure()}`);
  } else {
    let checked = 0;
    let violations = 0;
    for (const file of files) {
      const list = specs[file];
      if (!Array.isArray(list)) {
        fail(`${file}: V8 could not parse it as a module (${list?.error ?? 'no result'}), so its imports were not checked`);
        continue;
      }
      for (const spec of list) {
        if (!spec.startsWith('./') && !spec.startsWith('../')) continue;
        checked++;
        const target = posix.join(posix.dirname(file), spec);
        if (!isSystem(target)) {
          violations++;
          fail(`${file} statically imports ${spec}, which SYSTEM_PATHS does not ship — an install updated without it crashes on load (move it to SYSTEM_PATHS or use a guarded dynamic import())`);
        } else if (!existsSync(join(ROOT, target))) {
          violations++;
          fail(`${file} statically imports ${spec}, which does not exist`);
        }
      }
    }
    if (violations === 0) {
      pass(`${checked} relative static imports across ${files.length} SYSTEM_PATHS .mjs files all resolve inside SYSTEM_PATHS`);
    }
  }
}
