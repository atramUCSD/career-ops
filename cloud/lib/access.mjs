// Checks the Cf-Access-Jwt-Assertion header that Access adds to every request it
// lets through. Access already gates the hostname. This check stops a request that
// reaches a Function some other way: a preview URL (its app has a different AUD),
// a policy someone loosened, or an email added to the reusable "people" policy for
// another app.

const b64url = (s) => Uint8Array.from(atob(s.replace(/-/g, '+').replace(/_/g, '/')), (c) => c.charCodeAt(0));
const utf8 = new TextDecoder();

let cache = { at: 0, keys: [] };

async function accessKeys(teamDomain, refresh) {
  if (refresh || Date.now() - cache.at > 3_600_000) {
    const res = await fetch(`${teamDomain}/cdn-cgi/access/certs`);
    if (!res.ok) throw new Error(`Access certs: HTTP ${res.status}`);
    cache = { at: Date.now(), keys: (await res.json()).keys };
  }
  return cache.keys;
}

/** Verified claims, or null for anything unsigned, foreign, or expired. */
export async function verifyAccessJwt(token, { teamDomain, aud, now = Date.now() / 1000, getKeys = (refresh) => accessKeys(teamDomain, refresh) }) {
  const parts = token?.split('.') ?? [];
  if (parts.length !== 3 || !teamDomain || !aud) return null;
  let header, claims;
  try {
    header = JSON.parse(utf8.decode(b64url(parts[0])));
    claims = JSON.parse(utf8.decode(b64url(parts[1])));
  } catch {
    return null;
  }
  if (header.alg !== 'RS256') return null;
  // An unknown kid means the cached set predates one of Access's key rotations.
  const jwk = (await getKeys(false)).find((k) => k.kid === header.kid) ?? (await getKeys(true)).find((k) => k.kid === header.kid);
  if (!jwk) return null;
  const key = await crypto.subtle.importKey('jwk', jwk, { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' }, false, ['verify']);
  const signed = new TextEncoder().encode(`${parts[0]}.${parts[1]}`);
  if (!(await crypto.subtle.verify('RSASSA-PKCS1-v1_5', key, b64url(parts[2]), signed))) return null;
  if (claims.iss !== teamDomain || ![].concat(claims.aud).includes(aud)) return null;
  if (!(claims.exp > now) || (claims.nbf && claims.nbf > now)) return null;
  return claims;
}

/**
 * Who the request is, from verified claims: a person on this profile, or the PC.
 * Person tokens carry `email`; service-token tokens carry `common_name` (the client ID)
 * and no email. Empty or unset config matches nobody.
 */
export function identify(claims, { people, runnerId }) {
  if (claims.email) {
    const allowed = String(people ?? '').split(',').map((e) => e.trim().toLowerCase()).filter(Boolean);
    return allowed.includes(claims.email.toLowerCase()) ? { email: claims.email } : null;
  }
  if (runnerId && claims.common_name === runnerId) return { runner: true };
  return null;
}

const LOOPBACK = new Set(['localhost', '127.0.0.1', '[::1]']);

/**
 * Test-only identity for `wrangler pages dev`, where no Access edge exists to mint
 * a JWT. Two gates, both needed: LOCAL_DEV_IDENTITY comes only from cloud/.dev.vars,
 * which `pages deploy` never uploads, and the request must be addressed to a
 * loopback host, which a request routed to pages.dev never is. A request carrying
 * the service-token header is the runner, as it would be behind Access; anything
 * else is the person named by the variable.
 */
export function localDevIdentity(request, email) {
  if (!email || !LOOPBACK.has(new URL(request.url).hostname)) return null;
  return request.headers.get('CF-Access-Client-Id') ? { runner: true } : { email };
}
