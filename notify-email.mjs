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
 *   node notify-email.mjs               # compose and send
 *   node notify-email.mjs --to a@b.com  # override the configured recipient
 */
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import yaml from 'js-yaml';
import { buildModel } from './build-artifact.mjs';
import { BANDS } from './callback-score.mjs';
import { sendRaw } from './gmail-send.mjs';

const ROOT = dirname(fileURLToPath(import.meta.url));
const STATE_PATH = 'data/alert-state.json';
const ARTIFACT_PATH = 'output/pipeline-artifact.html';

export const DEFAULTS = {
  to: '',
  min_match: 42,
  max_rows: 15,
  quiet_if_empty: true,
  attach_artifact: true,
  artifact_url: '',
};

export function loadConfig(root = ROOT) {
  const path = join(root, 'config/alerts.yml');
  if (!existsSync(path)) return { ...DEFAULTS };
  const parsed = yaml.load(readFileSync(path, 'utf-8')) || {};
  const cfg = { ...DEFAULTS, ...(parsed.alerts || parsed) };
  // min_reply_odds was the pre-rewrite name on a 0-100 additive scale. An
  // existing config keeps working rather than going quiet, but it is read as
  // the same threshold on the new scale, so a stale 58 alerts on less.
  if (cfg.min_reply_odds !== undefined && (parsed.alerts || parsed).min_match === undefined) {
    cfg.min_match = cfg.min_reply_odds;
  }
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
  writeFileSync(path, JSON.stringify(state, null, 2) + '\n');
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

export function composeBody({ fresh, upgraded, model, cfg, date }) {
  const wrap = s => `<div style="font-family:-apple-system,'Segoe UI',Helvetica,Arial,sans-serif;color:#12242c;background:#ffffff;padding:4px">${s}</div>`;
  const h = t => `<h2 style="font-size:15px;letter-spacing:.04em;text-transform:uppercase;color:#4a6068;margin:22px 0 8px">${t}</h2>`;
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
  }
  out.push(h('Snapshot'));
  out.push(`<p style="margin:0;font-size:14px;line-height:1.6">
    ${BANDS.filter(b => b.id !== 'blocked').map(b =>
      `${model.rows.filter(r => r.cbBand === b.id).length} ${b.id}`).join(' · ')} ·
    ${model.expired.count} retired to date${cfg.artifact_url ? ` · <a href="${esc(cfg.artifact_url)}" style="color:#0f6f6b">open the full page</a>` : ''}</p>`);
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
export function composeRun({ root = ROOT, now = new Date(), cfg = null, model = null } = {}) {
  const config = cfg || loadConfig(root);
  const m = model || buildModel({ root, now });
  const state = loadState(root);
  const date = now.toISOString().slice(0, 10);
  const { fresh, upgraded, nextSeen, nextStrong } = diffRows(m.rows, state, config);
  const retired = Math.max(0, m.expired.count - state.expired);
  const quiet = config.quiet_if_empty && !fresh.length && !upgraded.length && !retired;

  const artifactPath = join(root, ARTIFACT_PATH);
  const attachment = config.attach_artifact && existsSync(artifactPath)
    ? { name: 'pipeline-artifact.html', content: readFileSync(artifactPath, 'utf-8') }
    : null;

  const subject = subjectFor({ fresh, upgraded, retired, date });
  const html = composeBody({ fresh, upgraded, model: m, cfg: config, date });
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

async function main(argv) {
  const dry = argv.includes('--dry-run');
  const toIdx = argv.indexOf('--to');
  const cfg = loadConfig();
  if (toIdx >= 0) cfg.to = argv[toIdx + 1];

  const run = composeRun({ cfg });
  const { fresh, upgraded, retired } = run.counts;

  // First run against an established pipeline is not an alert, it is a
  // backlog: 221 postings the reader already knows about. Seeding marks the
  // current state as known so the first scheduled mail is a real diff.
  if (argv.includes('--seed')) {
    saveState(run.nextState);
    console.log(`  seeded — ${run.nextState.seen.length} postings marked known, nothing sent`);
    return;
  }
  console.log(`${run.subject}\n  new ${fresh} · upgraded ${upgraded} · retired ${retired} · pending ${run.counts.pending}`);

  if (run.quiet) {
    console.log('  nothing changed — quiet_if_empty is on, no mail sent');
    return;
  }
  if (dry) {
    const out = join(ROOT, 'output', 'alert-preview.eml');
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
  // Only now. A send that threw leaves every posting unseen for the next run.
  saveState(run.nextState);
  console.log(`  sent to ${run.to}${id ? ` (${id})` : ''}`);
}

if (import.meta.url === pathToFileURL(process.argv[1] || '').href) {
  main(process.argv.slice(2)).catch(e => { console.error(`  ${e.message}`); process.exitCode = 1; });
}
