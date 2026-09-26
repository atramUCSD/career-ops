// @ts-check
/** @typedef {import('./_types.js').Provider} Provider */

// France Travail "Offres d'emploi v2" provider (francetravail.io) — the French
// national employment agency's partner API. OAuth2 client-credentials; one or
// more keywords are queried; scan.mjs applies title_filter + location_filter +
// dedup afterwards, so this provider over-fetches (recall-first), like
// arbeitsagentur.mjs, its German sibling.
//
// ── Registration (no credentials ship with this repo) ─────────────────────────
//   1. Create a free account at https://francetravail.io (sign-up:
//      https://francetravail.io/inscription).
//   2. In the logged-in dashboard, create an application ("Créer une
//      application"). It is assigned a client id (format `PAR_...`) and a
//      client secret ("clé secrète").
//   3. Subscribe the application to the API "Offres d'emploi v2"
//      (catalogue: https://francetravail.io/produits-partages/catalogue/offres-emploi).
//      That grants the scopes this provider requests:
//        api_offresdemploiv2 o2dsoffre
//   4. Export the credentials as environment variables (the repo's pattern for
//      keys — cf. APIFY_TOKEN, GEMINI_API_KEY; never a .env file in this repo):
//        FRANCETRAVAIL_CLIENT_ID=PAR_...
//        FRANCETRAVAIL_CLIENT_SECRET=...
//   Token URL (OAuth2 client-credentials, form-encoded POST):
//     https://entreprise.francetravail.fr/connexion/oauth2/access_token?realm=%2Fpartenaire
//   Documented rate limit: 10 calls/second (data.gouv.fr listing for this API).
//
// ── Probe log (unauthenticated surfaces only; probed 2026-08-28/29) ──────────
//   LIVE-VERIFIED:
//   - POST token URL, empty body        → 400 {"error":"invalid_request",
//       "error_description":"Grant type is not set"}
//   - POST token URL, fake credentials  → 400 {"error":"invalid_client",
//       "error_description":"Client authentication failed"}
//   - GET  /v2/offres/search (no token) → 401, EMPTY body, `Www-Authenticate: Bearer`
//   - GET  /v2/offres/{id}   (no token) → 401, EMPTY body, `Www-Authenticate: Bearer`
//   - The official OpenAPI 3.0.1 spec itself was fetched live
//     (https://francetravail.io/api-peio/v2/api/84/openapi) — every shape below
//     comes from it.
//   DOCUMENTED-ONLY (requires credentials; NOT live-verified here):
//   - Search 200/206 body: { resultats: Offre[], filtresPossibles: [...] };
//     206 = partial content (more results beyond the requested `range`);
//     204 = no matching offer (empty body).
//   - Offre fields: id, intitule, description, dateCreation, lieuTravail.libelle,
//     entreprise.nom, typeContrat, origineOffre.urlOrigine, ...
//   - Detail GET /v2/offres/{id}: 200 = offer exists; 204 = "L'offre n'existe
//     pas" (the documented GONE signal — NOT 404); 400 = bad id; 500.
//   - `range` param: "p-d", max 150 per page, p <= 3000, d <= 3149.
//   - Token success body: standard OAuth2 { access_token, token_type, expires_in, scope }.
//
// ── Config (portals.yml entry; explicit `provider: francetravail` only) ──────
//   - name: France Travail — IA France
//     provider: francetravail
//     francetravail:
//       keywords: ["machine learning", "data scientist"]  # required; comma = AND within one keyword string
//       commune: "75101"      # optional INSEE commune code (see /v2/referentiel/communes)
//       distance: 30          # km radius around `commune` (default 10 per API; sent only with commune)
//       departement: "75"     # optional; up to 5 comma-separated
//       days: 30              # publieeDepuis recency window (default 30, clamped 1-31)
//       size: 150             # results per keyword (1-150, default 150)
//     enabled: true
//
// Missing credentials degrade to one warning line + an empty result (never a
// throw): a fresh clone must be able to run `scan` with this entry present.
// Everything else follows the repo contract: misconfiguration (no keywords)
// throws, a malformed payload throws (an unreadable payload must never
// masquerade as a genuinely empty board), a single failed keyword is tolerated,
// and only a total outage throws — scan.mjs catches per-entry and records it.

import { intInRange } from './_config-utils.mjs';
import { safeEncodeURIComponent } from './_safe-url.mjs';

const TOKEN_URL = 'https://entreprise.francetravail.fr/connexion/oauth2/access_token?realm=%2Fpartenaire';
const SEARCH_URL = 'https://api.francetravail.io/partenaire/offresdemploi/v2/offres/search';
const SCOPE = 'api_offresdemploiv2 o2dsoffre';
// Public per-offer page; documented fallback when origineOffre.urlOrigine is absent.
const DETAIL_PAGE = 'https://candidat.francetravail.fr/offres/recherche/detail/';

/**
 * Reads the OAuth2 client credentials from the environment. Returns null when
 * either half is missing — the caller degrades, never throws.
 * @param {Record<string, string|undefined>} [env]
 * @returns {{ clientId: string, clientSecret: string } | null}
 */
export function readCredentials(env = process.env) {
  const clientId = typeof env.FRANCETRAVAIL_CLIENT_ID === 'string' ? env.FRANCETRAVAIL_CLIENT_ID.trim() : '';
  const clientSecret = typeof env.FRANCETRAVAIL_CLIENT_SECRET === 'string' ? env.FRANCETRAVAIL_CLIENT_SECRET.trim() : '';
  if (!clientId || !clientSecret) return null;
  return { clientId, clientSecret };
}

/**
 * Reads and sanitizes the entry's `francetravail:` config block.
 * @param {{ francetravail?: any }} entry
 * @returns {{ keywords: string[], commune: string, distance: number, departement: string, days: number, size: number }}
 */
export function parseFrancetravailConfig(entry) {
  const cfg = (entry && entry.francetravail) || {};
  const keywords = Array.isArray(cfg.keywords)
    ? cfg.keywords.filter(k => typeof k === 'string' && k.trim()).map(k => k.trim())
    : [];
  return {
    keywords,
    commune: typeof cfg.commune === 'string' ? cfg.commune.trim() : '',
    distance: intInRange(cfg.distance, 10, 0, 200),  // km; sent only when `commune` is set
    departement: typeof cfg.departement === 'string' ? cfg.departement.trim() : '',
    // publieeDepuis: the spec gives no explicit bound; the francetravail.fr UI
    // offers up to 31 days, so clamp there to avoid a documented-only 400.
    days: intInRange(cfg.days, 30, 1, 31),
    size: intInRange(cfg.size, 150, 1, 150),         // range page is capped at 150 by the API
  };
}

/**
 * Normalizes one documented Offre into a Job plus its `id` (kept for dedup,
 * stripped before the provider returns). Returns null when the offer lacks a
 * usable id or title. Field names are from the official OpenAPI spec
 * (documented-only — see the probe log above).
 * @param {any} offre
 * @returns {({title: string, url: string, company: string, location: string, description?: string, postedAt?: number, id: string}) | null}
 */
export function normalizeOffre(offre) {
  const id = offre && offre.id;
  const title = String((offre && offre.intitule) || '').trim();
  if (!id || !title) return null;
  const encodedId = safeEncodeURIComponent(id);
  if (encodedId === null) return null;
  // origineOffre.urlOrigine is the canonical public page (partner offers point
  // at the partner's site); fall back to the France Travail candidate page.
  const urlOrigine = offre.origineOffre && typeof offre.origineOffre.urlOrigine === 'string'
    ? offre.origineOffre.urlOrigine.trim() : '';
  /** @type {any} */
  const job = {
    title,
    url: /^https:\/\//.test(urlOrigine) ? urlOrigine : DETAIL_PAGE + encodedId,
    company: String((offre.entreprise && offre.entreprise.nom) || '').trim(),
    location: String((offre.lieuTravail && offre.lieuTravail.libelle) || '').trim(),
    id: String(id),
  };
  // The search payload carries the full description for free (no per-job
  // request) — scan.mjs's content_filter consumes it when present.
  if (typeof offre.description === 'string' && offre.description.trim()) {
    job.description = offre.description.trim();
  }
  const postedAt = Date.parse(offre.dateCreation);
  if (Number.isFinite(postedAt)) job.postedAt = postedAt;
  return job;
}

// One warning line per process, not per portals.yml entry.
let warnedMissingCreds = false;

/** @type {Provider} */
export default {
  id: 'francetravail',

  /**
   * Fetches and normalizes postings from the France Travail Offres d'emploi v2 API.
   * @param {{ name?: string, francetravail?: any }} entry
   * @param {{ fetchJson: (url: string, opts?: object) => Promise<any>, fetchResponse: (url: string, opts?: object) => Promise<Response> }} ctx
   * @returns {Promise<Array<{title: string, url: string, company: string, location: string}>>}
   */
  async fetch(entry, ctx) {
    const { keywords, commune, distance, departement, days, size } = parseFrancetravailConfig(entry);
    if (!keywords.length) {
      throw new Error(`francetravail: entry "${entry.name || '(unnamed)'}" has no francetravail.keywords[]`);
    }

    const creds = readCredentials();
    if (!creds) {
      if (!warnedMissingCreds) {
        warnedMissingCreds = true;
        console.error('⚠️  francetravail: FRANCETRAVAIL_CLIENT_ID / FRANCETRAVAIL_CLIENT_SECRET not set — skipping France Travail entries (register at https://francetravail.io; see providers/francetravail.mjs header)');
      }
      return [];
    }

    // OAuth2 client-credentials token. Token endpoint error shape live-verified
    // (400 invalid_client on bad credentials); success shape documented-only.
    // A failure here is a total outage for this entry: throw (scan.mjs catches
    // per-entry), never return [] — that would masquerade as an empty board.
    let token;
    try {
      const tokenRes = await ctx.fetchJson(TOKEN_URL, {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json' },
        body: new URLSearchParams({
          grant_type: 'client_credentials',
          client_id: creds.clientId,
          client_secret: creds.clientSecret,
          scope: SCOPE,
        }).toString(),
        redirect: 'error', // SSRF guard, same as every other provider
        timeoutMs: 12_000,
      });
      token = tokenRes && typeof tokenRes.access_token === 'string' ? tokenRes.access_token : '';
    } catch (err) {
      throw new Error(`francetravail: token request failed — ${(err && err.message) || err}`);
    }
    if (!token) {
      throw new Error('francetravail: token response carried no access_token — check the application scopes (api_offresdemploiv2 o2dsoffre)');
    }
    // ponytail: token fetched once per entry, no cross-entry cache — add one if
    // portals.yml ever grows several francetravail entries per scan.

    /** @param {string} motsCles */
    const fetchKeyword = async (motsCles) => {
      const params = new URLSearchParams({
        motsCles,
        publieeDepuis: String(days),
        range: `0-${size - 1}`, // documented page cap: 150
      });
      if (commune) {
        params.set('commune', commune);
        params.set('distance', String(distance));
      }
      if (departement) params.set('departement', departement);
      const res = await ctx.fetchResponse(`${SEARCH_URL}?${params.toString()}`, {
        headers: { authorization: `Bearer ${token}`, accept: 'application/json' },
        redirect: 'error',
        timeoutMs: 12_000,
      });
      if (res.status === 204) return []; // documented: no matching offer (empty body)
      // 200 = complete, 206 = partial (more beyond `range` — recall-first, one page is enough).
      const json = await res.json().catch(() => null);
      if (!json || !Array.isArray(json.resultats)) {
        throw new Error(`francetravail: unexpected API response — expected { resultats: [...] }, got keys: [${json ? Object.keys(json).join(', ') : 'null'}]`);
      }
      return json.resultats;
    };

    const byId = new Map();
    const errors = [];
    let succeeded = 0;
    for (const kw of keywords) {
      let resultats;
      try {
        resultats = await fetchKeyword(kw);
        succeeded++;
      } catch (err) {
        // Recall-first: tolerate a single failed keyword and keep going.
        errors.push(`"${kw}": ${(err && err.message) || err}`);
        continue;
      }
      for (const raw of resultats) {
        const job = normalizeOffre(raw);
        if (job && !byId.has(job.id)) byId.set(job.id, job);
      }
    }

    // Total outage = every keyword request failed. A keyword that answered with
    // zero results (204) is not an outage — key off the success count.
    if (succeeded === 0 && errors.length) {
      throw new Error(`francetravail: all ${keywords.length} keyword request(s) failed — ${errors[0]}`);
    }

    return [...byId.values()].map(({ id, ...job }) => job);
  },
};
