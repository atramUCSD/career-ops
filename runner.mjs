#!/usr/bin/env node
/**
 * runner.mjs — the scheduled chains as one Node entry point, so career-ops runs
 * on its own: Task Scheduler starts career-ops.exe, the exe starts this file,
 * and no terminal or model is involved.
 *
 *   node runner.mjs alert       scrape, triage, snapshot, mail (07:00 and 19:00)
 *   node runner.mjs sweep       weekly deep hydration (Sunday 03:00)
 *   node runner.mjs sync        one cloud sync pass (every 10 minutes, once deployed)
 *   node runner.mjs status      scheduled tasks and the latest log rows
 *   node runner.mjs home        write output/status.html and open it (the exe's default)
 *   node runner.mjs build-exe   compile scripts/launcher.cs to career-ops.exe
 *   node runner.mjs install [--sync] [--dry-run]
 *                               register the scheduled tasks on career-ops.exe
 *
 * scripts/alert.cmd and scripts/sweep.cmd are one-line shims onto this file, so
 * a task still registered on them runs the same chain. Every decision lives here
 * and in the stage scripts. The exe only finds node and this file, so a fix here
 * never needs a rebuild.
 *
 * Every stage is deterministic. No model is invoked and nothing is ever
 * submitted on anyone's behalf: this path reads job boards and writes email.
 */
import { spawnSync } from 'node:child_process';
import { appendFileSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parsePendingRows } from './swarm.mjs';
import { isMainModule } from './lib/is-main-module.mjs';
import { validateFlags } from './lib/cli-flags.mjs';

const ROOT = dirname(fileURLToPath(import.meta.url));
export const EXE = 'career-ops.exe';
const LOG = join('data', 'alert-log.tsv');

/** Spawns `node <argv>` from the repo root and returns its exit code. */
export const nodeExec = root => argv =>
  spawnSync(process.execPath, argv, { cwd: root, stdio: 'inherit' }).status ?? 1;

/**
 * Appends `when stage result` rows to data/alert-log.tsv. Every row of one run
 * carries the run's start time, in local wall time with no zone, which is what
 * the .cmd chains wrote with (Get-Date).ToString('s'), so old and new rows sort
 * together.
 */
export function tsvLog(root, now = new Date()) {
  const file = join(root, LOG);
  const when = new Date(now - now.getTimezoneOffset() * 60000).toISOString().slice(0, 19);
  return (stage, result) => {
    if (!existsSync(file)) {
      mkdirSync(dirname(file), { recursive: true });
      writeFileSync(file, 'when\tstage\tresult\n');
    }
    appendFileSync(file, `${when}\t${stage}\t${result}\n`);
  };
}

const profileNames = root => {
  const dir = join(root, 'profiles');
  return existsSync(dir)
    ? readdirSync(dir).filter(n => statSync(join(dir, n)).isDirectory()).sort()
    : [];
};

/**
 * One scheduled run. A failed stage on the critical path stops the chain: a
 * failed scan must never be followed by a mail, which would report "no change"
 * and mark a day of postings as seen, so they would never appear in a later
 * mail. Everything off that path logs a row and the chain carries on.
 */
export function alert({ exec, log, root = ROOT }) {
  // swarm.mjs owns preflight, scan, liveness and prune, and exits non-zero on
  // lane registration drift, which is the right place for the chain to stop.
  if (exec(['swarm.mjs', '--scan', '--since', '45', '--stale', '45'])) {
    log('triage', 'FAILED - snapshot and alert skipped');
    return 1;
  }
  // A title-only row is capped at 25 for a lane keyword and 62 for a target
  // title, so the mail depends on reading descriptions. Not fatal: an unread
  // row keeps its title-only score, and a later read that lifts it into a top
  // band mails it as "upgraded". LinkedIn is skipped, see --skip in enrich-jd.mjs.
  if (exec(['enrich-jd.mjs', '--skip', 'linkedin.com'])) log('enrich', 'FAILED - continuing');
  if (exec(['build-artifact.mjs'])) {
    log('artifact', 'FAILED - alert skipped');
    return 1;
  }

  // A profile with its own config/alerts.yml is a separate user: its own scan,
  // pipeline, page and mail, under the same fail-stop rules as the owner. Any
  // other profile is a projection of the scan that just ran, so it is only a
  // second render. Neither may take the owner's mail down with it.
  for (const name of profileNames(root)) {
    const dir = join('profiles', name);
    if (!existsSync(join(root, dir, 'config', 'alerts.yml'))) {
      if (exec(['build-artifact.mjs', '--as-profile', name, '--out', join('output', `pipeline-${name}.html`)])) {
        log(`profile ${name}`, 'FAILED - continuing');
      }
      continue;
    }
    if (exec(['profiles.mjs', 'run', name, 'scan.mjs', '--since', '45'])) {
      log(`profile ${name} scan`, 'FAILED - mail skipped');
      continue;
    }
    if (exec(['profiles.mjs', 'run', name, 'enrich-jd.mjs', '--skip', 'linkedin.com'])) {
      log(`profile ${name} enrich`, 'FAILED - continuing');
    }
    // alert.cmd mailed even when this failed, attaching the previous run's page.
    if (exec(['build-artifact.mjs', '--root', dir])) {
      log(`profile ${name} artifact`, 'FAILED - mail skipped');
      continue;
    }
    if (exec(['notify-email.mjs', '--root', dir])) log(`profile ${name} alert`, 'FAILED - continuing');
    else log(`profile ${name}`, 'ok');
  }

  if (exec(['build-hub.mjs'])) log('hub', 'FAILED - continuing');
  if (exec(['calendar-alert.mjs'])) log('calendar', 'FAILED - continuing');
  if (exec(['notify-email.mjs'])) {
    log('alert', 'FAILED - state left untouched, next run re-alerts');
    return 1;
  }
  log('run', 'ok');
  return 0;
}

/**
 * The weekly deep pass, kept off the daily run because its two stages are the
 * slow ones: scan-ats-full.mjs sweeps whole public ATS directories, and a full
 * liveness check falls back to Playwright, which is sequential by design.
 */
export function sweep({ exec, log, root = ROOT }) {
  // scan-ats-full.mjs deletes its checkpoint on a clean finish and exits 1 on
  // --resume with no checkpoint, so --resume is passed only after an
  // interrupted sweep. --since 10 overlaps a sweep that slipped a day.
  const resume = existsSync(join(root, 'data', 'cache', 'ats-full-checkpoint.json')) ? ['--resume'] : [];
  if (exec(['scan-ats-full.mjs', '--since', '10', ...resume])) {
    log('sweep-ats', 'FAILED - hn, liveness and prune skipped');
    return 1;
  }
  if (exec(['scan-hn.mjs'])) {
    log('sweep-hn', 'FAILED - liveness and prune skipped');
    return 1;
  }
  const urls = join(tmpdir(), 'career-ops-sweep-pending.txt');
  try {
    let text = '';
    try { text = readFileSync(join(root, 'data', 'pipeline.md'), 'utf-8'); } catch {}
    writeFileSync(urls, parsePendingRows(text).map(r => r.url).join('\n') + '\n');
  } catch {
    log('sweep-liveness', 'FAILED - could not build the pending URL list, prune skipped');
    return 1;
  }
  // check-liveness.mjs exits 1 whenever anything is expired or uncertain. That
  // is its report, not a failure: guarding it would log FAILED on every sweep
  // and the prune would never run.
  exec(['check-liveness.mjs', '--file', urls, '--throttle']);
  rmSync(urls, { force: true });
  if (exec(['prune-pipeline.mjs', '--stale', '45'])) {
    log('sweep-prune', 'FAILED');
    return 1;
  }
  log('sweep', 'ok');
  return 0;
}

/** One cloud pass. Only failures are logged: at one pass every 10 minutes, a success row would bury the run rows. */
export function sync({ exec, log, root = ROOT }) {
  // node reads .env itself, so the service token never passes through here.
  if (!existsSync(join(root, '.env'))) {
    log('sync', 'FAILED - no .env');
    return 1;
  }
  if (exec(['--env-file=.env', join('cloud', 'sync-runner.mjs'), '--once'])) {
    log('sync', 'FAILED');
    return 1;
  }
  return 0;
}

// ------------------------------------------------------------ status and home

const TASKS_PS = `Get-ScheduledTask -TaskName 'career-ops-*' -ErrorAction SilentlyContinue | ForEach-Object {
  $i = $_ | Get-ScheduledTaskInfo
  [pscustomobject]@{
    name = $_.TaskName
    action = ($_.Actions[0].Execute + ' ' + $_.Actions[0].Arguments).Trim()
    last = $(if ($i.LastRunTime) { $i.LastRunTime.ToString('s') } else { '' })
    result = $i.LastTaskResult
    next = $(if ($i.NextRunTime) { $i.NextRunTime.ToString('s') } else { '' })
  }
} | ConvertTo-Json -Compress`;

// Task Scheduler's own codes; anything else is the runner's exit code.
const RESULT = { 0: 'ok', 267009: 'running', 267011: 'not yet run' };

function readTasks() {
  const r = spawnSync('powershell', ['-NoProfile', '-Command', TASKS_PS], { encoding: 'utf-8' });
  try {
    return [].concat(JSON.parse(r.stdout || '[]'))
      .map(t => ({ ...t, result: RESULT[t.result] ?? `exit ${t.result}` }));
  } catch {
    return [];
  }
}

export function statusData(root = ROOT, tasks = readTasks()) {
  const file = join(root, LOG);
  const rows = existsSync(file)
    ? readFileSync(file, 'utf-8').trimEnd().split('\n').slice(1).slice(-20).reverse().map(l => l.split('\t'))
    : [];
  // Links are relative to output/, where status.html is written.
  const pages = [['pipeline (you)', 'output/pipeline-artifact.html', 'pipeline-artifact.html'], ['hub', 'output/hub.html', 'hub.html']];
  for (const name of profileNames(root)) {
    pages.push([`${name} (own scan)`, `profiles/${name}/output/pipeline-artifact.html`, `../profiles/${name}/output/pipeline-artifact.html`]);
    pages.push([`${name} (projection)`, `output/pipeline-${name}.html`, `pipeline-${name}.html`]);
  }
  return { tasks, rows, pages: pages.filter(([, path]) => existsSync(join(root, path))).map(([label, , href]) => ({ label, href })) };
}

const esc = s => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;');

export function renderStatus({ tasks, rows, pages }, now = new Date()) {
  const failed = rows.some(r => /FAILED/.test(r[2] || ''));
  return `<!DOCTYPE html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>career-ops status</title>
<style>
body { font: 15px/1.5 system-ui, sans-serif; margin: 24px auto; max-width: 860px; padding: 0 16px; color: #1b2126; background: #f6f7f5; }
h1 { font-size: 22px; } h2 { font-size: 16px; margin-top: 28px; }
table { border-collapse: collapse; width: 100%; font-size: 14px; font-variant-numeric: tabular-nums; }
th, td { text-align: left; padding: 5px 8px; border-bottom: 1px solid #d5dad6; vertical-align: top; }
th { color: #5b6670; font-weight: 600; }
.bad { color: #a12c2c; font-weight: 600; } .note { background: #e9ece7; padding: 10px 12px; border-left: 3px solid #2b5d8a; }
</style></head><body>
<h1>career-ops</h1>
<p>Written ${esc(now.toLocaleString())}.</p>
${failed ? '<p class="note">A recent stage failed. Paste this page, or data/alert-log.tsv, into the Claude session that maintains career-ops.</p>' : ''}
<h2>Pages</h2>
<ul>${pages.map(p => `<li><a href="${esc(p.href)}">${esc(p.label)}</a></li>`).join('') || '<li>none built yet</li>'}</ul>
<h2>Scheduled tasks</h2>
<table><tr><th>Task</th><th>Last run</th><th>Result</th><th>Next run</th></tr>
${tasks.map(t => `<tr><td>${esc(t.name)}</td><td>${esc(t.last)}</td><td${t.result === 'ok' ? '' : ' class="bad"'}>${esc(t.result)}</td><td>${esc(t.next)}</td></tr>`).join('\n') || '<tr><td colspan="4">none registered</td></tr>'}
</table>
<h2>Recent log rows</h2>
<table><tr><th>When</th><th>Stage</th><th>Result</th></tr>
${rows.map(([when, stage, result = '']) => `<tr><td>${esc(when)}</td><td>${esc(stage)}</td><td${/FAILED/.test(result) ? ' class="bad"' : ''}>${esc(result)}</td></tr>`).join('\n') || '<tr><td colspan="3">no runs logged yet</td></tr>'}
</table>
</body></html>
`;
}

function status(root) {
  const { tasks, rows } = statusData(root);
  for (const t of tasks) console.log(`${t.name}\tlast ${t.last || '-'}\t${t.result}\tnext ${t.next || '-'}\t${t.action}`);
  if (!tasks.length) console.log('no career-ops tasks registered');
  console.log(rows.map(r => r.join('\t')).join('\n') || 'no runs logged yet');
  return 0;
}

function home(root) {
  const out = join(root, 'output', 'status.html');
  mkdirSync(dirname(out), { recursive: true });
  writeFileSync(out, renderStatus(statusData(root)));
  spawnSync('explorer.exe', [out]); // explorer exits 1 even on success
  return 0;
}

// --------------------------------------------------------- exe and scheduling

export function buildExe(root = ROOT) {
  // csc 4.x ships with every Windows install. /target:winexe is the GUI
  // subsystem, so a scheduled run opens no console window.
  const csc = join(process.env.WINDIR || 'C:\\Windows', 'Microsoft.NET', 'Framework64', 'v4.0.30319', 'csc.exe');
  if (!existsSync(csc)) {
    console.error(`runner: csc.exe not found at ${csc}`);
    return 1;
  }
  return spawnSync(csc, ['/nologo', '/target:winexe', `/out:${join(root, EXE)}`, join(root, 'scripts', 'launcher.cs')],
    { stdio: 'inherit' }).status ?? 1;
}

/** The PowerShell that registers the tasks; --dry-run prints it instead. -Force replaces a task of the same name. */
export function installScript(root = ROOT, { sync: withSync = false } = {}) {
  const q = s => `'${s.replace(/'/g, "''")}'`;
  const task = (name, arg, triggers, settings) => `Register-ScheduledTask -TaskName ${q(name)} -Force`
    + ` -Action (New-ScheduledTaskAction -Execute ${q(join(root, EXE))} -Argument ${q(arg)} -WorkingDirectory ${q(root)})`
    + ` -Trigger @(${triggers}) -Settings (New-ScheduledTaskSettingsSet ${settings}) | Out-Null`;
  // The schtasks defaults skip a run that starts on battery and stop one when
  // the charger is pulled, so an unplugged laptop at 07:00 missed the mail.
  const base = '-StartWhenAvailable -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -MultipleInstances IgnoreNew';
  const lines = [
    task('career-ops-alert', 'alert',
      '(New-ScheduledTaskTrigger -Daily -At 07:00), (New-ScheduledTaskTrigger -Daily -At 19:00)',
      `${base} -WakeToRun -ExecutionTimeLimit (New-TimeSpan -Hours 72)`),
    task('career-ops-sweep', 'sweep',
      '(New-ScheduledTaskTrigger -Weekly -DaysOfWeek Sunday -At 03:00)',
      `${base} -WakeToRun -ExecutionTimeLimit (New-TimeSpan -Hours 72)`),
  ];
  // No -WakeToRun: waking a sleeping laptop every 10 minutes costs battery for
  // a page nobody is reading. 30 minutes because a queued scan runs inside the pass.
  if (withSync) lines.push(task('career-ops-sync', 'sync',
    '(New-ScheduledTaskTrigger -Once -At (Get-Date) -RepetitionInterval (New-TimeSpan -Minutes 10))',
    `${base} -ExecutionTimeLimit (New-TimeSpan -Minutes 30)`));
  return lines.join('\n');
}

function install(root, { sync: withSync, dryRun }) {
  const ps = installScript(root, { sync: withSync });
  if (dryRun) {
    console.log(ps);
    return 0;
  }
  if (!existsSync(join(root, EXE)) && buildExe(root)) return 1;
  return spawnSync('powershell', ['-NoProfile', '-Command', ps], { stdio: 'inherit' }).status ?? 1;
}

// ----------------------------------------------------------------------- CLI

const USAGE = `Usage: node runner.mjs [alert|sweep|sync|status|home|build-exe|install] [--sync] [--dry-run]
  alert       scrape, triage, snapshot, mail
  sweep       weekly deep hydration
  sync        one cloud sync pass (needs .env)
  status      scheduled tasks and the latest log rows
  home        write output/status.html and open it (default)
  build-exe   compile scripts/launcher.cs to ${EXE}
  install     register career-ops-alert and -sweep on ${EXE}; --sync adds
              career-ops-sync; --dry-run prints the PowerShell instead`;
const CHAINS = { alert, sweep, sync };

export function main(argv, root = ROOT) {
  validateFlags(argv, ['--sync', '--dry-run', '--help', '-h'], USAGE, { requireOperand: true });
  const [cmd = 'home', ...extra] = argv.filter(a => !a.startsWith('-'));
  if (extra.length) {
    console.error(`runner: unexpected ${extra.join(' ')}\n${USAGE}`);
    return 1;
  }
  if (CHAINS[cmd]) return CHAINS[cmd]({ exec: nodeExec(root), log: tsvLog(root), root });
  if (cmd === 'status') return status(root);
  if (cmd === 'home') return home(root);
  if (cmd === 'build-exe') return buildExe(root);
  if (cmd === 'install') return install(root, { sync: argv.includes('--sync'), dryRun: argv.includes('--dry-run') });
  console.error(`runner: unknown command ${cmd}\n${USAGE}`);
  return 1;
}

if (isMainModule(import.meta.url)) process.exit(main(process.argv.slice(2)));
