// Self-check for the cloud/ logic that fails silently: the Access JWT check and its
// local-dev bypass (a bug there either locks everyone out or lets everyone in), the
// snapshot push, and the inbox (validation, stale handling, replay from the log).
//   node cloud/check.mjs
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { gunzipSync } from 'node:zlib';
import { identify, localDevIdentity, verifyAccessJwt } from './lib/access.mjs';
import { parseAction } from './lib/inbox.mjs';
import { buildCopy, canonicalState, drainInbox, moveOutcome, postingRows, siteUrl, snapshot } from './sync-runner.mjs';
import { loadCanonicalStates } from '../tracker-utils.mjs';

const TEAM = 'https://team.cloudflareaccess.com';
const AUD = 'aud-prod';
const now = 1_800_000_000;

const { privateKey, publicKey } = await crypto.subtle.generateKey(
  { name: 'RSASSA-PKCS1-v1_5', modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: 'SHA-256' },
  true,
  ['sign', 'verify'],
);
const jwk = { ...(await crypto.subtle.exportKey('jwk', publicKey)), kid: 'k1' };
const b64 = (v) => Buffer.from(typeof v === 'string' ? v : JSON.stringify(v)).toString('base64url');
async function sign(claims, header = { alg: 'RS256', kid: 'k1' }) {
  const body = `${b64(header)}.${b64(claims)}`;
  const sig = await crypto.subtle.sign('RSASSA-PKCS1-v1_5', privateKey, new TextEncoder().encode(body));
  return `${body}.${Buffer.from(sig).toString('base64url')}`;
}
let fetches = 0;
const opts = { teamDomain: TEAM, aud: AUD, now, getKeys: async (refresh) => (fetches++, refresh ? [jwk] : []) };
const good = { iss: TEAM, aud: [AUD], exp: now + 60, email: 'me@example.com' };

assert.equal((await verifyAccessJwt(await sign(good), opts)).email, 'me@example.com');
assert.equal(fetches, 2, 'unknown kid refetches the key set once');
assert.equal(await verifyAccessJwt(await sign({ ...good, aud: ['aud-preview'] }), opts), null, 'preview AUD');
assert.equal(await verifyAccessJwt(await sign({ ...good, iss: 'https://evil.example' }), opts), null, 'issuer');
assert.equal(await verifyAccessJwt(await sign({ ...good, exp: now - 1 }), opts), null, 'expired');
assert.equal(await verifyAccessJwt(await sign(good, { alg: 'none', kid: 'k1' }), opts), null, 'alg none');
const [h, , s] = (await sign(good)).split('.');
assert.equal(await verifyAccessJwt(`${h}.${b64({ ...good, email: 'x@example.com' })}.${s}`, opts), null, 'tampered payload');
assert.equal(await verifyAccessJwt(null, opts), null, 'no header');

const cfg = { people: 'Me@Example.com, other@example.com', runnerId: 'abc.access' };
assert.deepEqual(identify({ email: 'me@example.com' }, cfg), { email: 'me@example.com' });
assert.equal(identify({ email: 'stranger@example.com' }, cfg), null);
assert.deepEqual(identify({ common_name: 'abc.access' }, cfg), { runner: true });
assert.equal(identify({ common_name: 'other.access' }, cfg), null);
assert.equal(identify({ common_name: '' }, { people: '', runnerId: '' }), null, 'unset config matches nobody');
assert.equal(identify({ email: 'me@example.com' }, {}), null);

// The dev bypass needs both the variable and a loopback host; pages.dev never qualifies.
const req = (url, headers = {}) => new Request(url, { headers });
assert.deepEqual(localDevIdentity(req('http://127.0.0.1:8788/api/copy'), 'me@local'), { email: 'me@local' });
assert.deepEqual(localDevIdentity(req('http://localhost:8788/api/inbox', { 'CF-Access-Client-Id': 'x' }), 'me@local'), { runner: true });
assert.equal(localDevIdentity(req('https://example.pages.dev/api/copy'), 'me@local'), null, 'production host');
assert.equal(localDevIdentity(req('http://127.0.0.1:8788/api/copy'), undefined), null, 'variable unset');

const U = '0b9f6a52-3c1e-4d2a-9f7e-1a2b3c4d5e6f';
const move = { uuid: U, type: 'move', payload: { n: '1', to: 'Interview' }, precondition: { from: 'Applied' } };
assert.deepEqual(parseAction(move), move);
assert.match(parseAction({ ...move, uuid: 'not-a-uuid' }), /uuid/);
assert.match(parseAction({ ...move, payload: { n: '1', to: 'Interview|x' } }), /state/, 'pipe would break the tracker row');
assert.match(parseAction({ ...move, precondition: null }), /precondition/);
assert.match(parseAction({ uuid: U, type: 'comment', payload: { n: '1', text: 'x'.repeat(2001) } }), /2000/);
assert.equal(parseAction({ uuid: U, type: 'comment', payload: { n: '1', text: '  hi  ' } }).payload.text, 'hi');
assert.match(parseAction({ ...move, type: 'settings' }), /type/);

const states = loadCanonicalStates(new URL('../templates/states.yml', import.meta.url));
assert.equal(canonicalState('applied', states), 'Applied');
assert.equal(canonicalState('Applied*', states), null);
assert.equal(canonicalState('Ghosted', states), null);
assert.deepEqual(moveOutcome(0, { changed: false }, { to: 'Applied', from: 'Evaluated' }), { status: 'applied', result: { changed: false, to: 'Applied' } });
assert.equal(moveOutcome(4, null, {}), null, 'lock busy stays pending');
const stale = moveOutcome(5, { error: 'moved', code: 'stale', current: 'Interview' }, { to: 'Applied', from: 'Evaluated' });
assert.equal(stale.status, 'rejected');
assert.deepEqual([stale.result.reason, stale.result.current, stale.result.expected], ['stale', 'Interview', 'Evaluated']);

// Replay: a logged uuid resends its outcome without touching the tracker; a comment
// lands once even when the log line was lost after the append.
delete process.env.CAREER_OPS_TRACKER; // the fixture's tracker, never the user's
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cloud-check-'));
try {
  fs.mkdirSync(path.join(root, 'data'));
  fs.writeFileSync(path.join(root, 'data/applications.md'),
    '| # | Date | Company | Role | Score | Status | PDF | Report | Notes |\n|---|---|---|---|---|---|---|---|---|\n| 1 | 2026-09-01 | Example Labs | Engineer | 4/5 | Applied | - | - | - |\n');
  const log = path.join(root, 'data/inbox-log.jsonl');
  fs.writeFileSync(log, JSON.stringify({ uuid: U, status: 'rejected', result: { reason: 'stale' } }) + '\n');
  assert.deepEqual(await drainInbox(root, [move]), [{ uuid: U, status: 'rejected', result: { reason: 'stale' } }]);

  const C = '1c2d3e4f-5a6b-4c7d-8e9f-0a1b2c3d4e5f';
  const comment = { uuid: C, seq: 2, type: 'comment', payload: { n: '1', text: 'called back' }, createdAt: '2026-09-02T10:00:00.000Z' };
  const bad = { uuid: '2c2d3e4f-5a6b-4c7d-8e9f-0a1b2c3d4e5f', type: 'move', payload: { n: '1', to: 'Ghosted' }, precondition: { from: 'Applied' } };
  const first = await drainInbox(root, [comment, bad]);
  assert.deepEqual(first.map((r) => r.status), ['applied', 'rejected']);
  fs.writeFileSync(log, ''); // lose the log: the uuid in the activity line still dedupes
  await drainInbox(root, [comment]);
  const lines = fs.readFileSync(path.join(root, 'data/board-activity.jsonl'), 'utf8').trim().split('\n');
  assert.equal(lines.length, 1);
  assert.equal(JSON.parse(lines[0]).text, 'called back');

  // The copy: one card per tracker row plus the two meta rows, and a snapshot version
  // that only moves when the data does, so an idle run uploads nothing.
  const copy = buildCopy(root);
  assert.deepEqual(copy.map((r) => r.id), ['card:1', 'states', 'columns']);
  assert.equal(copy[0].data.app.status, 'Applied');
  const snap = snapshot(copy);
  assert.match(snap.version, /^[0-9a-f]{32}$/, 'sync.js accepts 16-64 hex');
  assert.equal(snapshot(buildCopy(root)).version, snap.version);
  assert.deepEqual(JSON.parse(gunzipSync(Buffer.from(snap.body, 'base64'))), { rows: copy }, 'the page gets {rows}');
  const tracker = path.join(root, 'data/applications.md');
  fs.writeFileSync(tracker, fs.readFileSync(tracker, 'utf8').replace('| Applied |', '| Interview |'));
  assert.notEqual(snapshot(buildCopy(root)).version, snap.version);

  // Postings: pending rows inside the window, one per URL, no age field to churn daily.
  const day = (n) => new Date(Date.UTC(2026, 9, 28) - n * 864e5).toISOString().slice(0, 10);
  fs.writeFileSync(path.join(root, 'portals.yml'), 'title_filter:\n  positive: [Engineer]\n');
  fs.writeFileSync(path.join(root, 'data/pipeline.md'), [
    '## Pending',
    `- [ ] https://jobs.example/a | Acme | Frontend Engineer | Remote | posted: ${day(2)}`,
    `- [ ] https://jobs.example/a | Acme | Frontend Engineer | Remote | posted: ${day(2)}`,
    `- [ ] https://jobs.example/old | Acme | Platform Engineer | Remote | posted: ${day(60)}`,
    '- [ ] https://jobs.example/undated | Beta | UI Engineer | Austin, TX',
  ].join('\n') + '\n');
  const posts = postingRows(root, new Date('2026-10-28T12:00:00Z'));
  assert.deepEqual(posts.map((r) => r.data.u), ['https://jobs.example/a', 'https://jobs.example/undated']);
  assert.equal(posts[0].kind, 'posting');
  assert.ok(!('age' in posts[0].data) && typeof posts[0].data.cb === 'number');
} finally {
  fs.rmSync(root, { recursive: true, force: true });
}

// The env var beats wrangler.toml; a missing file names the fix instead of posting to a default.
const toml = path.join(os.tmpdir(), `site-url-${process.pid}.toml`);
fs.writeFileSync(toml, 'name = "x"\n[vars]\nSITE_URL = "https://from-toml.example"\n');
try {
  assert.equal(siteUrl({ CAREER_OPS_CLOUD_URL: 'http://127.0.0.1:8788' }, toml), 'http://127.0.0.1:8788');
  assert.equal(siteUrl({}, toml), 'https://from-toml.example');
  assert.throws(() => siteUrl({}, toml + '.missing'), /wrangler\.example\.toml/);
} finally {
  fs.rmSync(toml, { force: true });
}

console.log('cloud check: ok');
