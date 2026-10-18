// tests/dir-lock.test.mjs — the one directory-lock protocol, and the failures
// its former copies each carried (#5358).
//
// Until #5358 the core had four acquire/recover/release bodies — pipeline-lock,
// tracker-utils, followup-seed, portal-health-lock — sharing the helpers but
// not the loop, and the loops had drifted. Each test below fails on the copy
// that had the defect and passes on lib/dir-lock.mjs, which every wrapper now
// calls. They run against the wrappers, not just the primitive, because "the
// wrapper still routes through the shared loop" is the property that drifts.
//
// The faults are injected, not raced for. Each one is a window a few
// microseconds wide between two syscalls, so a real race would make the test a
// lottery. fs.writeFileSync is patched and syncBuiltinESMExports() pushes the
// patch into the lock module's named `import { writeFileSync } from 'fs'`, so
// the code under test runs unmodified and meets the fault at the exact line.
//
// Run: node --test tests/dir-lock.test.mjs

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs, { mkdtempSync, mkdirSync, rmSync, existsSync, readFileSync } from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { acquireDirLock, DirLockTimeoutError } from '../lib/dir-lock.mjs';
import { acquirePortalHealthLock, LockTimeoutError as PortalLockTimeoutError } from '../portal-health-lock.mjs';
import { acquirePipelineLock } from '../pipeline-lock.mjs';
import { acquireTrackerLock } from '../tracker-utils.mjs';
import { withFollowupsLock } from '../followup-seed.mjs';

const FAST = { timeoutMs: 300, retryMs: 10, staleMs: 60_000 };

/**
 * Replace fs.writeFileSync for the lock's owner.json under `lockDir`, once.
 * `onOwnerWrite(realWrite, path, data, options)` decides what that one write
 * does; every other write passes through untouched.
 */
function interceptOwnerWrite(lockDir, onOwnerWrite) {
  const realWrite = fs.writeFileSync;
  let fired = false;
  fs.writeFileSync = (path, data, options) => {
    if (!fired && String(path) === join(lockDir, 'owner.json')) {
      fired = true;
      return onOwnerWrite(realWrite, path, data, options);
    }
    return realWrite(path, data, options);
  };
  syncBuiltinESMExports();
  return {
    get fired() { return fired; },
    restore() {
      fs.writeFileSync = realWrite;
      syncBuiltinESMExports();
    },
  };
}

const errno = (code, path) => Object.assign(new Error(`${code}: injected, open '${path}'`), { code, path });

// A live lock belonging to someone else: this process's pid, so it is never
// judged stale, and a token no caller under test holds.
function plantPeerLock(realWrite, lockDir, token = 'peer') {
  mkdirSync(lockDir);
  realWrite(join(lockDir, 'owner.json'), JSON.stringify({ pid: process.pid, token, started_at: new Date().toISOString() }));
}

const ownerToken = (lockDir) => JSON.parse(readFileSync(join(lockDir, 'owner.json'), 'utf-8')).token;

function scratch(t, prefix) {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

// portal-health-lock answered ANY failed owner write by removing lockDir and
// rethrowing. ENOENT means our directory was already taken from us, so by the
// time the catch runs the path can hold a newer caller's live lock — and the
// rm freed it, putting two processes inside the critical section.
test('an ENOENT owner write is a lost race: the newer lock at the path is left alone', async (t) => {
  const dir = scratch(t, 'dir-lock-enoent-');
  const filePath = join(dir, 'portal-health.tsv');
  const lockDir = `${filePath}.lock`;
  const fault = interceptOwnerWrite(lockDir, (realWrite, path) => {
    // Our directory is reclaimed out from under us, a peer takes the path, and
    // our stamp write lands on nothing.
    rmSync(lockDir, { recursive: true, force: true });
    plantPeerLock(realWrite, lockDir);
    throw errno('ENOENT', path);
  });
  t.after(() => fault.restore());

  await assert.rejects(
    acquirePortalHealthLock(filePath, FAST),
    (err) => err instanceof PortalLockTimeoutError,
    'the caller must go back to waiting on the peer, not throw the raw ENOENT',
  );
  assert.ok(fault.fired, 'the injected owner-write failure was reached');
  assert.equal(ownerToken(lockDir), 'peer', "the peer's live lock must survive our failed acquisition");
});

// followup-seed had mkdir and the owner write in ONE try, so an EPERM/EACCES
// from the write was classified as mkdir contention. The caller then waited on
// the ownerless directory it had just created itself, timed out after the full
// budget, and left an orphan that blocked every writer until the stale age-out.
test('an EPERM owner write fails at once and leaves no ownerless lock behind', async (t) => {
  const dir = scratch(t, 'dir-lock-eperm-');
  const followups = join(dir, 'follow-ups.md');
  const lockDir = join(dir, 'career-ops-followups-test.lock');
  const fault = interceptOwnerWrite(lockDir, (_realWrite, path) => { throw errno('EPERM', path); });
  t.after(() => fault.restore());

  const started = Date.now();
  let entered = false;
  await assert.rejects(
    withFollowupsLock(followups, () => { entered = true; }, { lockDir, timeoutMs: 5_000, retryMs: 10, staleMs: 60_000 }),
    (err) => err.code === 'EPERM',
    'the stamp failure is the caller\'s own error, not contention to wait out',
  );
  assert.ok(Date.now() - started < 2_000, `it must not wait out the lock budget on its own directory (took ${Date.now() - started}ms)`);
  assert.equal(entered, false, 'the critical section never ran');
  assert.equal(existsSync(lockDir), false, 'the directory it created is removed, so nobody waits on an ownerless lock');
});

// tracker-utils and followup-seed returned a handle as soon as their own stamp
// write succeeded. A reclaimer that deletes the lock and a peer that re-takes
// it in the instant AFTER that write leaves no error anywhere: both processes
// believe they hold the lock. Reading the stamp back is what notices.
test('a stamp replaced right after it is written is not taken as ours', async (t) => {
  const dir = scratch(t, 'dir-lock-readback-');
  const lockDir = join(dir, 'career-ops-merge-tracker-test.lock');
  const fault = interceptOwnerWrite(lockDir, (realWrite, path, data, options) => {
    realWrite(path, data, options); // our stamp lands...
    rmSync(lockDir, { recursive: true, force: true });
    plantPeerLock(realWrite, lockDir); // ...and is replaced before we look again
  });
  t.after(() => fault.restore());

  await assert.rejects(
    acquireTrackerLock(lockDir, { ...FAST, tracker: join(dir, 'applications.md') }),
    (err) => err.code === 'LOCK_TIMEOUT',
    'the tracker writer must keep waiting rather than enter alongside the peer',
  );
  assert.ok(fault.fired, 'the injected replacement was reached');
  assert.equal(ownerToken(lockDir), 'peer', 'the peer still holds the lock');
});

// Every wrapper writes the same stamp shape, so every reader (stale recovery,
// the timeout diagnosis, the Go dashboard's tracker reader) can parse any lock.
// followup-seed alone wrote `startedAt`.
test('every wrapper stamps pid, token and started_at plus its own diagnostic field', async (t) => {
  const dir = scratch(t, 'dir-lock-stamp-');
  const cases = [
    ['pipeline', () => acquirePipelineLock(join(dir, 'pipeline.md'), FAST), join(dir, 'pipeline.md.lock'), 'pipeline'],
    ['portal-health', () => acquirePortalHealthLock(join(dir, 'portal-health.tsv'), FAST), join(dir, 'portal-health.tsv.lock'), 'file'],
    ['tracker', () => acquireTrackerLock(join(dir, 'tracker.lock'), { ...FAST, tracker: 'x' }), join(dir, 'tracker.lock'), 'tracker'],
  ];
  for (const [label, acquire, lockDir, field] of cases) {
    const lock = await acquire();
    try {
      const owner = JSON.parse(readFileSync(join(lockDir, 'owner.json'), 'utf-8'));
      assert.equal(owner.pid, process.pid, `${label}: pid`);
      assert.equal(typeof owner.token, 'string', `${label}: token`);
      assert.ok(!Number.isNaN(Date.parse(owner.started_at)), `${label}: started_at`);
      assert.ok(field in owner, `${label}: ${field}`);
    } finally {
      lock.release();
    }
    assert.equal(existsSync(lockDir), false, `${label}: release removes the lock`);
  }

  const followupsLock = join(dir, 'career-ops-followups-stamp.lock');
  let stamp;
  await withFollowupsLock(join(dir, 'follow-ups.md'), () => {
    stamp = JSON.parse(readFileSync(join(followupsLock, 'owner.json'), 'utf-8'));
  }, { lockDir: followupsLock, ...FAST });
  assert.ok(!Number.isNaN(Date.parse(stamp.started_at)), 'follow-ups: started_at');
  assert.ok('followups' in stamp, 'follow-ups: followups');
});

// The primitive with no caller-specific error still says what timed out and
// why, so a new wrapper cannot ship a bare "timeout" by forgetting a factory.
test('a timeout without a caller factory names the lock and its holder', async (t) => {
  const dir = scratch(t, 'dir-lock-timeout-');
  const lockDir = join(dir, 'x.lock');
  plantPeerLock(fs.writeFileSync, lockDir);
  let info;
  await assert.rejects(acquireDirLock(lockDir, { ...FAST, timeoutError: (i) => { info = i; return new Error('t'); } }));
  assert.equal(info.owner.pid, process.pid);
  assert.equal(info.owner.alive, true);
  assert.match(info.diagnosis, /owner=/);
  await assert.rejects(acquireDirLock(lockDir, FAST), (err) => err instanceof DirLockTimeoutError
    && err.code === 'LOCK_TIMEOUT' && err.lockDir === lockDir);
});

/**
 * Make fs.readFileSync fail with EPERM for the lock's owner.json, `times`
 * times (Infinity for every read) — the momentary sharing violation Windows
 * answers while waiters churn a live holder's directory.
 */
function failOwnerReads(lockDir, times) {
  const realRead = fs.readFileSync;
  let failed = 0;
  fs.readFileSync = (path, options) => {
    if (String(path) === join(lockDir, 'owner.json') && failed < times) {
      failed++;
      throw errno('EPERM', path);
    }
    return realRead(path, options);
  };
  syncBuiltinESMExports();
  return {
    get failed() { return failed; },
    restore() {
      fs.readFileSync = realRead;
      syncBuiltinESMExports();
    },
  };
}

// The stamp read-back treated ANY unreadable stamp as a lost lock. A failed
// read is not an absent stamp: the caller went back to wait on its own live
// directory, timed out after the whole budget (60s for the tracker), and left
// an orphan carrying its live pid that blocked every other writer.
test('a stamp that is unreadable for a moment is re-read, not taken as lost', async (t) => {
  const dir = scratch(t, 'dir-lock-readback-eperm-');
  const lockDir = join(dir, 'career-ops-merge-tracker-eperm.lock');
  const reads = failOwnerReads(lockDir, 2);
  t.after(() => reads.restore());

  const lock = await acquireTrackerLock(lockDir, { ...FAST, tracker: join(dir, 'applications.md') });
  assert.equal(reads.failed, 2, 'the read-back met the injected failures');
  assert.equal(lock.attempts, 1, 'acquired on the first attempt, not after competing with itself');
  reads.restore();
  lock.release();
  assert.equal(existsSync(lockDir), false, 'and the lock it holds releases normally');
});

test('a stamp that stays unreadable falls back to the directory we created', async (t) => {
  const dir = scratch(t, 'dir-lock-readback-stuck-');
  const lockDir = join(dir, 'career-ops-merge-tracker-stuck.lock');
  const reads = failOwnerReads(lockDir, Infinity);
  t.after(() => reads.restore());

  const lock = await acquireTrackerLock(lockDir, { ...FAST, tracker: join(dir, 'applications.md') });
  assert.ok(reads.failed > 1, 'the read-back retried before falling back');
  assert.equal(lock.attempts, 1, 'the same directory, untouched, is still ours');
  reads.restore();
  assert.equal(ownerToken(lockDir), lock.token, 'and it really does carry our stamp');
  lock.release();
});

// The stamp write used to be a plain overwrite. If our directory was replaced
// by another caller's between our mkdir and our write, our token landed in
// THEIR lock, our read-back found it, and both processes held the lock: they
// had stamped and checked before we overwrote. The write is exclusive now, so
// a stamp already in the directory means it is not ours.
test('a directory replaced before our stamp write keeps its holder\'s stamp', async (t) => {
  const dir = scratch(t, 'dir-lock-replaced-');
  const lockDir = join(dir, 'career-ops-merge-tracker-replaced.lock');
  const fault = interceptOwnerWrite(lockDir, (realWrite, path, data, options) => {
    rmSync(lockDir, { recursive: true, force: true });
    plantPeerLock(realWrite, lockDir); // the new holder has stamped already
    return realWrite(path, data, options); // ...and only then does our write land
  });
  t.after(() => fault.restore());

  await assert.rejects(
    acquireTrackerLock(lockDir, { ...FAST, tracker: join(dir, 'applications.md') }),
    (err) => err.code === 'LOCK_TIMEOUT',
    'the caller must wait on the new holder, not take its lock over',
  );
  assert.ok(fault.fired, 'the injected replacement was reached');
  assert.equal(ownerToken(lockDir), 'peer', "the new holder's stamp was not overwritten");
});
