// tests/notify-email.test.mjs — the alert must diff, must stay quiet when
// nothing changed, and must never leak a credential into a preview file.
//
// Nothing here touches the network. sendRaw is exercised against a stub fetch.
import { pass, fail } from './helpers.mjs';
import {
  diffRows, subjectFor, encodeMime, toBase64Url, composeBody, composeRun, DEFAULTS,
  BAND_COLOR,
} from '../notify-email.mjs';
import { BANDS } from '../callback-score.mjs';
import { sendRaw, credentialsFrom, GmailSendError } from '../gmail-send.mjs';

console.log('\nnotify-email — scheduled Gmail alert');

const row = (o = {}) => ({
  u: 'https://x.test/1', c: 'Acme', t: 'Frontend Engineer', seg: 'San Diego',
  age: 3, cb: 78, cbBand: 'strong', ...o,
});

// ── diff ─────────────────────────────────────────────────────────────────────

const empty = { seen: [], strong: [], expired: 0, lastRun: null };
const a = row(), b = row({ u: 'https://x.test/2', cb: 61, cbBand: 'likely' });

diffRows([a, b], empty, { min_reply_odds: 0 }).fresh.length === 2
  ? pass('a first run reports every posting as new')
  : fail('first run did not report all rows');

diffRows([a, b], { ...empty, seen: [a.u, b.u] }, { min_reply_odds: 0 }).fresh.length === 0
  ? pass('an already-alerted posting is not sent twice')
  : fail('a posting was re-alerted');

diffRows([a, b], empty, { min_reply_odds: 70 }).fresh.length === 1
  ? pass('min_reply_odds filters the mail')
  : fail('threshold not applied');

// A row below the threshold must still be marked seen, or every run re-offers
// the same postings and the reader learns to ignore the mail.
diffRows([a, b], empty, { min_reply_odds: 70 }).nextSeen.length === 2
  ? pass('below-threshold rows are marked seen rather than re-offered daily')
  : fail('below-threshold rows were left unseen');

const up = diffRows([row({ cbBand: 'strong' })], { ...empty, seen: ['https://x.test/1'] }, {});
up.upgraded.length === 1 && up.fresh.length === 0
  ? pass('a known posting that reaches the strong band is reported as an upgrade')
  : fail('band upgrade not detected');

diffRows([row({ cbBand: 'strong' })], { ...empty, seen: ['https://x.test/1'], strong: ['https://x.test/1'] }, {}).upgraded.length === 0
  ? pass('an upgrade is announced once, not every run')
  : fail('upgrade repeated');

// ── subject ──────────────────────────────────────────────────────────────────

subjectFor({ fresh: [a, b], upgraded: [], retired: 2, date: '2026-08-21' })
  === 'career-ops — 2 new, 1 strong, 2 retired (2026-08-21)'
  ? pass('subject line carries the counts')
  : fail(`bad subject: ${subjectFor({ fresh: [a, b], upgraded: [], retired: 2, date: '2026-08-21' })}`);

subjectFor({ fresh: [], upgraded: [], retired: 0, date: '2026-08-21' }).includes('no change')
  ? pass('an empty diff still produces a legible subject')
  : fail('empty subject is wrong');

// ── MIME ─────────────────────────────────────────────────────────────────────

const mime = encodeMime({
  to: 'me@example.com', subject: 'career-ops — 1 new (2026-08-21)',
  html: '<p>hi</p>', attachment: { name: 'pipeline-artifact.html', content: '<title>x</title>' },
});

/^To: me@example\.com\r\n/.test(mime) && mime.includes('multipart/mixed; boundary="')
  ? pass('headers and multipart container are well formed')
  : fail('MIME headers are malformed');

const boundary = mime.match(/boundary="([^"]+)"/)[1];
mime.split(`--${boundary}`).length === 4 && mime.trimEnd().endsWith(`--${boundary}--`)
  ? pass('two parts and a closing boundary')
  : fail('part count or terminator is wrong');

mime.includes('Content-Disposition: attachment; filename="pipeline-artifact.html"')
  ? pass('the snapshot is attached by filename')
  : fail('attachment disposition missing');

// The body must survive a client that strips <style>, so it cannot rely on one.
const html = composeBody({
  fresh: [a], upgraded: [], cfg: { ...DEFAULTS, artifact_url: 'https://claude.ai/x' }, date: '2026-08-21',
  model: { rows: [a, b], expired: { count: 4 } },
});
!/<style|<script|var\(--/.test(html) && html.includes('style="')
  ? pass('the mail body is inline-styled with no <style>, <script> or custom properties')
  : fail('the body relies on markup mail clients strip');

/not a fit score/.test(html.replace(/\s+/g, ' ')) && /applies to anything/.test(html.replace(/\s+/g, ' '))
  ? pass('the mail restates that odds are a prior and that nothing auto-applies')
  : fail('framing text missing from the body');

// A company name is scraped third-party text and reaches an HTML email body.
composeBody({
  fresh: [row({ c: 'Beta <script>alert(1)</script>' })], upgraded: [], cfg: DEFAULTS,
  date: '2026-08-21', model: { rows: [], expired: { count: 0 } },
}).includes('Beta &lt;script&gt;')
  ? pass('scraped text is escaped in the mail body')
  : fail('a company name went into the body unescaped');

const url = toBase64Url(mime);
/^[A-Za-z0-9_-]+$/.test(url) && Buffer.from(url.replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString() === mime
  ? pass('base64url round-trips and is URL-safe')
  : fail('base64url encoding is wrong');

// ── quiet run ────────────────────────────────────────────────────────────────

const quiet = composeRun({
  cfg: { ...DEFAULTS, to: 'me@example.com' },
  model: { rows: [], expired: { count: 0 }, generated: '2026-08-21' },
  now: new Date('2026-08-21T00:00:00Z'),
});
quiet.quiet && quiet.mime === ''
  ? pass('a run with nothing new composes no message at all')
  : fail('a quiet run still produced a message');

// ── credentials ──────────────────────────────────────────────────────────────

credentialsFrom({}).missing.length === 3
  ? pass('absent credentials are reported, not guessed at')
  : fail('credential check is wrong');

credentialsFrom({ GMAIL_CLIENT_ID: 'i', GMAIL_CLIENT_SECRET: 's', GMAIL_REFRESH_TOKEN: 'r' }).refreshToken === 'r'
  ? pass('the ingest token is accepted as a fallback so the failure surfaces at the API')
  : fail('fallback token not read');

// ── send failure must not look like success ──────────────────────────────────

const env = { GMAIL_CLIENT_ID: 'i', GMAIL_CLIENT_SECRET: 's', GMAIL_SEND_REFRESH_TOKEN: 'r' };
const okToken = async () => ({ ok: true, status: 200, text: async () => JSON.stringify({ access_token: 't' }) });

let threw = null;
try {
  await sendRaw('x', {
    env,
    fetchFn: async (u) => (u.includes('token')
      ? okToken()
      : { ok: false, status: 403, text: async () => JSON.stringify({ error: { message: 'Request had insufficient authentication scopes.' } }) }),
  });
} catch (e) { threw = e; }
threw instanceof GmailSendError && /403/.test(threw.message)
  ? pass('a scope rejection throws, so the caller leaves state untouched')
  : fail('a failed send did not throw');

let leaked = null;
try {
  await sendRaw('x', {
    env,
    fetchFn: async () => ({ ok: false, status: 400, text: async () => JSON.stringify({ error: 'invalid_grant', refresh_token: 'r' }) }),
  });
} catch (e) { leaked = e; }
leaked && !leaked.message.includes('r"') && leaked.message.includes('invalid_grant')
  ? pass('a token-exchange failure names the error without echoing the credential')
  : fail(`token failure message may leak: ${leaked && leaked.message}`);

const sent = await sendRaw('x', {
  env,
  fetchFn: async (u) => (u.includes('token') ? okToken() : { ok: true, status: 200, text: async () => JSON.stringify({ id: 'm1' }) }),
});
sent === 'm1'
  ? pass('a successful send returns the message id')
  : fail('send did not return an id');

// ── band ids stay in sync with the scorer ────────────────────────────────────
// The mailer paints and counts by band id. When callback-score renamed its
// bands, nothing here noticed, because every fixture above supplies its own
// band string. This is the check that catches the next rename.
const ids = new Set(BANDS.map(b => b.id));
const unknownColors = Object.keys(BAND_COLOR).filter(k => !ids.has(k));
unknownColors.length === 0
  ? pass('every band the mailer colours is a band the scorer emits')
  : fail(`BAND_COLOR names bands the scorer does not emit: ${unknownColors.join(', ')}`);

const counted = composeBody({
  fresh: [], upgraded: [], cfg: { ...DEFAULTS },
  model: { rows: BANDS.map(b => row({ cbBand: b.id })), expired: { count: 0 } },
  date: '2026-08-24',
});
BANDS.filter(b => b.id !== 'blocked').every(b => counted.includes(b.id))
  ? pass('the snapshot line counts the bands the scorer actually emits')
  : fail('the snapshot line names bands that no longer exist');
