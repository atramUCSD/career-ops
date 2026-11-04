// swarm — stage 2 tells a liveness run that reached its Results line from one
// that died, since check-liveness.mjs exits 1 either way.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runLiveness, skipsHost } from '../swarm.mjs';

test('liveness: exit 1 with a Results line finished; exit 1 without one did not', async t => {
  const dir = mkdtempSync(join(tmpdir(), 'swarm-liveness-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const report = join(dir, 'report.mjs');
  writeFileSync(report, [
    "console.log('x'.repeat(70000));",
    "console.log('\\nResults: 1 active  1 expired  0 uncertain  (2 via API, no browser)');",
    'process.exitCode = 1;',
  ].join('\n'));
  const dead = join(dir, 'dead.mjs');
  writeFileSync(dead, "console.log('checking');\nimport('./missing-module.mjs');\n");

  assert.deepEqual(await runLiveness([], report), { status: 1, finished: true });
  assert.deepEqual(await runLiveness([], dead), { status: 1, finished: false });
});

test('liveness: a run that goes silent before Results is killed with its children', async t => {
  const dir = mkdtempSync(join(tmpdir(), 'swarm-liveness-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const pidFile = join(dir, 'grandchild.pid');
  const hung = join(dir, 'hung.mjs');
  // The grandchild stands in for a wedged browser the check launched.
  writeFileSync(hung, [
    "import { spawn } from 'node:child_process';",
    "import { writeFileSync } from 'node:fs';",
    "const g = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' });",
    `writeFileSync(${JSON.stringify(pidFile)}, String(g.pid));`,
    "console.log('checking 1 URL');",
    'setInterval(() => {}, 1000);',
  ].join('\n'));

  const started = Date.now();
  const r = await runLiveness([], hung, { stallMs: 1500 });
  assert.equal(r.finished, false);
  assert.equal(r.stalled, true);
  assert.ok(Date.now() - started < 15000, 'killed promptly');
  const alive = pid => { try { process.kill(pid, 0); return true; } catch { return false; } };
  assert.equal(alive(Number(readFileSync(pidFile, 'utf-8'))), false, 'grandchild reaped');
});

test('liveness: --liveness-skip matches a host and its subdomains only', () => {
  assert.ok(skipsHost('https://www.linkedin.com/jobs/view/1', ['linkedin.com']));
  assert.ok(!skipsHost('https://notlinkedin.com/x', ['linkedin.com']));
  assert.ok(!skipsHost('not a url', ['linkedin.com']));
});
