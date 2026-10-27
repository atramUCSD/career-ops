import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ROOT, rmSync } from './helpers.mjs';
import { describeSpawn } from './helpers/describe-spawn.mjs';

const SCRIPT = join(ROOT, 'set-status.mjs');
const TRACKER = [
  '# Applications',
  '',
  '| # | Date | Company | Role | Score | Status | PDF | Report | Notes |',
  '|---|---|---|---|---|---|---|---|---|',
  '| 1 | 2026-09-01 | Example Labs | Backend Engineer | 4/5 | Applied | - | - | - |',
  '',
].join('\n');

function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), 'career-ops-status-cas-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const data = join(root, 'data');
  mkdirSync(data);
  const tracker = join(data, 'applications.md');
  writeFileSync(tracker, TRACKER);
  return {
    root, data, tracker,
    env: { ...process.env, CAREER_OPS_ROOT: root, CAREER_OPS_DATA_DIR: '', CAREER_OPS_TRACKER: tracker },
  };
}

function run(f, ...args) {
  const r = spawnSync(process.execPath, [SCRIPT, ...args, '--json'], {
    cwd: f.root, env: f.env, encoding: 'utf8', timeout: 30_000,
  });
  assert.equal(r.error, undefined, r.error?.message);
  return { ...r, json: JSON.parse(r.stdout) };
}

const ledger = (f) => existsSync(join(f.data, 'status-log.tsv'))
  ? readFileSync(join(f.data, 'status-log.tsv'), 'utf8').trim().split('\n')
  : [];

test('a card still at --expect moves and logs source remote', (t) => {
  const f = fixture(t);
  const r = run(f, '--row', '1', 'Interview', '--expect', 'applied', '--source', 'remote', '--on', '2026-09-02');
  assert.equal(r.status, 0, describeSpawn(r));
  assert.equal(r.json.changed, true);
  assert.match(readFileSync(f.tracker, 'utf8'), /\| Interview \|/);
  assert.deepEqual(ledger(f), ['1\t2026-09-02\tApplied\tInterview\tremote']);
});

test('a card already at the target succeeds with no change', (t) => {
  const f = fixture(t);
  const r = run(f, '--row', '1', 'Applied', '--expect', 'Evaluated', '--source', 'remote');
  assert.equal(r.status, 0, describeSpawn(r));
  assert.equal(r.json.changed, false);
  assert.equal(readFileSync(f.tracker, 'utf8'), TRACKER);
  assert.deepEqual(ledger(f), []);
});

test('a card anywhere else exits stale without writing', (t) => {
  const f = fixture(t);
  const r = run(f, '--row', '1', 'Rejected', '--expect', 'Evaluated', '--source', 'remote');
  assert.equal(r.status, 5, describeSpawn(r));
  assert.equal(r.json.code, 'stale');
  assert.equal(r.json.current, 'Applied');
  assert.equal(r.json.expected, 'Evaluated');
  assert.equal(readFileSync(f.tracker, 'utf8'), TRACKER);
  assert.deepEqual(ledger(f), []);
});

test('a non-canonical --expect is a usage error before tracker access', (t) => {
  const f = fixture(t);
  f.env.CAREER_OPS_TRACKER = join(f.root, 'missing.md');
  const r = run(f, '--row', '1', 'Interview', '--expect', 'Sorta Applied');
  assert.equal(r.status, 1, describeSpawn(r));
  assert.equal(r.json.code, 'invalid-expect');
});
