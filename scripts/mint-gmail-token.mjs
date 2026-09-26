#!/usr/bin/env node
/**
 * scripts/mint-gmail-token.mjs — one-time: mint a Gmail refresh token.
 *
 * Runs Google's loopback flow for a Desktop OAuth client: opens the consent
 * page, catches the redirect on 127.0.0.1, exchanges the code, and writes the
 * refresh token straight into .env so it never passes through a terminal
 * transcript. Reads GMAIL_CLIENT_ID / GMAIL_CLIENT_SECRET from that same .env.
 *
 *   node scripts/mint-gmail-token.mjs              # gmail.send     -> GMAIL_SEND_REFRESH_TOKEN (alerts)
 *   node scripts/mint-gmail-token.mjs --readonly   # gmail.readonly -> GMAIL_REFRESH_TOKEN (ingest, reply scan)
 *
 * Separate tokens so either can be revoked without breaking the other.
 * Re-running replaces the existing line for that token.
 */
import { createServer } from 'node:http';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { exec } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { config } from 'dotenv';

const ENV_PATH = join(dirname(fileURLToPath(import.meta.url)), '..', '.env');
config({ path: ENV_PATH, quiet: true });

const { GMAIL_CLIENT_ID: clientId, GMAIL_CLIENT_SECRET: clientSecret } = process.env;
if (!clientId || !clientSecret) {
  console.error(`GMAIL_CLIENT_ID and GMAIL_CLIENT_SECRET must be set in ${ENV_PATH} first.`);
  process.exit(1);
}

const readonly = process.argv.includes('--readonly');
const ENV_KEY = readonly ? 'GMAIL_REFRESH_TOKEN' : 'GMAIL_SEND_REFRESH_TOKEN';
const SCOPE = `https://www.googleapis.com/auth/gmail.${readonly ? 'readonly' : 'send'}`;

const state = randomBytes(16).toString('hex');
let redirectUri;

const server = createServer(async (req, res) => {
  const url = new URL(req.url, redirectUri);
  // Browsers also ask for /favicon.ico; only the root carries the code.
  if (url.pathname !== '/') { res.writeHead(404).end(); return; }
  const finish = (code, msg) => {
    res.writeHead(code, { 'Content-Type': 'text/plain' }).end(msg);
    server.close();
    if (code !== 200) { console.error(msg); process.exitCode = 1; } else console.log(msg);
  };
  if (url.searchParams.get('state') !== state) return finish(400, 'State mismatch — rerun the script.');
  const authCode = url.searchParams.get('code');
  if (!authCode) return finish(400, `Consent failed: ${url.searchParams.get('error') || 'no code returned'}`);

  const tokenRes = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      code: authCode, client_id: clientId, client_secret: clientSecret,
      redirect_uri: redirectUri, grant_type: 'authorization_code',
    }),
  });
  const data = await tokenRes.json().catch(() => ({}));
  if (!tokenRes.ok || !data.refresh_token) {
    return finish(500, `Token exchange failed: ${tokenRes.status} ${data.error || ''} ${data.error_description || ''}`.trim());
  }

  const kept = existsSync(ENV_PATH)
    ? readFileSync(ENV_PATH, 'utf-8').split(/\r?\n/).filter(l => l && !l.startsWith(`${ENV_KEY}=`))
    : [];
  writeFileSync(ENV_PATH, [...kept, `${ENV_KEY}=${data.refresh_token}`, ''].join('\n'));
  finish(200, `Saved ${ENV_KEY} to ${ENV_PATH}. You can close this tab.`);
});

server.listen(0, '127.0.0.1', () => {
  redirectUri = `http://127.0.0.1:${server.address().port}`;
  const authUrl = 'https://accounts.google.com/o/oauth2/v2/auth?' + new URLSearchParams({
    client_id: clientId, redirect_uri: redirectUri, response_type: 'code',
    scope: SCOPE,
    // offline + consent: without both, Google omits refresh_token on a repeat grant.
    access_type: 'offline', prompt: 'consent', state,
  });
  console.log(`Opening the consent page. If no browser appears, open:\n${authUrl}`);
  // `start ""` — the empty title stops cmd treating the quoted URL as the window title.
  exec(process.platform === 'win32' ? `start "" "${authUrl}"` : `open "${authUrl}" || xdg-open "${authUrl}"`);
});
