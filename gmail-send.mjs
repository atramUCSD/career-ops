#!/usr/bin/env node
/**
 * gmail-send.mjs — send one message through the Gmail REST API.
 *
 * The transport, and only the transport. It composes nothing and decides
 * nothing: `notify-email.mjs` builds the MIME, this hands it to Google.
 *
 * WHY NOT SMTP
 * plugins/gmail already carries an OAuth desktop client and a refresh-token
 * flow, and its manifest already allows oauth2.googleapis.com and
 * gmail.googleapis.com. Sending over the same API reuses that setup and needs
 * no app password, no new dependency, and no second kind of credential.
 *
 * SCOPE
 * The ingest plugin's token is read-only, so it cannot send. Sending needs a
 * token minted with `gmail.send`, kept in its own variable
 * (GMAIL_SEND_REFRESH_TOKEN) so that ingest stays least-privilege and either
 * token can be revoked without touching the other.
 *
 * The consent screen must be published to Production. Left in Testing, Google
 * expires refresh tokens after 7 days and the scheduled alert dies silently
 * after one week — the single most common way this integration breaks.
 */
const TOKEN_URL = 'https://oauth2.googleapis.com/token';
const SEND_URL = 'https://gmail.googleapis.com/gmail/v1/users/me/messages/send';

export class GmailSendError extends Error {}

/** Read send credentials from the environment, falling back to the ingest client. */
export function credentialsFrom(env = process.env) {
  const missing = [];
  const clientId = env.GMAIL_CLIENT_ID;
  const clientSecret = env.GMAIL_CLIENT_SECRET;
  // The send token is deliberately its own variable. Falling back to the
  // ingest token is allowed but will fail at the API with a scope error, which
  // is a clearer failure than pretending the credential is absent.
  const refreshToken = env.GMAIL_SEND_REFRESH_TOKEN || env.GMAIL_REFRESH_TOKEN;
  if (!clientId) missing.push('GMAIL_CLIENT_ID');
  if (!clientSecret) missing.push('GMAIL_CLIENT_SECRET');
  if (!refreshToken) missing.push('GMAIL_SEND_REFRESH_TOKEN');
  return { clientId, clientSecret, refreshToken, missing };
}

async function accessTokenFor({ clientId, clientSecret, refreshToken }, fetchFn) {
  const res = await fetchFn(TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id: clientId,
      client_secret: clientSecret,
      refresh_token: refreshToken,
      grant_type: 'refresh_token',
    }),
  });
  const text = await res.text();
  if (!res.ok) {
    // Never echo the body wholesale — a failed token exchange can quote back
    // the credential it was given.
    const code = (() => { try { return JSON.parse(text).error || 'unknown'; } catch { return 'unknown'; } })();
    throw new GmailSendError(`token refresh failed: ${res.status} (${code})`);
  }
  const data = JSON.parse(text);
  if (!data.access_token) throw new GmailSendError('token refresh returned no access_token');
  return data.access_token;
}

/**
 * Send a base64url-encoded RFC 5322 message. Resolves with the Gmail message
 * id; throws on anything that is not a 2xx, so the caller can leave its state
 * file untouched and re-alert on the next run.
 */
export async function sendRaw(raw, { env = process.env, fetchFn = globalThis.fetch } = {}) {
  const creds = credentialsFrom(env);
  if (creds.missing.length) {
    throw new GmailSendError(`missing credentials: ${creds.missing.join(', ')}`);
  }
  const token = await accessTokenFor(creds, fetchFn);
  const res = await fetchFn(SEND_URL, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ raw }),
  });
  const text = await res.text();
  if (!res.ok) {
    const reason = (() => {
      try { return JSON.parse(text).error?.message || `${res.status}`; } catch { return `${res.status}`; }
    })();
    throw new GmailSendError(`send failed: ${res.status} — ${String(reason).slice(0, 200)}`);
  }
  try { return JSON.parse(text).id || null; } catch { return null; }
}
