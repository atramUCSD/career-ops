// test-all discovers only tests/, so the cloud/ self-check runs through here.
import { spawnSync } from 'node:child_process';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';

test('cloud/check.mjs passes', () => {
  const r = spawnSync(process.execPath, [fileURLToPath(new URL('../cloud/check.mjs', import.meta.url))], { encoding: 'utf8', timeout: 60_000 });
  assert.equal(r.status, 0, r.stderr || r.stdout);
  assert.match(r.stdout, /cloud check: ok/);
});
