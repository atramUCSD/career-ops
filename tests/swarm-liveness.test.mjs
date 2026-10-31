// swarm — stage 2 tells a liveness run that reached its Results line from one
// that died, since check-liveness.mjs exits 1 either way.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
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

test('liveness: --liveness-skip matches a host and its subdomains only', () => {
  assert.ok(skipsHost('https://www.linkedin.com/jobs/view/1', ['linkedin.com']));
  assert.ok(!skipsHost('https://notlinkedin.com/x', ['linkedin.com']));
  assert.ok(!skipsHost('not a url', ['linkedin.com']));
});
