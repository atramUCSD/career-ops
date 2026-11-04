#!/usr/bin/env node
/**
 * notify-email.mjs — mail a snapshot of what changed in the pipeline.
 *
 * WHAT IT SENDS
 * A diff, never a dump. Each run compares the current pending set against
 * data/alert-state.json and reports only what is new since the last alert,
 * plus anything that has since crossed into a top match band, plus the
 * postings that retired. An unchanged pipeline sends nothing.
 *
 * TWO PAYLOADS
 *  1. An inline, statically-styled table in the message body. Deliberately not
 *     the artifact HTML: mail clients strip <script>, external stylesheets and
 *     CSS custom properties, so the interactive page cannot render in an inbox.
 *  2. output/pipeline-artifact.html attached whole, which opens fully
 *     interactive in a browser.
 *
 * WHAT IT NEVER DOES
 * Applies to anything. This path reads the pipeline and writes one email.
 *
 * FAILURE POSTURE
 * State is written only after Gmail returns 2xx. A failed send leaves every
 * posting marked unseen, so the next run re-alerts rather than silently
 * dropping a day of postings on the floor.
 *
 *   node notify-email.mjs --seed        # mark the current pipeline known, send nothing
 *   node notify-email.mjs --dry-run     # compose only; writes output/alert-preview.eml
 *   node notify-email.mjs --test        # send now, even if nothing changed; state untouched
 *   node notify-email.mjs               # compose and send
 *   node notify-email.mjs --to a@b.com  # override the configured recipient
 *   node notify-email.mjs --root profiles/<name>  # alert for another user layer
 */
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadYaml } from './lib/yaml-document.mjs';
import { buildModel } from './build-artifact.mjs';
import { BANDS } from './callback-score.mjs';
import { sendRaw } from './gmail-send.mjs';
import { isMainModule } from './lib/is-main-module.mjs';
import { flagValue, hasFlag, validateFlags } from './lib/cli-flags.mjs';
import { writeFileAtomic } from './tracker-utils.mjs';
import { analyzeFromContent, loadFollowupsEnabled } from './followup-cadence.mjs';
import { getProfilePath, resolveTrackerPath } from './path-resolver.mjs';

// The scheduled path (scripts/alert.cmd under Task Scheduler) runs with a
// minimal environment and sources nothing, so without this the three GMAIL_*
// variables never reach gmail-send.mjs and every unattended send fails on
// "missing credentials". Same idiom, and same optional-dependency posture, as
// scan.mjs.
try {
  const { config } = await import('dotenv');
  // quiet: the startup banner would otherwise land on stdout, which --dry-run
  // and the seed path keep clean.
  config({ quiet: true });
} catch {
  // dotenv is optional — fall back to whatever is already in process.env.
}

const ROOT = dirname(fileURLToPath(import.meta.url));
const STATE_PATH = 'data/alert-state.json';
const ARTIFACT_PATH = 'output/pipeline-artifact.html';

export const DEFAULTS = {
  enabled: true,
  to: '',
  min_match: 42,
  max_rows: 15,
  quiet_if_empty: true,
  attach_artifact: true,
  artifact_url: '',
  // Base URLs of the local web dashboard and the Cloudflare phone board. Either
  // one set adds links into that app; the local one also adds the follow-ups
  // digest. Blank keeps the mail as it was, which is what a profile layer mailed
  // to someone without this machine's dashboard needs.
  dashboard_url: '',
  cloud_url: '',
};

export function loadConfig(root = ROOT) {
  const path = join(root, 'config/alerts.yml');
  if (!existsSync(path)) return { ...DEFAULTS };
  const parsed = loadYaml(readFileSync(path, 'utf-8')) || {};
  const cfg = { ...DEFAULTS, ...(parsed.alerts || parsed) };
  // min_reply_odds was the pre-rewrite name on a 0-100 additive scale. An
  // existing config keeps working rather than going quiet, but it is read as
  // the same threshold on the new scale, so a stale 58 alerts on less.
  if (cfg.min_reply_odds !== undefined && (parsed.alerts || parsed).min_match === undefined) {
    cfg.min_match = cfg.min_reply_odds;
  }
  // A bare `dashboard_url:` parses to null and a port-only value to a number;
  // both reach .replace() at compose time.
  for (const k of ['dashboard_url', 'cloud_url']) cfg[k] = cfg[k] == null ? '' : String(cfg[k]);
  return cfg;
}

export function loadState(root = ROOT) {
  const path = join(root, STATE_PATH);
  if (!existsSync(path)) return { seen: [], strong: [], expired: 0, lastRun: null };
  try {
    const s = JSON.parse(readFileSync(path, 'utf-8'));
    return { seen: s.seen || [], strong: s.strong || [], expired: s.expired || 0, lastRun: s.lastRun || null };
  } catch {
    // A corrupt state file must not wedge the alert. Treat it as a first run:
    // one noisy email beats a silent scheduler.
    return { seen: [], strong: [], expired: 0, lastRun: null };
  }
}

export function saveState(state, root = ROOT) {
  const path = join(root, STATE_PATH);
  mkdirSync(dirname(path), { recursive: true });
  // Atomic: a run killed mid-write leaves the corrupt file that loadState reads
  // as a first run, re-mailing every alert.
  writeFileAtomic(path, JSON.stringify(state, null, 2) + '\n');
}

/**
 * What changed. `fresh` is what has never been alerted; `upgraded` is a
 * previously-alerted posting that has since reached a top band — worth a line,
 * because that is the one transition the match model can make in a favourable
 * direction after a posting is already known. A posting reaches it when its
 * description is finally read, or when a gate that was blocking it clears.
 */
export const TOP_BANDS = ['premier', 'strong'];

export function diffRows(rows, state, { min_match = 0, min_reply_odds } = {}) {
  const floor = min_match || min_reply_odds || 0;
  const seen = new Set(state.seen);
  const strongSeen = new Set(state.strong);
  const top = r => TOP_BANDS.includes(r.cbBand);
  const fresh = rows.filter(r => !seen.has(r.u) && r.cb >= floor);
  const upgraded = rows.filter(r => seen.has(r.u) && top(r) && !strongSeen.has(r.u));
  // Every row considered is marked seen, including the ones below the
  // threshold. They are already on the page; re-offering them every morning
  // would train the reader to ignore the mail.
  const nextSeen = [...new Set([...state.seen, ...rows.map(r => r.u)])];
  const nextStrong = [...new Set([...state.strong, ...rows.filter(top).map(r => r.u)])];
  return { fresh, upgraded, nextSeen, nextStrong };
}

const esc = s => String(s ?? '').replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

export function subjectFor({ fresh, upgraded, retired, date }) {
  const parts = [];
  if (fresh.length) parts.push(`${fresh.length} new`);
  const strong = fresh.filter(r => TOP_BANDS.includes(r.cbBand)).length + upgraded.length;
  if (strong) parts.push(`${strong} strong`);
  if (retired) parts.push(`${retired} retired`);
  return `career-ops — ${parts.join(', ') || 'no change'} (${date})`;
}

// Keyed off the scorer's own band list, in its own order, so a band rename
// cannot leave the mail painting every score the same grey. The ramp is the
// artifact's --fresh / --recent / --aging / --none / --stale, inlined because
// mail clients drop custom properties.
const BAND_RAMP = ['#2c7a51', '#3f7f6d', '#9a7420', '#8b8b8b', '#a04f2a'];
export const BAND_COLOR = Object.fromEntries(BANDS.map((b, i) => [b.id, BAND_RAMP[i] || '#4a6068']));

/**
 * Inline-styled table. Every rule is on the element: mail clients drop <style>
 * blocks, custom properties and class selectors, so the page's stylesheet is
 * of no use here and the two views are intentionally different documents.
 */
function rowsTable(rows, max) {
  const shown = rows.slice(0, max);
  const cell = 'padding:8px 10px;border-bottom:1px solid #d6dedf;font-size:14px;vertical-align:top';
  const head = 'padding:7px 10px;border-bottom:1px solid #c2cdcf;font-size:11px;letter-spacing:.08em;text-transform:uppercase;color:#4a6068;text-align:left';
  const body = shown.map(r => `<tr>
  <td style="${cell};font-weight:700;font-size:17px;color:${BAND_COLOR[r.cbBand] || '#4a6068'};white-space:nowrap">${r.cb}</td>
  <td style="${cell}"><a href="${esc(r.u)}" style="color:#0f6f6b;text-decoration:none;font-weight:600">${esc(r.c)}</a><br>
    <span style="color:#12242c">${esc(r.t)}</span></td>
  <td style="${cell};color:#74898f;font-size:12.5px;white-space:nowrap">${esc(r.seg)}<br>${r.age === null ? 'no date' : r.age + 'd'}</td>
</tr>`).join('');
  const more = rows.length > shown.length
    ? `<tr><td colspan="3" style="${cell};color:#74898f;font-size:12.5px">+ ${rows.length - shown.length} more in the attached snapshot</td></tr>`
    : '';
  return `<table cellpadding="0" cellspacing="0" style="border-collapse:collapse;width:100%;max-width:640px">
<tr><th style="${head}">Match</th><th style="${head}">Company &amp; role</th><th style="${head}">Where / age</th></tr>
${body}${more}</table>`;
}

/**
 * The follow-ups the dashboard's Follow-ups page flags today: overdue, plus
 * "urgent" (the company replied and the answer is still owed).
 */
export function dueFollowups(root = ROOT) {
  const tracker = resolveTrackerPath(root);
  if (!existsSync(tracker)) return [];
  const read = p => (existsSync(p) ? readFileSync(p, 'utf-8') : '');
  // ponytail: the cadence thresholds are the owner's (followup-cadence binds its
  // profile at import), so a layer with its own follow_ups cadence is judged
  // by the owner's. Thread a cadence through analyzeFromContent if one diverges.
  const { entries = [] } = analyzeFromContent(read(tracker), read(join(root, 'data/follow-ups.md')), {
    enabled: loadFollowupsEnabled(getProfilePath(root)),
    statusLogContent: read(join(dirname(tracker), 'status-log.tsv')),
  });
  return entries.filter(e => e.urgency === 'urgent' || e.urgency === 'overdue');
}

const link = (href, text) => `<a href="${esc(href)}" style="color:#0f6f6b;font-weight:600;text-decoration:none">${text}</a>`;

export function composeBody({ fresh, upgraded, model, cfg, date, due = [] }) {
  const wrap = s => `<div style="font-family:-apple-system,'Segoe UI',Helvetica,Arial,sans-serif;color:#12242c;background:#ffffff;padding:4px">${s}</div>`;
  const h = t => `<h2 style="font-size:15px;letter-spacing:.04em;text-transform:uppercase;color:#4a6068;margin:22px 0 8px">${t}</h2>`;
  const app = cfg.dashboard_url ? path => cfg.dashboard_url.replace(/\/+$/, '') + path : null;
  // The phone board has no per-posting route, only its two hash views.
  const cloud = cfg.cloud_url ? cfg.cloud_url.replace(/[#/]+$/, '') : '';
  const out = [];
  out.push(`<p style="margin:0 0 4px;font-size:13px;color:#74898f">career-ops · ${date} · ${model.rows.length} pending across ${new Set(model.rows.map(r => r.c)).size} companies</p>`);
  if (fresh.length) {
    out.push(h(`New since the last alert — ${fresh.length}`));
    out.push(rowsTable([...fresh].sort((a, b) => b.cb - a.cb), cfg.max_rows));
  }
  if (upgraded.length) {
    out.push(h(`Now a top match — ${upgraded.length}`));
    out.push(rowsTable([...upgraded].sort((a, b) => b.cb - a.cb), cfg.max_rows));
  }
  if (!fresh.length && !upgraded.length) {
    out.push(`<p style="margin:16px 0">No new postings this run.</p>`);
  } else if (app || cloud) {
    // The desk link is loopback and dead on the phone the mail is often read on.
    const acts = [
      cloud && link(cloud + '/#postings', 'Shortlist on your phone'),
      app && link(app('/pipeline'), cloud ? 'Score at your desk' : 'Score, shortlist or dismiss these in Pipeline'),
    ].filter(Boolean);
    out.push(`<p style="margin:10px 0 0;font-size:13.5px">${acts.join(' · ')}</p>`);
  }
  if (due.length) {
    const cell = 'padding:6px 10px;border-bottom:1px solid #d6dedf;font-size:14px;vertical-align:top';
    out.push(h(`Follow-ups due — ${due.length}`));
    out.push(`<table cellpadding="0" cellspacing="0" style="border-collapse:collapse;width:100%;max-width:640px">${due.slice(0, 5).map(e => `<tr>
  <td style="${cell}"><b>${esc(e.company)}</b><br><span style="color:#74898f;font-size:12.5px">${esc(e.role)}</span></td>
  <td style="${cell};white-space:nowrap;color:${e.urgency === 'urgent' ? '#a04f2a' : '#9a7420'}">${e.urgency === 'urgent' ? 'they replied' : 'overdue'} · ${e.daysSinceApplication}d</td>
</tr>`).join('')}${due.length > 5 ? `<tr><td colspan="2" style="${cell};color:#74898f;font-size:12.5px">+ ${due.length - 5} more</td></tr>` : ''}</table>`);
    if (app) out.push(`<p style="margin:8px 0 0;font-size:13.5px">${link(app('/followups'), 'Draft and log them in Follow-ups')}</p>`);
  }
  out.push(h('Snapshot'));
  out.push(`<p style="margin:0;font-size:14px;line-height:1.6">
    ${BANDS.filter(b => b.id !== 'blocked').map(b =>
      `${model.rows.filter(r => r.cbBand === b.id).length} ${b.id}`).join(' · ')} ·
    ${model.expired.count} retired to date${cfg.artifact_url ? ` · <a href="${esc(cfg.artifact_url)}" style="color:#0f6f6b">open the full page</a>` : ''}</p>`);
  // Labels match the app's nav (web/src/lib/nav-items.ts).
  const desk = app ? [['/', 'Home'], ['/pipeline', 'Pipeline'], ['/board', 'Board'], ['/followups', 'Follow-ups'],
    ['/cv', 'CV'], ['/analytics', 'Analytics'], ['/setup', 'Setup'], ['/config', 'Config']].map(([p, t]) => link(app(p), t)) : [];
  const phone = cloud ? [link(cloud + '/', 'Board'), link(cloud + '/#postings', 'Shortlist or run a scan')] : [];
  if (desk.length || phone.length) {
    out.push(h('Open the full app'));
    out.push(`<p style="margin:0;font-size:14px;line-height:1.9">${[
      desk.length ? `<span style="color:#74898f">At the desk</span>&nbsp; ${desk.join(' · ')}` : '',
      phone.length ? `<span style="color:#74898f">On the phone</span>&nbsp; ${phone.join(' · ')}` : '',
    ].filter(Boolean).join('<br>')}</p>`);
  }
  out.push(`<p style="margin:20px 0 0;font-size:12px;color:#74898f;line-height:1.6">
    Match is 100 × eligibility × fit × timing, read from the posting's own description — a prior on
    what is worth reading, not a fit score and not a verdict. A 0 means a hard gate fired (clearance,
    years, degree, comp floor) and the full page names which. Nothing in this pipeline applies to
    anything on your behalf.</p>`);
  return wrap(out.join('\n'));
}

const b64 = s => Buffer.from(s, 'utf-8').toString('base64').replace(/(.{76})/g, '$1\r\n');

/** RFC 5322 message: HTML body, optional artifact attachment. */
export function encodeMime({ to, subject, html, attachment }) {
  const boundary = 'careerops-' + subject.replace(/\W+/g, '').slice(0, 12) + '-b';
  const head = [
    `To: ${to}`,
    // RFC 2047 only when needed. The subject carries an em dash, so in
    // practice this branch is taken — the ASCII path exists so a subject that
    // does not need encoding stays readable in the .eml preview.
    `Subject: ${/^[\x20-\x7e]*$/.test(subject) ? subject : `=?UTF-8?B?${Buffer.from(subject).toString('base64')}?=`}`,
    'MIME-Version: 1.0',
  ];
  if (!attachment) {
    return [...head, 'Content-Type: text/html; charset="UTF-8"', 'Content-Transfer-Encoding: base64', '', b64(html)].join('\r\n');
  }
  return [
    ...head,
    `Content-Type: multipart/mixed; boundary="${boundary}"`,
    '',
    `--${boundary}`,
    'Content-Type: text/html; charset="UTF-8"',
    'Content-Transfer-Encoding: base64',
    '',
    b64(html),
    `--${boundary}`,
    `Content-Type: text/html; charset="UTF-8"; name="${attachment.name}"`,
    `Content-Disposition: attachment; filename="${attachment.name}"`,
    'Content-Transfer-Encoding: base64',
    '',
    b64(attachment.content),
    `--${boundary}--`,
    '',
  ].join('\r\n');
}

export const toBase64Url = mime =>
  Buffer.from(mime, 'utf-8').toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

/**
 * Compose the run. Pure enough to test: it reads the repo but sends nothing
 * and writes nothing. `send` is a separate step on purpose.
 */
export function composeRun({ root = ROOT, now = new Date(), cfg = null, model = null, test = false } = {}) {
  const config = cfg || loadConfig(root);
  const m = model || buildModel({ root, now });
  const state = loadState(root);
  const date = now.toISOString().slice(0, 10);
  const { fresh, upgraded, nextSeen, nextStrong } = diffRows(m.rows, state, config);
  const retired = Math.max(0, m.expired.count - state.expired);
  // A test proves the pipe works, so it sends even when nothing changed.
  const quiet = !test && config.quiet_if_empty && !fresh.length && !upgraded.length && !retired;

  const artifactPath = join(root, ARTIFACT_PATH);
  const attachment = config.attach_artifact && existsSync(artifactPath)
    ? { name: 'pipeline-artifact.html', content: readFileSync(artifactPath, 'utf-8') }
    : null;

  const subject = (test ? '[test] ' : '') + subjectFor({ fresh, upgraded, retired, date });
  // The digest is optional; a tracker it cannot read must not cost the alert.
  let due = [];
  if (config.dashboard_url) {
    try { due = dueFollowups(root); } catch (e) { console.error(`followups digest FAILED - ${e.message}`); }
  }
  const html = composeBody({ fresh, upgraded, model: m, cfg: config, date, due });
  return {
    quiet,
    subject,
    html,
    to: config.to,
    counts: { fresh: fresh.length, upgraded: upgraded.length, retired, pending: m.rows.length },
    mime: quiet ? '' : encodeMime({ to: config.to, subject, html, attachment }),
    nextState: { seen: nextSeen, strong: nextStrong, expired: m.expired.count, lastRun: now.toISOString() },
  };
}

// A mistyped flag here is not harmless: `--dryrun` used to fall through to a
// real send that also advanced the alert state.
const KNOWN_FLAGS = ['--dry-run', '--test', '--seed', '--to', '--root', '--help', '-h'];
const VALUE_FLAGS = ['--to', '--root'];

const USAGE = `Usage:
  node notify-email.mjs --seed        # mark the current pipeline known, send nothing
  node notify-email.mjs --dry-run     # compose only; writes output/alert-preview.eml
  node notify-email.mjs --test        # send now, even if nothing changed; state untouched
  node notify-email.mjs               # compose and send
  node notify-email.mjs --to a@b.com  # override the configured recipient
  node notify-email.mjs --root profiles/<name>  # alert for another user layer
  node notify-email.mjs --help|-h     # print this usage block and exit`;

async function main(argv) {
  validateFlags(argv, KNOWN_FLAGS, USAGE, { valueFlags: VALUE_FLAGS, requireOperand: true });
  const dry = hasFlag(argv, '--dry-run');
  const test = hasFlag(argv, '--test');
  const seed = hasFlag(argv, '--seed');
  const to = flagValue(argv, '--to');
  // Same flag as build-artifact.mjs: config, state, pipeline and attachment all
  // move to that user layer, so a profile gets its own recipient and its own diff.
  const rootArg = flagValue(argv, '--root');
  const root = rootArg ? resolve(rootArg) : ROOT;
  const cfg = loadConfig(root);
  if (to) cfg.to = to;
  // Off silences the scheduled run only. A test, a dry run or a seed is a
  // person asking for that one thing now.
  if (cfg.enabled === false && !test && !dry && !seed) {
    console.log('  alerts off in config/alerts.yml — nothing sent');
    return;
  }

  const run = composeRun({ root, cfg, test });
  const { fresh, upgraded, retired } = run.counts;

  // First run against an established pipeline is not an alert, it is a
  // backlog: 221 postings the reader already knows about. Seeding marks the
  // current state as known so the first scheduled mail is a real diff.
  if (seed) {
    saveState(run.nextState, root);
    console.log(`  seeded — ${run.nextState.seen.length} postings marked known, nothing sent`);
    return;
  }
  console.log(`${run.subject}\n  new ${fresh} · upgraded ${upgraded} · retired ${retired} · pending ${run.counts.pending}`);

  if (run.quiet) {
    console.log('  nothing changed — quiet_if_empty is on, no mail sent');
    return;
  }
  if (dry) {
    const out = join(root, 'output', 'alert-preview.eml');
    mkdirSync(dirname(out), { recursive: true });
    writeFileSync(out, run.mime);
    console.log(`  dry run — ${resolve(out)} (${Math.round(run.mime.length / 1024)}KB), nothing sent, state untouched`);
    return;
  }
  if (!run.to) {
    console.error('  no recipient: set alerts.to in config/alerts.yml or pass --to');
    process.exitCode = 1;
    return;
  }
  const id = await sendRaw(toBase64Url(run.mime));
  // A test leaves state alone, so the next scheduled digest still reports
  // everything the test showed.
  if (test) {
    console.log(`  test sent to ${run.to}${id ? ` (${id})` : ''}, state untouched`);
    return;
  }
  // Only now. A send that threw leaves every posting unseen for the next run.
  saveState(run.nextState, root);
  console.log(`  sent to ${run.to}${id ? ` (${id})` : ''}`);
}

if (isMainModule(import.meta.url)) {
  main(process.argv.slice(2)).catch(e => { console.error(`  ${e.message}`); process.exitCode = 1; });
}
