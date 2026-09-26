#!/usr/bin/env node
/**
 * gmail-replies.mjs — Gmail half of the reply scanner (#1583).
 *
 * Searches the inbox for recent mail mentioning any tracker company and appends
 * each hit to data/reply-candidates.json in the shape reply-watch.mjs reads.
 * Never touches the tracker: classification + approval stay in reply-watch.
 *
 *   node gmail-replies.mjs [--days 14] [--dry-run]
 *   node reply-watch.mjs            # then review/approve
 *
 * Needs GMAIL_CLIENT_ID / GMAIL_CLIENT_SECRET / GMAIL_REFRESH_TOKEN (readonly
 * scope — mint with `node scripts/mint-gmail-token.mjs --readonly`).
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { config } from 'dotenv';
import { getAccessToken } from './plugins/gmail/index.mjs';
import { getMessageBody, isAuthenticEmail } from './plugins/gmail/_helpers.mjs';
import { appendCandidate } from './paste-reply.mjs';
import { resolveTrackerPath } from './tracker-utils.mjs';
import { isMainModule } from './lib/is-main-module.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
config({ path: path.join(__dirname, '.env'), quiet: true });

const GMAIL_API = 'https://gmail.googleapis.com/gmail/v1/users/me';
const CANDIDATES_PATH = process.env.CAREER_OPS_REPLY_CANDIDATES
  || path.join(__dirname, 'data', 'reply-candidates.json');
const args = process.argv.slice(2);
const dryRun = args.includes('--dry-run');
const days = Number(args[args.indexOf('--days') + 1]) || 14;

export function trackerCompanies(markdown) {
  const names = new Set();
  for (const line of markdown.split('\n')) {
    const cells = line.split('|').map(c => c.trim());
    // | # | Date | Company | ... — skip header and separator rows.
    if (/^\d+$/.test(cells[1] || '') && cells[3]) names.add(cells[3]);
  }
  return [...names];
}

// HTML-only mail would otherwise feed markup into the keyword classifier.
export function toText(raw) {
  return raw.replace(/<style[\s\S]*?<\/style>|<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<[^>]+>/g, ' ').replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&')
    .replace(/\s+/g, ' ').trim();
}

async function main() {
  const { GMAIL_CLIENT_ID: clientId, GMAIL_CLIENT_SECRET: clientSecret, GMAIL_REFRESH_TOKEN: refreshToken } = process.env;
  if (!clientId || !clientSecret || !refreshToken) {
    console.error('Missing GMAIL_CLIENT_ID / GMAIL_CLIENT_SECRET / GMAIL_REFRESH_TOKEN in .env — run: node scripts/mint-gmail-token.mjs --readonly');
    process.exit(1);
  }
  const companies = trackerCompanies(fs.readFileSync(resolveTrackerPath(__dirname), 'utf-8'));
  if (!companies.length) { console.log('Tracker has no companies; nothing to scan for.'); return; }

  const seen = new Set(fs.existsSync(CANDIDATES_PATH)
    ? JSON.parse(fs.readFileSync(CANDIDATES_PATH, 'utf-8')).map(c => c.message_id) : []);
  const auth = { Authorization: `Bearer ${await getAccessToken({ clientId, clientSecret, refreshToken })}` };
  const get = async (url, attempt = 0) => {
    const res = await fetch(url, { headers: auth });
    // Per-user quota is per minute; a large backlog trips it mid-run.
    if ((res.status === 429 || res.status === 403) && attempt < 3) {
      const body = await res.text();
      if (res.status === 429 || /quota/i.test(body)) {
        await new Promise(r => setTimeout(r, 20000 * (attempt + 1)));
        return get(url, attempt + 1);
      }
      throw new Error(`Gmail ${res.status}: ${body.slice(0, 200)}`);
    }
    if (!res.ok) throw new Error(`Gmail ${res.status}: ${(await res.text()).slice(0, 200)}`);
    return res.json();
  };

  // ponytail: one OR query; Gmail caps q length, split into chunks if the tracker grows past ~100 companies.
  // Job-board digests name tracker companies constantly but are never replies.
  const noise = ['jobalerts-noreply@linkedin.com', 'jobs-noreply@linkedin.com', 'clearancejobs.com',
    'indeed.com', 'glassdoor.com', 'ziprecruiter.com', 'dice.com',
    // Marketing subdomains; recruiter InMail comes from *hit-reply@linkedin.com and survives.
    'em.linkedin.com', 'email.openai.com', 'wixemails.com'].map(s => `-from:${s}`).join(' ');
  // Company names alone match newsletters and receipts (OpenAI, Discord…); require hiring vocabulary too.
  const hiring = '("your application" OR "for applying" OR "applied" OR interview OR candidacy OR recruiter OR "next steps" OR position OR "the role")';
  const q = `in:inbox newer_than:${days}d -category:promotions -category:social ${noise} ${hiring} (${companies.map(c => `"${c}"`).join(' OR ')})`;
  const ids = [];
  let pageToken = '';
  do {
    const page = await get(`${GMAIL_API}/messages?q=${encodeURIComponent(q)}${pageToken && `&pageToken=${pageToken}`}`);
    ids.push(...(page.messages || []).map(m => m.id));
    pageToken = page.nextPageToken || '';
  } while (pageToken);

  let added = 0;
  for (const id of ids) {
    const message_id = `gmail-${id}`;
    if (seen.has(message_id)) continue;
    const msg = await get(`${GMAIL_API}/messages/${id}?format=full`);
    const headers = msg.payload?.headers || [];
    const header = name => headers.find(h => h.name?.toLowerCase() === name)?.value || '';
    // Fail closed on spoofed mail: bodies are untrusted and feed a tracker-update prompt.
    if (!isAuthenticEmail(headers)) { console.warn(`skip (no DMARC pass): ${header('subject')}`); continue; }
    const candidate = {
      message_id, from: header('from'), subject: header('subject'),
      body_snippet: toText(getMessageBody(msg.payload)).slice(0, 2000) || msg.snippet || '',
      signal: null,
    };
    console.log(`${dryRun ? '[dry-run] ' : ''}+ ${candidate.from} — ${candidate.subject}`);
    if (!dryRun) appendCandidate(candidate, CANDIDATES_PATH);
    added++;
  }
  console.log(`${ids.length} matched, ${added} new candidate(s)${dryRun ? ' (not written)' : ` in ${CANDIDATES_PATH}`}.`);
  if (added && !dryRun) console.log('Next: node reply-watch.mjs');
}

if (isMainModule(import.meta.url)) {
  main().catch(err => {
    console.error(err.message);
    // Gmail-scoped refresh tokens die on a Google password change (or 6 months unused).
    if (/invalid_grant/.test(err.message)) console.error('Token revoked or expired — rerun: node scripts/mint-gmail-token.mjs --readonly');
    process.exit(1);
  });
}
