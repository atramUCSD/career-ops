#!/usr/bin/env node
/**
 * calendar-alert.mjs — put a Google Calendar event on the calendar for each
 * pending posting that clears a stricter bar than the alert mail.
 *
 * The mail lists everything over `alerts.min_match`. This is for the few
 * postings worth an evening slot: a higher score floor, an approved company
 * list, a keyword hit, a listed location, and hosts left out (LinkedIn by
 * default). The rules
 * live under `alerts.calendar` in config/alerts.yml.
 *
 * No state file. Each event id is derived from the posting URL, and Calendar
 * answers a second insert of an id with 409, so the twice-daily runs never
 * duplicate an event.
 *
 * Auth: GMAIL_CLIENT_ID / GMAIL_CLIENT_SECRET (the mail's OAuth client) plus
 * GCAL_REFRESH_TOKEN, minted with `node scripts/mint-gmail-token.mjs --calendar`.
 *
 *   node calendar-alert.mjs --dry-run              # list the events, create nothing
 *   node calendar-alert.mjs                        # create them
 *   node calendar-alert.mjs --root profiles/<name> # another user layer's config and pipeline
 */
import { createHash } from 'node:crypto';
import { resolve } from 'node:path';
import { buildModel } from './build-artifact.mjs';
import { loadConfig } from './notify-email.mjs';
import { accessTokenFor } from './gmail-send.mjs';
import { isMainModule } from './lib/is-main-module.mjs';
import { flagValue, hasFlag, validateFlags } from './lib/cli-flags.mjs';

export const CALENDAR_DEFAULTS = {
  enabled: false,
  min_match: 65,
  companies: [],
  keywords: [],
  locations: [],
  exclude_hosts: ['linkedin.com'],
  at: '21:00',
  minutes: 30,
  time_zone: 'America/Los_Angeles',
  calendar_id: 'primary',
};

export function calendarConfig(alerts) {
  const cfg = { ...CALENDAR_DEFAULTS, ...(alerts?.calendar || {}) };
  if (!/^([01]?\d|2[0-3]):[0-5]\d$/.test(String(cfg.at))) {
    throw new Error(`alerts.calendar.at must be HH:MM (24h), got "${cfg.at}"`);
  }
  // Throws RangeError on an unknown zone, before any event is built.
  new Intl.DateTimeFormat('en-US', { timeZone: cfg.time_zone });
  return cfg;
}

const escRe = s => String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
// Word-bounded so "Meta" does not take Metabase and "AI" does not take Maintenance.
const mentions = (text, term) => new RegExp(`\\b${escRe(term)}\\b`, 'i').test(text);

/** Rows that clear every rule. An empty companies or keywords list is no constraint. */
export function selectRows(rows, cfg) {
  return rows.filter(r => {
    if (!(r.cb >= cfg.min_match)) return false;
    let host;
    try { host = new URL(r.u).hostname.toLowerCase(); } catch { return false; }
    if (cfg.exclude_hosts.some(h => host === h || host.endsWith(`.${h}`))) return false;
    if (cfg.companies.length && !cfg.companies.some(c => mentions(r.c || '', c))) return false;
    const text = [r.t, ...(r.kw || []), ...(r.all || [])].join(' · ');
    if (cfg.keywords.length && !cfg.keywords.some(k => mentions(text, k))) return false;
    // A multi-city posting passes on any listed city; a bare "Remote" or a blank location does not.
    if (cfg.locations.length && !cfg.locations.some(l => mentions(r.l || '', l))) return false;
    return true;
  });
}

/**
 * The slot's date: today in the configured zone, or tomorrow once today's slot
 * has passed. Calendar takes a wall time plus a zone, so no offset math here.
 */
export function slotDate(cfg, now = new Date()) {
  const parts = Object.fromEntries(new Intl.DateTimeFormat('en-CA', {
    timeZone: cfg.time_zone, year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
  }).formatToParts(now).map(p => [p.type, p.value]));
  const [h, m] = cfg.at.split(':').map(Number);
  const past = Number(parts.hour) * 60 + Number(parts.minute) >= h * 60 + m;
  const day = new Date(Date.UTC(+parts.year, +parts.month - 1, +parts.day + (past ? 1 : 0)));
  return day.toISOString().slice(0, 10);
}

const wall = (date, minutesFromMidnight) => {
  const t = new Date(Date.parse(`${date}T00:00:00Z`) + minutesFromMidnight * 60_000);
  return t.toISOString().slice(0, 19);
};

// Calendar ids are base32hex (a-v, 0-9); a hex digest is already inside that alphabet.
export const eventId = url => createHash('sha256').update(url).digest('hex');

export function eventFor(row, cfg, now = new Date()) {
  const date = slotDate(cfg, now);
  const [h, m] = cfg.at.split(':').map(Number);
  const start = h * 60 + m;
  const why = (row.why || []).map(w => `- ${w.why}`).join('\n');
  return {
    id: eventId(row.u),
    summary: `${row.c} — ${row.t} (${row.cb})`,
    description: [row.u, row.l, why].filter(Boolean).join('\n\n'),
    start: { dateTime: wall(date, start), timeZone: cfg.time_zone },
    end: { dateTime: wall(date, start + cfg.minutes), timeZone: cfg.time_zone },
    reminders: { useDefault: false, overrides: [{ method: 'popup', minutes: 0 }] },
    source: { title: 'career-ops', url: row.u },
  };
}

/** 'created', or 'exists' when this posting's event was inserted on an earlier run. */
export async function insertEvent(event, { token, calendarId = 'primary', fetchFn = globalThis.fetch }) {
  const res = await fetchFn(`https://www.googleapis.com/calendar/v3/calendars/${encodeURIComponent(calendarId)}/events`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(event),
  });
  if (res.status === 409) return 'exists';
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    let msg = '';
    try { msg = JSON.parse(text).error?.message || ''; } catch { /* not JSON */ }
    throw new Error(`calendar insert failed: ${res.status} ${msg.slice(0, 300)}`.trim());
  }
  return 'created';
}

const KNOWN_FLAGS = ['--dry-run', '--root', '--help', '-h'];
const USAGE = `Usage:
  node calendar-alert.mjs --dry-run              # list the events, create nothing
  node calendar-alert.mjs                        # create them
  node calendar-alert.mjs --root profiles/<name> # another user layer's config and pipeline`;

async function main(argv) {
  validateFlags(argv, KNOWN_FLAGS, USAGE, { valueFlags: ['--root'], requireOperand: true });
  const dry = hasFlag(argv, '--dry-run');
  const rootArg = flagValue(argv, '--root');
  const root = rootArg ? resolve(rootArg) : undefined;
  const cfg = calendarConfig(loadConfig(root));
  if (!cfg.enabled && !dry) {
    console.log('  calendar off in config/alerts.yml — nothing created');
    return;
  }
  const now = new Date();
  const picks = selectRows(buildModel({ root, now }).rows, cfg);
  const events = picks.map(r => eventFor(r, cfg, now));
  console.log(`calendar: ${events.length} posting(s) clear the rules`);
  if (dry) {
    for (const e of events) console.log(`  ${e.start.dateTime} ${e.summary}`);
    return;
  }
  if (!events.length) return;

  const { GMAIL_CLIENT_ID: clientId, GMAIL_CLIENT_SECRET: clientSecret, GCAL_REFRESH_TOKEN: refreshToken } = process.env;
  const missing = Object.entries({ GMAIL_CLIENT_ID: clientId, GMAIL_CLIENT_SECRET: clientSecret, GCAL_REFRESH_TOKEN: refreshToken })
    .filter(([, v]) => !v).map(([k]) => k);
  if (missing.length) throw new Error(`missing credentials: ${missing.join(', ')}`);
  const token = await accessTokenFor({ clientId, clientSecret, refreshToken }, globalThis.fetch);

  const tally = { created: 0, exists: 0 };
  for (const e of events) {
    const result = await insertEvent(e, { token, calendarId: cfg.calendar_id });
    tally[result]++;
    if (result === 'created') console.log(`  + ${e.start.dateTime} ${e.summary}`);
  }
  console.log(`  created ${tally.created} · already on the calendar ${tally.exists}`);
}

if (isMainModule(import.meta.url)) {
  main(process.argv.slice(2)).catch(e => { console.error(`  ${e.message}`); process.exitCode = 1; });
}
