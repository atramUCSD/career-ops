// tests/expired-log.test.mjs — the Expired Jobs markdown log.
//
// The log is the human-legible record of postings confirmed removed, and the
// properties that matter are the ones that keep it trustworthy: the table
// survives a round-trip through its own parser (so a hand-deleted row stays
// deleted), a URL already listed never has its date rewritten (the date is an
// upper bound, and a later re-check would loosen it), and only a definitive
// verdict is ever written by the callers that feed it.
import { existsSync, mkdtempSync, readFileSync, writeFileSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { pass, fail } from './helpers.mjs';
import {
  parseExpiredLog,
  formatExpiredLog,
  mergeExpired,
  toExpiredRow,
  recordExpired,
} from '../expired-log.mjs';

console.log('\nexpired-log — the Expired Jobs table');

const row = (over = {}) => ({
  removed: '2026-08-20',
  company: 'Acme',
  title: 'Engineer',
  posted: '2026-07-01',
  source: 'api',
  evidence: 'workday_api_unpublished',
  url: 'https://jobs.example.com/1',
  ...over,
});

// ── round-trip ───────────────────────────────────────────────────────────────

const oneRow = parseExpiredLog(formatExpiredLog([row()]));
oneRow.size === 1 && oneRow.get('https://jobs.example.com/1')?.company === 'Acme'
  ? pass('a rendered row parses back to the same values')
  : fail(`round-trip lost the row — got ${JSON.stringify([...oneRow])}`);

// Job titles really do contain pipes; an unescaped one would split the row.
const piped = parseExpiredLog(formatExpiredLog([row({ title: 'Engineer | Platform' })]));
piped.get('https://jobs.example.com/1')?.title === 'Engineer | Platform'
  ? pass('a pipe in the title survives the round-trip (escaped, one row stays one row)')
  : fail(`pipe in title broke the round-trip — got ${piped.get('https://jobs.example.com/1')?.title}`);

const dashed = parseExpiredLog(formatExpiredLog([row({ company: '', posted: '' })]));
dashed.get('https://jobs.example.com/1')?.company === ''
  ? pass('an empty cell renders as — and parses back to empty')
  : fail('empty cell did not round-trip to empty');

// The header line and the |---| separator must not become rows.
parseExpiredLog(formatExpiredLog([])).size === 0
  ? pass('an empty table parses to zero rows (header/separator are not rows)')
  : fail('header or separator was parsed as a data row');

// A line that is not a table row, and a row whose last cell is not a URL.
parseExpiredLog('| a | b | c | d | e | f | g |\nnot a row\n').size === 0
  ? pass('a row without an http(s) URL is ignored')
  : fail('a non-URL row was accepted into the log');

// ── sort order ───────────────────────────────────────────────────────────────

const sorted = formatExpiredLog([
  row({ removed: '2026-08-01', url: 'https://jobs.example.com/old' }),
  row({ removed: '2026-08-20', url: 'https://jobs.example.com/new' }),
]);
sorted.indexOf('/new') < sorted.indexOf('/old')
  ? pass('rows are sorted newest-removed first')
  : fail('sort order is not newest-first');

// Byte-stability: same rows in a different input order render identically.
formatExpiredLog([row({ url: 'https://jobs.example.com/b' }), row({ url: 'https://jobs.example.com/a' })]) ===
formatExpiredLog([row({ url: 'https://jobs.example.com/a' }), row({ url: 'https://jobs.example.com/b' })])
  ? pass('same-date rows render byte-identically regardless of input order')
  : fail('render is not stable for same-date rows — the diff will churn');

// ── merge ────────────────────────────────────────────────────────────────────

const existing = parseExpiredLog(formatExpiredLog([row({ removed: '2026-08-01' })]));
const remerged = mergeExpired(existing, [row({ removed: '2026-08-20' })]);
remerged.added === 0 && remerged.rows[0].removed === '2026-08-01'
  ? pass('a URL already listed keeps its original date (the bound never loosens)')
  : fail(`re-check rewrote the date — added=${remerged.added} removed=${remerged.rows[0].removed}`);

const grown = mergeExpired(existing, [row({ url: 'https://jobs.example.com/2' })]);
grown.added === 1 && grown.rows.length === 2
  ? pass('a new URL is added alongside the existing rows')
  : fail(`merge did not add the new URL — added=${grown.added}`);

mergeExpired(new Map(), [{ url: 'ftp://jobs.example.com/1' }, { url: '' }]).added === 0
  ? pass('non-http URLs and blanks are refused')
  : fail('a non-http or empty URL was written into the log');

// ── row normalization ────────────────────────────────────────────────────────

const fromOffer = toExpiredRow(
  { url: 'https://jobs.example.com/1', company: 'Acme', title: 'Engineer', postedAt: '2026-07-01', portal: 'workday', code: 'workday_api_unpublished', reason: 'prose' },
  '2026-08-20'
);
fromOffer.removed === '2026-08-20' && fromOffer.source === 'workday' && fromOffer.evidence === 'workday_api_unpublished'
  ? pass('a scan offer normalizes to a row, preferring the stable code over prose')
  : fail(`offer normalization wrong — ${JSON.stringify(fromOffer)}`);

const bare = toExpiredRow({ url: 'https://jobs.example.com/1', reason: 'HTTP 404' }, '2026-08-20');
bare.url === 'https://jobs.example.com/1' && bare.company === '' && bare.evidence === 'HTTP 404'
  ? pass('a bare {url, reason} still makes a row — missing fields do not block it')
  : fail(`bare entry did not normalize — ${JSON.stringify(bare)}`);

// ── recordExpired (file I/O) ─────────────────────────────────────────────────

const dir = mkdtempSync(join(tmpdir(), 'expired-log-'));
const path = join(dir, 'expired-jobs.md');
(await recordExpired([], { date: '2026-08-20', path })).added === 0 && !existsSync(path)
  ? pass('recordExpired([]) writes nothing — no empty file for a clean run')
  : fail('recordExpired([]) created or touched the log file');

const first = await recordExpired([{ url: 'https://jobs.example.com/1', company: 'Acme', code: 'x' }], { date: '2026-08-20', path });
first.added === 1 && readFileSync(path, 'utf-8').includes('https://jobs.example.com/1')
  ? pass('recordExpired writes the row to disk')
  : fail(`recordExpired did not write — ${JSON.stringify(first)}`);

const again = await recordExpired([{ url: 'https://jobs.example.com/1', company: 'Acme', code: 'x' }], { date: '2026-09-01', path });
again.added === 0 && readFileSync(path, 'utf-8').includes('2026-08-20') && !readFileSync(path, 'utf-8').includes('2026-09-01')
  ? pass('recordExpired is idempotent — a re-run keeps the first-confirmed date')
  : fail('re-running recordExpired changed the log');

// A row deleted by hand stays deleted only if the file is the source of truth;
// re-recording the same URL after deletion re-adds it with the NEW date, which
// is correct — the previous observation is gone.
writeFileSync(path, formatExpiredLog([]), 'utf-8');
(await recordExpired([{ url: 'https://jobs.example.com/1' }], { date: '2026-09-01', path })).added === 1
  ? pass('the markdown file is the source of truth — a hand-cleared log re-records')
  : fail('recordExpired kept state outside the markdown file');

rmSync(dir, { recursive: true, force: true });
