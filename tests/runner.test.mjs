// runner — the scheduled chains' orchestration, with a fake exec. Which stages
// run, in what order, and which failure stops what, for the owner and for both
// kinds of profile layer. The general persona is the separate layer (it has its
// own config/alerts.yml); a profile without one is a projection.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { alert, sweep, sync, tsvLog, installScript, renderStatus, statusData, home, WEB } from '../runner.mjs';

const fixture = fileURLToPath(new URL('./fixtures/personas/general', import.meta.url));

function setup(t) {
  const root = mkdtempSync(join(tmpdir(), 'runner-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  cpSync(fixture, join(root, 'profiles', 'riley'), { recursive: true });
  mkdirSync(join(root, 'profiles', 'plain', 'config'), { recursive: true });
  return root;
}

/** exec that records each call and fails the ones whose argv starts with a listed prefix. */
function fakeExec(fail = []) {
  const calls = [];
  const exec = argv => {
    calls.push(argv.join(' '));
    return fail.some(f => argv.join(' ').startsWith(f)) ? 1 : 0;
  };
  return { exec, calls };
}

function fakeLog() {
  const rows = [];
  return { log: (stage, result) => rows.push(`${stage}: ${result}`), rows };
}

const layer = p => join('profiles', 'riley', p ?? '').replace(/[\\/]$/, '');

test('alert: full chain, owner then layers then hub, calendar and the owner mail last', t => {
  const root = setup(t);
  const { exec, calls } = fakeExec();
  const { log, rows } = fakeLog();
  assert.equal(alert({ exec, log, root }), 0);
  assert.deepEqual(calls, [
    'swarm.mjs --scan --since 45 --stale 45 --liveness-skip linkedin.com',
    'enrich-jd.mjs --skip linkedin.com',
    'build-artifact.mjs',
    `build-artifact.mjs --as-profile plain --out ${join('output', 'pipeline-plain.html')}`,
    'profiles.mjs run riley scan.mjs --since 45',
    'profiles.mjs run riley enrich-jd.mjs --skip linkedin.com',
    `build-artifact.mjs --root ${layer()}`,
    `notify-email.mjs --root ${layer()}`,
    'build-hub.mjs',
    'calendar-alert.mjs',
    'notify-email.mjs',
  ]);
  assert.deepEqual(rows, ['profile riley: ok', 'run: ok']);
});

test('alert: a failed scan stops everything, so no posting is marked seen unmailed', t => {
  const { exec, calls } = fakeExec(['swarm.mjs']);
  const { log, rows } = fakeLog();
  assert.equal(alert({ exec, log, root: setup(t) }), 1);
  assert.deepEqual(calls, ['swarm.mjs --scan --since 45 --stale 45 --liveness-skip linkedin.com']);
  assert.deepEqual(rows, ['triage: FAILED - snapshot and alert skipped']);
});

test('alert: a liveness check that died is logged and the mail still goes', t => {
  const calls = [];
  const exec = argv => (calls.push(argv[0]), argv[0] === 'swarm.mjs' ? 3 : 0);
  const { log, rows } = fakeLog();
  assert.equal(alert({ exec, log, root: setup(t) }), 0);
  assert.equal(calls.at(-1), 'notify-email.mjs');
  assert.deepEqual(rows, ['liveness: FAILED - continuing', 'profile riley: ok', 'run: ok']);
});

test('alert: a failed owner page skips the mail; failed reads, hub and calendar do not', t => {
  const a = fakeExec(['build-artifact.mjs']);
  const la = fakeLog();
  assert.equal(alert({ exec: a.exec, log: la.log, root: setup(t) }), 1);
  assert.ok(!a.calls.some(c => c.startsWith('notify-email')));
  assert.deepEqual(la.rows, ['artifact: FAILED - alert skipped']);

  const b = fakeExec(['enrich-jd.mjs', 'build-hub.mjs', 'calendar-alert.mjs']);
  const lb = fakeLog();
  assert.equal(alert({ exec: b.exec, log: lb.log, root: setup(t) }), 0);
  assert.equal(b.calls.at(-1), 'notify-email.mjs');
  assert.deepEqual(lb.rows, ['enrich: FAILED - continuing', 'profile riley: ok', 'hub: FAILED - continuing', 'calendar: FAILED - continuing', 'run: ok']);
});

test('alert: a layer whose scan or page fails is not mailed, and the owner still is', t => {
  for (const [stage, row] of [
    ['profiles.mjs run riley scan.mjs', 'profile riley scan: FAILED - mail skipped'],
    // alert.cmd never checked this one and mailed with the previous run's page.
    [`build-artifact.mjs --root ${layer()}`, 'profile riley artifact: FAILED - mail skipped'],
  ]) {
    const { exec, calls } = fakeExec([stage]);
    const { log, rows } = fakeLog();
    assert.equal(alert({ exec, log, root: setup(t) }), 0);
    assert.ok(!calls.includes(`notify-email.mjs --root ${layer()}`), stage);
    assert.equal(calls.at(-1), 'notify-email.mjs');
    assert.deepEqual(rows, [row, 'run: ok']);
  }
});

test('alert: a failed layer mail or projection is logged and the chain goes on; a failed owner mail fails the run', t => {
  const a = fakeExec([`notify-email.mjs --root`, 'build-artifact.mjs --as-profile']);
  const la = fakeLog();
  assert.equal(alert({ exec: a.exec, log: la.log, root: setup(t) }), 0);
  assert.deepEqual(la.rows, ['profile plain: FAILED - continuing', 'profile riley alert: FAILED - continuing', 'run: ok']);

  const b = fakeExec(['notify-email.mjs']);
  const lb = fakeLog();
  assert.equal(alert({ exec: b.exec, log: lb.log, root: setup(t) }), 1);
  assert.equal(lb.rows.at(-1), 'alert: FAILED - state left untouched, next run re-alerts');
});

test('sweep: liveness findings are not failures, the pending list is the pipeline, --resume only after an interrupted sweep', async t => {
  const root = setup(t);
  mkdirSync(join(root, 'data'), { recursive: true });
  cpSync(join(fixture, 'data', 'pipeline.md'), join(root, 'data', 'pipeline.md'));
  let listed = '';
  const { exec, calls } = fakeExec();
  const liveness = async args => {
    calls.push(`check-liveness.mjs ${args.join(' ')}`);
    listed = readFileSync(args[1], 'utf-8');
    return { status: 1, finished: true };
  };
  const { log, rows } = fakeLog();
  assert.equal(await sweep({ exec, log, root, liveness }), 0);
  assert.equal(calls[0], 'scan-ats-full.mjs --since 10');
  assert.deepEqual(calls.slice(1).map(c => c.split(' ')[0]), ['scan-hn.mjs', 'check-liveness.mjs', 'prune-pipeline.mjs']);
  assert.equal(listed.trim().split('\n').length, 10);
  assert.match(listed, /^https:\/\/boards\.greenhouse\.io\/acmedata\/jobs\/1$/m);
  assert.deepEqual(rows, ['sweep: ok']);

  const died = fakeExec();
  const ld = fakeLog();
  assert.equal(await sweep({ exec: died.exec, log: ld.log, root, liveness: async () => ({ status: 1, finished: false }) }), 0);
  assert.equal(died.calls.at(-1), 'prune-pipeline.mjs --stale 45');
  assert.deepEqual(ld.rows, ['sweep-liveness: FAILED - continuing', 'sweep: ok']);

  mkdirSync(join(root, 'data', 'cache'), { recursive: true });
  writeFileSync(join(root, 'data', 'cache', 'ats-full-checkpoint.json'), '{}');
  const again = fakeExec(['scan-hn.mjs']);
  const l2 = fakeLog();
  assert.equal(await sweep({ exec: again.exec, log: l2.log, root }), 1);
  assert.deepEqual(again.calls, ['scan-ats-full.mjs --since 10 --resume', 'scan-hn.mjs']);
  assert.deepEqual(l2.rows, ['sweep-hn: FAILED - liveness and prune skipped']);
});

test('sync: needs .env, which node reads itself; only failures are logged', t => {
  const root = setup(t);
  const a = fakeExec();
  const la = fakeLog();
  assert.equal(sync({ exec: a.exec, log: la.log, root }), 1);
  assert.deepEqual([a.calls, la.rows], [[], ['sync: FAILED - no .env']]);

  writeFileSync(join(root, '.env'), '');
  const b = fakeExec();
  const lb = fakeLog();
  assert.equal(sync({ exec: b.exec, log: lb.log, root }), 0);
  assert.deepEqual([b.calls, lb.rows], [[`--env-file=.env ${join('cloud', 'sync-runner.mjs')} --once`], []]);
});

test('log: one header, then rows stamped with the run start in local time', t => {
  const root = setup(t);
  const now = new Date(2026, 9, 30, 7, 0, 5);
  const log = tsvLog(root, now);
  log('run', 'ok');
  log('hub', 'FAILED - continuing');
  assert.equal(readFileSync(join(root, 'data', 'alert-log.tsv'), 'utf-8'),
    'when\tstage\tresult\n2026-10-30T07:00:05\trun\tok\n2026-10-30T07:00:05\thub\tFAILED - continuing\n');
});

test('install: alert twice daily and the weekly sweep in local time, runnable on battery; sync only on request and never wakes the machine', () => {
  const ps = installScript('C:\\it\'s\\career-ops');
  assert.match(ps, /-TaskName 'career-ops-alert'.*-Argument 'alert'.*-Daily -At 07:00.*-Daily -At 19:00/);
  assert.match(ps, /-TaskName 'career-ops-sweep'.*-DaysOfWeek Sunday -At 03:00/);
  assert.match(ps, /-Execute 'C:\\it''s\\career-ops\\career-ops\.exe'/);
  assert.equal(ps.match(/-AllowStartIfOnBatteries -DontStopIfGoingOnBatteries/g).length, 3);
  const dash = ps.split('\n').find(l => l.includes('career-ops-dashboard'));
  assert.match(dash, /-Argument 'serve'.*-AtLogOn -User "\$env:USERDOMAIN\\\$env:USERNAME"/);
  assert.doesNotMatch(dash, /WakeToRun|ExecutionTimeLimit/);
  // Local wall time, so the 07:00 run stays at 07:00 across a DST change.
  assert.equal(ps.match(/\(Local \(New-ScheduledTaskTrigger/g).length, 3);
  assert.ok(ps.split('\n').includes("function Local($t) { $t.StartBoundary = ([datetime]$t.StartBoundary).ToString('s'); $t }"));
  assert.doesNotMatch(ps, /career-ops-sync/);
  const sync = installScript('C:\\r', { sync: true }).split('\n').find(l => l.includes('career-ops-sync'));
  assert.match(sync, /-RepetitionInterval \(New-TimeSpan -Minutes 10\)/);
  assert.match(sync, /-ExecutionTimeLimit \(New-TimeSpan -Minutes 30\)/);
  assert.doesNotMatch(sync, /WakeToRun/);
});

test('status page: links only pages that exist, flags failures, escapes log text', t => {
  const root = setup(t);
  mkdirSync(join(root, 'output'), { recursive: true });
  writeFileSync(join(root, 'output', 'pipeline-artifact.html'), '');
  const log = tsvLog(root, new Date(2026, 9, 30, 7));
  log('profile riley scan', 'FAILED - <mail> skipped');
  const data = statusData(root, [{ name: 'career-ops-alert', last: '2026-10-30T07:00:00', result: 'exit 1', next: '2026-10-30T19:00:00' }]);
  assert.deepEqual(data.pages, [{ label: 'pipeline (you)', href: 'pipeline-artifact.html' }]);
  const html = renderStatus(data);
  assert.match(html, /Paste this page/);
  assert.match(html, /FAILED - &lt;mail> skipped/);
  assert.match(html, /class="bad">exit 1/);
  assert.ok(!existsSync(join(root, 'output', 'status.html')), 'rendering writes nothing');
});

test('status page: the banner follows each chain\'s latest run, not any failure in view', () => {
  const banner = rows => /A recent stage failed/.test(renderStatus({ tasks: [], rows, pages: [] }));
  const cleanAlert = [['2026-10-31T19:00:02', 'run', 'ok']];
  const failedAlert = [['2026-10-31T08:12:48', 'run', 'ok'], ['2026-10-31T08:12:48', 'calendar', 'FAILED - continuing']];
  const failedSweep = [['2026-10-25T03:00:00', 'sweep-liveness', 'FAILED - continuing'], ['2026-10-25T03:00:00', 'sweep', 'ok']];
  assert.ok(banner(failedAlert));
  assert.ok(!banner([...cleanAlert, ...failedAlert]));
  assert.ok(banner([...cleanAlert, ...failedSweep]));
  assert.ok(!banner([['2026-11-01T03:00:00', 'sweep', 'ok'], ...cleanAlert, ...failedSweep]));
});

test('home: reuses a running dashboard, starts one when none answers, falls back to the status page', async t => {
  const root = mkdtempSync(join(tmpdir(), 'runner-home-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const clean = { tasks: [], rows: [['2026-10-31T19:00:02', 'run', 'ok']], pages: [] };
  const failed = { ...clean, rows: [['2026-10-31T08:12:48', 'calendar', 'FAILED - continuing']] };
  const status = join(root, 'output', 'status.html');
  const run = async ({ up, starts, data = clean, installed = true }) => {
    const opened = [];
    let started = 0, live = up;
    await home({
      root, data, wait: 3000, open: x => opened.push(x),
      probe: async () => live,
      start: () => { started++; live = starts; return installed; },
    });
    return { opened, started };
  };

  assert.deepEqual(await run({ up: true }), { opened: [WEB], started: 0 });
  assert.deepEqual(await run({ up: false, starts: true }), { opened: [WEB], started: 1 });
  assert.deepEqual(await run({ up: true, data: failed }), { opened: [WEB, status], started: 0 });
  assert.deepEqual(await run({ up: false, starts: false, installed: false }), { opened: [status], started: 1 });
  assert.ok(existsSync(status));
});
