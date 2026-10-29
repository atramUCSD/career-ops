// ADR-001 steps 2, 5 and 7: apply the page's queued actions, then rebuild the read copy
// from this profile's files and push it as one snapshot when its hash changed. The files stay
// canonical and this PC stays their only writer; the copy in D1 is derived, and the
// server never edits it.
// Remote jobs (scan only, so far) queue through the same inbox and run here, one per pass.
//
//   node --env-file=.env cloud/sync-runner.mjs --once
//
// CAREER_OPS_CLOUD_URL points it at another site, e.g. http://127.0.0.1:8788 under
// a local server (from cloud/, with LOCAL_DEV_IDENTITY in .dev.vars and any non-empty
// CF_ACCESS_CLIENT_ID/SECRET for the runner). pages dev does not pick up the D1
// binding from wrangler.toml, so it is passed explicitly:
//   npx wrangler d1 execute <database_name> --local --persist-to .wrangler/state --file schema.sql
//   npx wrangler pages dev public --d1 DB=<database_id> --port 8788 --persist-to .wrangler/state
//
// The card rows are what the local /board page and its card panel read
// (web/src/app/board/page.tsx, web/src/app/api/board/[n]/route.ts), built from the
// same web/src/lib modules, so the hosted page shows what the local one shows.

import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import { gzipSync } from 'node:zlib';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { getCareerOpsRoot, resolveTrackerPath } from '../path-resolver.mjs';
import { acquireTrackerLock, loadCanonicalStates, resolveCanonicalState, trackerLockDirFor } from '../tracker-utils.mjs';
import { localToday } from '../lib/local-today.mjs';
import { parseCliJson } from '../web/src/lib/status-cli.mjs';
import { readTrackerFile } from '../web/src/lib/core/tracker-files.mjs';
import { parseApplications } from '../web/src/lib/tracker-table.mjs';
import { buildTimeline, expiredOn, parseReportMeta, parseStatusLog, scanSighting } from '../web/src/lib/board-activity.mjs';
import { BOARD_COLUMNS, boardColumn, isSkipDecision } from '../web/src/lib/board-columns.mjs';
import { isReservedReportFile } from '../web/src/lib/report-files.mjs';
import { isMainModule } from '../lib/is-main-module.mjs';
import { buildModel } from '../build-artifact.mjs';
import { readShortlist } from '../web/src/lib/ui-state.mjs';
import { JOB_KINDS } from './lib/inbox.mjs';
import { buildScanCommand, extractRolesFound, SCAN_TIMEOUT_MS } from '../web/scripts/scheduled-jobs-runner.mjs';
import { scanFailureMessage } from '../web/src/lib/scheduled-scan-error.mjs';
import { withResourceLock } from '../web/src/lib/scheduled-jobs-store.mjs';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const STATES_FILE = path.join(REPO, 'templates/states.yml');
// The deployed site's URL lives in the gitignored wrangler.toml with the other account
// IDs, because this repo is public. Resolved per request so --help and imports work
// on a checkout that has no wrangler.toml.
export function siteUrl(env = process.env, tomlFile = path.join(REPO, 'cloud/wrangler.toml')) {
  if (env.CAREER_OPS_CLOUD_URL) return env.CAREER_OPS_CLOUD_URL;
  const m = readIf(tomlFile).match(/^SITE_URL\s*=\s*"([^"]+)"/m);
  if (m) return m[1];
  throw new Error('No site URL: set CAREER_OPS_CLOUD_URL or SITE_URL in cloud/wrangler.toml (see wrangler.example.toml)');
}
// D1 caps one value at 2 MB, and the snapshot is one value. At ~0.6 MB gzipped for
// 8k postings that is ~26k rows of headroom.
// ponytail: one D1 value; move the snapshot to R2 (no size cap) before it gets here.
const MAX_SNAPSHOT_CHARS = 1_900_000;

const readIf = (file) => {
  try {
    return fs.readFileSync(file, 'utf8');
  } catch (err) {
    if (err.code === 'ENOENT') return '';
    throw err;
  }
};

const jsonl = (text) =>
  text.split('\n').flatMap((line) => {
    try {
      return line.trim() ? [JSON.parse(line)] : [];
    } catch {
      return []; // torn final line from a crash mid-append
    }
  });

// Scanned postings nobody has evaluated yet, as compact cards with only the fields
// a phone list needs. Age is left out (the page derives it from p) so a row changes
// only when its score steps at one of freshScore's age boundaries, not every day.
// Gated rows, rows past the window, descriptions and jd facts stay on the PC.
const POSTING_WINDOW_DAYS = 45;
export function postingRows(root, now = new Date()) {
  if (!fs.existsSync(path.join(root, 'data/pipeline.md'))) return [];
  const cutoff = new Date(now - POSTING_WINDOW_DAYS * 864e5).toISOString().slice(0, 10);
  const byId = new Map(); // the pipeline can list one URL twice; the first row wins
  for (const r of buildModel({ root, now }).rows) {
    if (r.status !== 'pending' || r.gate || (r.p && r.p < cutoff)) continue;
    const id = `posting:${createHash('sha1').update(r.u).digest('hex')}`;
    if (!byId.has(id)) {
      byId.set(id, { id, kind: 'posting', data: { u: r.u, c: r.c, t: r.t, l: r.l, p: r.p, lane: r.lane, cb: r.cb, band: r.cbBand, gov: r.gov ?? null } });
    }
  }
  return [...byId.values()];
}

export function buildCopy(root) {
  const read = (rel) => readIf(path.join(root, rel));
  const apps = parseApplications(readTrackerFile(root) ?? '', root, REPO);
  let reports = [];
  try {
    reports = fs.readdirSync(path.join(root, 'reports')).filter((f) => f.endsWith('.md') && !isReservedReportFile(f));
  } catch (err) {
    if (err.code !== 'ENOENT') throw err;
  }
  const events = jsonl(read('data/board-activity.jsonl'));
  const ledger = read('data/status-log.tsv');
  const scans = read('data/scan-history.tsv');
  const expired = read('data/expired-jobs.md');

  const rows = apps.map((app) => {
    // ponytail: matches reports by number only; the web reader prefers the tracker's
    // report link first. They differ only if a link points at another number's file.
    const file = reports.find((f) => parseInt(f, 10) === Number(app.n));
    const meta = parseReportMeta(file ? read(`reports/${file}`) : '');
    const url = meta.header.URL ?? '';
    const timeline = buildTimeline({
      app,
      ledger: parseStatusLog(ledger, app.n),
      sighting: scanSighting(scans, url),
      expired: expiredOn(expired, url),
      events: events.filter((e) => e.n === app.n),
    });
    const skip = isSkipDecision(meta.summary?.final_decision);
    return { id: `card:${app.n}`, kind: 'card', data: { app, lane: boardColumn(app.status), skip, meta, timeline } };
  });
  rows.push(...postingRows(root));
  // The page offers the states the PC accepts, read from states.yml, never hard-coded.
  rows.push({ id: 'states', kind: 'meta', data: loadCanonicalStates(STATES_FILE) });
  rows.push({ id: 'columns', kind: 'meta', data: BOARD_COLUMNS });
  rows.push({ id: 'shortlist', kind: 'meta', data: readShortlist(path.join(root, 'data/ui-state.json')) });
  return rows;
}

/** The copy as the page receives it: a version (hash of the JSON) and the gzipped JSON as base64. */
export function snapshot(rows) {
  const json = JSON.stringify({ rows });
  return { version: createHash('sha256').update(json).digest('hex').slice(0, 32), body: gzipSync(json).toString('base64') };
}

// ── inbox (step 5) ────────────────────────────────────────────────

const rejected = (reason, message, extra = {}) => ({ status: 'rejected', result: { reason, message, ...extra } });

/** A state name from states.yml as its canonical label, or null. The store checks shape only. */
export function canonicalState(value, states) {
  return typeof value === 'string' && !/[|*\r\n]/.test(value) ? resolveCanonicalState(value, states) : null;
}

/**
 * set-status's verdict as an inbox outcome. null means "busy, try next run": the
 * action stays pending and nothing is logged, so the retry is a fresh attempt.
 */
export function moveOutcome(exitCode, out, { to, from }) {
  if (exitCode === 0) return { status: 'applied', result: { changed: Boolean(out?.changed), to } };
  if (exitCode === 4) return null;
  if (exitCode === 5) return rejected('stale', out?.error ?? 'the card moved since', { current: out?.current, expected: from });
  return rejected(out?.code ?? 'error', out?.error ?? `set-status exited ${exitCode}`);
}

/** Apply one pending action to the profile's files. Returns an outcome, or null to retry later. */
export async function applyAction(root, action, states) {
  const n = String(action.payload?.n ?? '');
  if (!/^\d+$/.test(n)) return rejected('invalid', 'no tracker row number');

  if (action.type === 'move') {
    const to = canonicalState(action.payload.to, states);
    const from = canonicalState(action.precondition?.from, states);
    if (!to || !from) return rejected('invalid', 'states must come from states.yml');
    // The day the user moved the card, on this PC's calendar; clamped so phone clock
    // skew can never hand set-status a future --on, which it refuses.
    const day = localToday(new Date(action.createdAt));
    const on = day > localToday() ? localToday() : day;
    // A child process, not an import: set-status owns the tracker lock, the ledger
    // row and Applied follow-up seeding, and its exit code is the contract.
    const r = spawnSync(
      process.execPath,
      [path.join(REPO, 'set-status.mjs'), '--row', n, to, '--expect', from, '--source', 'remote', '--on', on, '--json'],
      { cwd: REPO, env: process.env, encoding: 'utf8', timeout: 120_000, windowsHide: true },
    );
    if (r.error) throw r.error;
    return moveOutcome(r.status, parseCliJson(r.stdout), { to, from });
  }

  if (action.type === 'comment') {
    const text = typeof action.payload.text === 'string' ? action.payload.text.trim() : '';
    if (!text || text.length > 2000) return rejected('invalid', 'a comment needs 1 to 2000 characters');
    if (!parseApplications(readTrackerFile(root) ?? '', root, REPO).some((app) => app.n === n)) {
      return rejected('not-found', `No tracker row #${n}`);
    }
    // Same lock the web board route takes for its own appends.
    const tracker = resolveTrackerPath(root);
    let lock;
    try {
      lock = await acquireTrackerLock(trackerLockDirFor(tracker), { timeoutMs: 10_000, tracker });
    } catch (err) {
      if (err.code === 'LOCK_TIMEOUT') return null;
      throw err;
    }
    try {
      const file = path.join(root, 'data', 'board-activity.jsonl');
      // The uuid makes the append idempotent across a crash before the log line.
      if (!jsonl(readIf(file)).some((e) => e.uuid === action.uuid)) {
        fs.appendFileSync(file, JSON.stringify({ at: action.createdAt, n, kind: 'comment', text, uuid: action.uuid, source: 'remote' }) + '\n');
      }
    } finally {
      await lock.release();
    }
    return { status: 'applied', result: {} };
  }

  return rejected('invalid', `unknown action type "${action.type}"`);
}

/**
 * Pull, validate, apply and record every pending action; returns the outcomes to
 * acknowledge. The log is written before the acknowledgement, so an action already
 * in it is never applied twice: its recorded outcome is sent again instead.
 */
export async function drainInbox(root, pending) {
  if (!pending.length) return [];
  const logFile = path.join(root, 'data', 'inbox-log.jsonl');
  const logged = new Map(jsonl(readIf(logFile)).map((e) => [e.uuid, e]));
  const states = loadCanonicalStates(STATES_FILE);
  const results = [];
  for (const action of pending) {
    let entry = logged.get(action.uuid);
    if (!entry) {
      const outcome = await applyAction(root, action, states);
      if (!outcome) continue;
      entry = { uuid: action.uuid, seq: action.seq, type: action.type, payload: action.payload, sender: action.sender, ...outcome, at: new Date().toISOString() };
      fs.mkdirSync(path.dirname(logFile), { recursive: true });
      fs.appendFileSync(logFile, JSON.stringify(entry) + '\n');
    }
    results.push({ uuid: entry.uuid, status: entry.status, result: entry.result });
  }
  return results;
}

// ADR-001 step 7. Jobs share the inbox log with moves and comments, one line per
// status change, so the log alone says how many started today and whether one
// already finished (an outcome logged but never acknowledged is replayed, not rerun).
export const JOBS_PER_DAY = 6;
const FINAL = new Set(['done', 'failed', 'rejected']);
const MAX_STARTS = 2;

function jobLog(root) {
  const byUuid = new Map();
  for (const e of jsonl(readIf(path.join(root, 'data', 'inbox-log.jsonl')))) {
    if (e.type === 'job') byUuid.set(e.uuid, [...(byUuid.get(e.uuid) ?? []), e]);
  }
  return byUuid;
}

function logJob(root, job, status, result = {}) {
  const file = path.join(root, 'data', 'inbox-log.jsonl');
  const entry = { uuid: job.uuid, seq: job.seq, type: 'job', payload: job.payload, sender: job.sender, status, result, at: new Date().toISOString() };
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.appendFileSync(file, JSON.stringify(entry) + '\n');
  return { uuid: job.uuid, status, result };
}

/** Accept or refuse each new job request. Accepted ones are acknowledged as queued. */
export function queueJobs(root, pending, now = new Date()) {
  const log = jobLog(root);
  const today = localToday(now);
  let used = [...log.values()].filter((entries) => entries.some((e) => e.status === 'queued' && localToday(new Date(e.at)) === today)).length;
  return pending.map((job) => {
    const entries = log.get(job.uuid) ?? [];
    const final = entries.find((e) => FINAL.has(e.status));
    if (final) return { uuid: job.uuid, status: final.status, result: final.result };
    if (entries.some((e) => e.status === 'queued')) return { uuid: job.uuid, status: 'queued', result: {} };
    if (!JOB_KINDS.includes(job.payload?.kind)) return logJob(root, job, 'rejected', { reason: 'invalid', message: `unknown job kind "${job.payload?.kind}"` });
    if (used >= JOBS_PER_DAY) return logJob(root, job, 'rejected', { reason: 'cap', message: `${JOBS_PER_DAY} jobs a day; try tomorrow` });
    used++;
    return logJob(root, job, 'queued');
  });
}

/** The portal scan the web's scheduled jobs run, against this profile's own portals.yml. */
export function runScan(root) {
  const { script, args } = buildScanCommand({ engine: 'portals' });
  const r = spawnSync(process.execPath, [path.join(REPO, script), ...args], {
    cwd: REPO,
    env: { ...process.env, CAREER_OPS_ROOT: root },
    encoding: 'utf8',
    timeout: SCAN_TIMEOUT_MS,
    maxBuffer: 10 * 1024 * 1024,
    windowsHide: true,
  });
  if (r.status === 0) return { status: 'done', result: { found: extractRolesFound('portals', r.stdout ?? '') } };
  return { status: 'failed', result: { message: scanFailureMessage(r, { timeoutMs: SCAN_TIMEOUT_MS }) } };
}

/**
 * Run the oldest open job, one per pass, under a lock so a second runner never starts
 * it again. The lock is the heartbeat: a job still marked running when the lock is
 * free was cut off (the PC slept or the process died), so it runs again, up to
 * MAX_STARTS. Returns the final outcome to acknowledge, or null when there is none.
 * `start` is called with the running acknowledgement before the job begins.
 */
export async function runNextJob(root, open, { exec = { scan: runScan }, start = async () => {} } = {}) {
  if (!open.length) return null;
  try {
    return await withResourceLock(path.join(root, 'data', 'cloud-jobs'), async () => {
      const log = jobLog(root);
      for (const job of open) {
        const final = (log.get(job.uuid) ?? []).find((e) => FINAL.has(e.status));
        if (final) return { uuid: job.uuid, status: final.status, result: final.result };
      }
      const job = open[0];
      const starts = (log.get(job.uuid) ?? []).filter((e) => e.status === 'running').length;
      if (starts >= MAX_STARTS) return logJob(root, job, 'failed', { message: `cut off ${starts} times; not retried` });
      const run = exec[job.payload?.kind];
      if (!run) return logJob(root, job, 'rejected', { reason: 'invalid', message: `unknown job kind "${job.payload?.kind}"` });
      // The running status only feeds the page, so a failed send must not keep the job from running.
      const running = logJob(root, job, 'running');
      await Promise.resolve().then(() => start(running)).catch((err) => console.warn(`job ${job.uuid}: running ack failed: ${err.message}`));
      const outcome = run(root);
      return logJob(root, job, outcome.status, outcome.result);
    }, { timeoutMs: 1_000, staleMs: SCAN_TIMEOUT_MS + 60_000 });
  } catch (err) {
    if (err.code === 'LOCK_TIMEOUT') return null; // another runner holds the job
    throw err;
  }
}

async function api(route, method, body, headers = {}) {
  const res = await fetch(`${siteUrl()}${route}`, {
    method,
    headers: {
      'CF-Access-Client-Id': process.env.CF_ACCESS_CLIENT_ID,
      'CF-Access-Client-Secret': process.env.CF_ACCESS_CLIENT_SECRET,
      'content-type': typeof body === 'string' ? 'text/plain' : 'application/json',
      ...headers,
    },
    body: typeof body === 'string' ? body : body && JSON.stringify(body),
    // A rejected token gets a 302 to the Access login, which fetch would follow to a 200 HTML page.
    redirect: 'manual',
  });
  if (!res.ok) throw new Error(`${method} ${route}: HTTP ${res.status}`);
  return res.json();
}

async function once() {
  if (!process.env.CF_ACCESS_CLIENT_ID || !process.env.CF_ACCESS_CLIENT_SECRET) {
    throw new Error('CF_ACCESS_CLIENT_ID / CF_ACCESS_CLIENT_SECRET unset; run with node --env-file=.env');
  }
  const root = getCareerOpsRoot();
  const open = await api('/api/inbox', 'GET');
  const isJob = (a) => a.type === 'job';
  const results = [
    ...(await drainInbox(root, open.filter((a) => !isJob(a)))),
    ...queueJobs(root, open.filter((a) => isJob(a) && a.status === 'pending')),
  ];
  const ack = async (list) => (list.length ? (await api('/api/inbox', 'PUT', { results: list })).settled ?? 0 : 0);

  // Acknowledge after the push, so a settled move never shows on the page before
  // the copy that has the card in its new lane.
  const pushed = await pushCopy(root);
  const settled = await ack(results);
  console.log(`inbox: ${results.length} settled (${settled} new); copy: ${pushed}`);

  // One job per pass, after the copy is current. A scan can take many minutes; the
  // timer task skips its ticks meanwhile (IgnoreNew), and the page shows it running.
  // ponytail: jobs run inline; detach them if a long scan starving the copy matters.
  const queued = new Set(results.filter((r) => r.status === 'queued').map((r) => r.uuid));
  const jobs = open.filter((a) => isJob(a) && (queued.has(a.uuid) || a.status === 'queued' || a.status === 'running'));
  const done = await runNextJob(root, jobs, { start: (r) => ack([r]) });
  if (done) {
    const after = await pushCopy(root);
    await ack([done]);
    console.log(`job: ${done.status} ${JSON.stringify(done.result)}; copy: ${after}`);
  }
}

async function pushCopy(root) {
  const rows = buildCopy(root);
  const snap = snapshot(rows);
  const push = (body) => api('/api/sync', 'POST', body, { 'x-copy-version': snap.version });
  // Always POST, even with nothing changed: the pushed_at bump tells the page the PC is
  // current. The snapshot itself goes up only when the server holds another version.
  const sent = (await push(null)).version !== snap.version;
  if (sent) {
    if (snap.body.length > MAX_SNAPSHOT_CHARS) throw new Error(`snapshot is ${snap.body.length} chars, over D1's 2 MB value cap; move it to R2`);
    const { version } = await push(snap.body);
    if (version !== snap.version) throw new Error(`push stored version ${version}, expected ${snap.version}`);
  }
  return `${rows.length} rows, ${sent ? `pushed ${snap.body.length} chars` : 'unchanged'}`;
}

const USAGE = 'usage: node --env-file=.env cloud/sync-runner.mjs --once';
if (isMainModule(import.meta.url) && (process.argv.includes('--help') || process.argv.includes('-h'))) {
  console.log(USAGE);
} else if (process.argv.includes('--once')) {
  await once();
} else if (isMainModule(import.meta.url)) {
  console.error(USAGE);
  process.exitCode = 2;
}
