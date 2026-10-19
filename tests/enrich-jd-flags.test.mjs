// enrich-jd.mjs flag parsing. --skip used to be read with indexOf, so
// `--skip=linkedin.com` was dropped and the scheduled run read LinkedIn
// unpaced. Valid forms are checked in-process through parseFlags; every
// failure path is spawned against an empty data root and must exit before
// creating anything in it, so no case here can reach the network or user data.
import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseFlags } from '../enrich-jd.mjs';

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const SCRIPT = join(ROOT, 'enrich-jd.mjs');
const SANDBOX = mkdtempSync(join(tmpdir(), 'career-ops-enrich-flags-'));

after(() => rmSync(SANDBOX, { recursive: true, force: true }));

function runEnrich(...args) {
  const result = spawnSync(process.execPath, [SCRIPT, ...args], {
    cwd: ROOT,
    encoding: 'utf-8',
    timeout: 30_000,
    env: { ...process.env, CAREER_OPS_ROOT: SANDBOX },
  });
  assert.equal(result.error, undefined, `enrich-jd.mjs failed to spawn: ${result.error?.message}`);
  assert.equal(result.signal, null, `enrich-jd.mjs was killed by ${result.signal} (timeout?)`);
  assert.deepEqual(readdirSync(SANDBOX), [], 'a flag error must exit before anything is written');
  return { ...result, all: `${result.stdout ?? ''}${result.stderr ?? ''}` };
}

test('--skip host and --skip=host parse the same', () => {
  assert.deepEqual(parseFlags(['--skip', 'linkedin.com']).skip, ['linkedin.com']);
  assert.deepEqual(parseFlags(['--skip=linkedin.com']).skip, ['linkedin.com']);
  assert.deepEqual(parseFlags(['--skip=LinkedIn.com, indeed.com']).skip, ['linkedin.com', 'indeed.com']);
});

test('the documented scheduled forms keep working', () => {
  const opts = parseFlags(['--retry-unread', '--skip', 'linkedin.com']);
  assert.equal(opts.retryUnread, true);
  assert.deepEqual(opts.skip, ['linkedin.com']);
  const counts = parseFlags(['--limit=20', '--stale', '30']);
  assert.equal(counts.limit, 20);
  assert.equal(counts.staleDays, 30);
  const none = parseFlags([]);
  assert.deepEqual([none.limit, none.staleDays, none.skip], [Infinity, null, []]);
});

for (const [args, message] of [
  [['--skip'], /--skip requires a value/],
  [['--skip', '--retry-unread'], /--skip requires a value/],
  [['--skip='], /--skip requires a value/],
  [['--skip=,'], /--skip needs at least one host/],
  [['--limit', 'abc'], /--limit needs a positive whole number/],
  [['--bogus'], /unrecognized flag\(s\): --bogus/],
  [['--help', '--bogus'], /unrecognized flag\(s\): --bogus/],
]) {
  test(`${args.join(' ')} exits 1 before reading anything`, () => {
    const result = runEnrich(...args);
    assert.equal(result.status, 1, `expected exit 1, got ${result.status}: ${result.all}`);
    assert.match(result.stderr, message);
  });
}

test('--help prints usage and exits 0', () => {
  const result = runEnrich('--help');
  assert.equal(result.status, 0, `expected exit 0, got ${result.status}: ${result.all}`);
  assert.match(result.stdout, /--skip linkedin\.com/);
});
