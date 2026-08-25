// @ts-check
/**
 * liveness-api.mjs — zero-token liveness check for ATS-hosted job postings.
 *
 * Many postings live on ATS platforms (Greenhouse, Lever, Ashby, Workday, ...) that
 * expose a public JSON endpoint. We can confirm whether a posting is still live by
 * hitting that endpoint directly — no browser, no LLM tokens — and only fall back to
 * the Playwright check (liveness-browser.mjs) for non-ATS pages or when the API is
 * inconclusive. This is the cheap first rung of the liveness ladder.
 *
 * CONSERVATIVE BY DESIGN: a false "expired" is worse than the status quo (the user
 * misses a real job). So on a definitive 404/410 we return `expired`, and for
 * anything ambiguous (unknown ATS, redirect, 429/5xx, network/timeout) we return
 * `null` (→ caller falls back to Playwright).
 *
 * Two endpoint shapes:
 *   - Per-job (Greenhouse, Lever, Workday): the URL maps to a single-job endpoint,
 *     so a 200 is itself proof the posting is live.
 *   - Org-level (Ashby): the URL maps to the org's whole job board. A 200 only
 *     proves the board exists, so the provider's `interpret` step parses the board
 *     and confirms THIS posting is still listed before returning active/expired.
 *     (Ashby pages are JS-rendered, so the browser/static rung sees only nav/footer
 *     and false-reports live postings as expired — this API rung is authoritative.)
 *
 * SSRF-safe by construction: the request URL is built from a FIXED, hard-coded API
 * host plus path segments extracted from the posting URL with a strict charset
 * (no slashes / traversal), and server-side redirects are refused.
 */

import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DEFAULT_USER_AGENT } from './user-agent.mjs';

const ROOT = dirname(fileURLToPath(import.meta.url));

const TIMEOUT_MS = 8_000;
// Strict path-segment charset. Anything with a slash, dot-dot, or other char is
// rejected before it can reach the fixed-host API URL template.
const SAFE_SEGMENT = /^[A-Za-z0-9._-]+$/;

// Most providers extract single path segments (SAFE_SEGMENT covers those directly).
// Workday's job path is genuinely multi-segment (a location slug + a title slug,
// e.g. "Toronto-ON-CAN/Agentic-AI-Engineer_R260010125"), so a `parts` value may
// itself contain slashes. This still validates every individual segment against
// the same strict charset (and rejects ".." in any of them) — it only relaxes
// "no slash at all" to "no *unsafe* content between slashes", so the traversal/
// injection guarantee is unchanged.
function isSafeValue(v) {
  if (typeof v !== 'string' || v.length === 0) return false;
  // SAFE_SEGMENT's charset includes "." (some real segments use dots), so ".."
  // alone passes that regex — same as the single-segment guard in
  // resolveAtsApi below, the explicit `!includes('..')` check per segment is
  // load-bearing, not redundant with the regex test.
  return v.split('/').every((seg) => seg.length > 0 && SAFE_SEGMENT.test(seg) && !seg.includes('..'));
}

// Each ATS: detect its posting URL, then map to a public JSON API URL.
// `match` returns the extracted path params (or null); `api` builds the FIXED-host URL.
// Optional per-provider fields:
//   `timeoutMs`  — override the default fetch timeout (slow/rate-limited APIs).
//   `interpret`  — read the 200 response body to decide liveness (org-level APIs
//                  where a 200 alone doesn't prove THIS posting is live).
//   `accept`     — override the Accept header (endpoints that serve HTML, not JSON).
//   `interpretOther` — claim a status the module otherwise treats as inconclusive
//                  (Workday's 403 for an unpublished posting), when the ATS answers
//                  there with an app-level verdict rather than a transport failure.
//   `interpretGone` — read a 404/410 body before trusting it as `expired`. Needed
//                  where the endpoint returns the same status for "this posting is
//                  gone" and "you asked about the wrong board", which are opposite
//                  answers. Returning null there falls back to the browser instead
//                  of purging a live posting.
const ATS_PROVIDERS = [
  {
    id: 'greenhouse',
    // boards.greenhouse.io/{board}/jobs/{id} · job-boards[.eu].greenhouse.io/{board}/jobs/{id}
    match(u) {
      if (!/(^|\.)greenhouse\.io$/.test(u.hostname)) return null;
      const m = u.pathname.match(/^\/([^/]+)\/jobs\/(\d+)\/?$/);
      return m ? { board: m[1], id: m[2] } : null;
    },
    api: ({ board, id }) => `https://boards-api.greenhouse.io/v1/boards/${board}/jobs/${id}`,
  },
  {
    id: 'greenhouse_embed',
    // Greenhouse's embedded board on the employer's OWN domain — the posting URL is
    // e.g. databricks.com/company/careers/open-positions/job?gh_jid=8546367002. The
    // job id is right there in the query string, and the same per-job API that serves
    // job-boards.greenhouse.io serves these; 145 of the 228 postings this module could
    // not check were of exactly this shape, left to the browser classifier for no
    // reason other than the hostname.
    //
    // The board token is NOT in the URL, so it is inferred from the domain label
    // (databricks.com → "databricks", jobs.dropbox.com → "dropbox"). That inference
    // is a guess and is sometimes wrong, which makes a 404 ambiguous: the posting was
    // removed, or the token was never a board at all. The per-job endpoint cannot tell
    // them apart — it answers `{"error":"Job not found"}` either way, including for a
    // board that does not exist. Only the BOARD endpoint distinguishes them, so
    // interpretGone confirms the board before trusting the 404. A guess that turns out
    // not to be a board degrades to the browser check instead of reporting expired.
    match(u) {
      // greenhouse.io hosts are handled by the entry above, which carries the real
      // board token in its path — never guess one when the URL states it.
      if (/(^|\.)greenhouse\.io$/.test(u.hostname)) return null;
      const id = u.searchParams.get('gh_jid');
      if (!id || !/^\d+$/.test(id)) return null;
      // Strip the careers-subdomain conventions, then take the registrable label:
      // "careers.airbnb.com" → "airbnb", "www.coinbase.com" → "coinbase".
      const labels = u.hostname.toLowerCase().replace(/^(www|careers|jobs|apply|boards)\./, '').split('.');
      const board = labels.length >= 2 ? labels[0] : null;
      return board ? { board, id } : null;
    },
    api: ({ board, id }) => `https://boards-api.greenhouse.io/v1/boards/${board}/jobs/${id}`,
    async interpretGone(_res, { board }) {
      // Second request, and only on the 404 path (rare): does this board exist?
      // 200 → the token was right, so the 404 above means the posting is gone.
      // Anything else → the token was a bad guess and the 404 proves nothing.
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
      try {
        const board_res = await fetch(`https://boards-api.greenhouse.io/v1/boards/${board}`, {
          method: 'GET',
          headers: { 'user-agent': DEFAULT_USER_AGENT, accept: 'application/json' },
          redirect: 'error',
          signal: controller.signal,
        });
        if (board_res.status !== 200) return null; // not a board → inconclusive
        return {
          result: 'expired',
          code: 'greenhouse_embed_api_gone',
          reason: 'Greenhouse API — posting removed from the board',
        };
      } catch {
        return null; // network / timeout → inconclusive
      } finally {
        clearTimeout(timer);
      }
    },
  },
  {
    id: 'icims',
    // {tenant}.icims.com/jobs/{id}/{slug}/job — iCIMS renders the posting inside an
    // IFRAME, so a headless browser reads the page chrome and nothing else. That is
    // what made every live Peraton posting classify as expired via insufficient
    // content. Requesting the iframe's own URL (`in_iframe=1`) returns the posting
    // body directly over plain HTTP, and iCIMS answers a removed posting with a
    // 410 Gone — an authoritative signal the browser rung never sees.
    match(u) {
      const host = u.hostname.match(/^([\w-]+)\.icims\.com$/);
      if (!host) return null;
      const m = u.pathname.match(/^\/jobs\/(\d+)\//);
      return m ? { tenant: host[1], id: m[1] } : null;
    },
    // Host is derived rather than fixed, as it is for Lever: the pattern above pins
    // it to a single safe label under the literal icims.com domain, and isSafeValue
    // re-checks that label before it reaches the template.
    api: ({ tenant, id }) => `https://${tenant}.icims.com/jobs/${id}/job?in_iframe=1`,
    accept: 'text/html',
  },
  {
    id: 'smartrecruiters',
    // jobs.smartrecruiters.com/{company}/{id}-{slug}
    match(u) {
      if (u.hostname !== 'jobs.smartrecruiters.com') return null;
      const m = u.pathname.match(/^\/([^/]+)\/(\d+)(?:-[^/]*)?\/?$/);
      return m ? { company: m[1], id: m[2] } : null;
    },
    api: ({ company, id }) => `https://api.smartrecruiters.com/v1/companies/${company}/postings/${id}`,
    // A 200 here is NOT proof of life. SmartRecruiters keeps closed postings
    // addressable and reports their state in the body: `active: false` on a
    // posting that has been taken down, with the 200 unchanged. Two ServiceNow
    // postings the browser rung had correctly called dead came back
    // `smartrecruiters_api_ok` on the status code alone — a false ACTIVE, which
    // leaves a dead job in the queue looking verified.
    //
    // Only an explicit `active: false` is treated as removed. A missing field or
    // an unreadable body returns null rather than guessing in either direction.
    async interpret(res) {
      let json;
      try {
        json = await res.json();
      } catch {
        return null;
      }
      if (json?.active === false) {
        return { result: 'expired', code: 'smartrecruiters_api_inactive', reason: 'SmartRecruiters posting is marked inactive (closed)' };
      }
      if (json?.active === true) {
        return { result: 'active', code: 'smartrecruiters_api_ok', reason: 'SmartRecruiters posting is marked active (live)' };
      }
      return null; // no `active` field → unexpected shape, let the browser decide
    },
  },
  {
    id: 'lever',
    // jobs.(eu.)?lever.co/{slug}/{id}
    match(u) {
      const host = u.hostname.match(/^jobs\.((?:eu\.)?lever\.co)$/);
      if (!host) return null;
      const m = u.pathname.match(/^\/([^/]+)\/([^/?#]+)\/?$/);
      return m ? { apiHost: `api.${host[1]}`, slug: m[1], id: m[2] } : null;
    },
    api: ({ apiHost, slug, id }) => `https://${apiHost}/v0/postings/${slug}/${id}`,
  },
  {
    id: 'ashby',
    // jobs.ashbyhq.com/{org}/{jobId}[/application]. Ashby's public posting API is
    // ORG-level (the whole job board), not per-job — so `api` maps to the board and
    // `interpret` confirms this {jobId} is still listed. Only {org} reaches the
    // fixed-host URL; {jobId} is used solely to filter the parsed board (SAFE_SEGMENT
    // still validates both).
    match(u) {
      if (u.hostname !== 'jobs.ashbyhq.com') return null;
      const m = u.pathname.match(/^\/([^/]+)\/([^/]+)(?:\/application)?\/?$/);
      return m ? { org: m[1], jobId: m[2] } : null;
    },
    api: ({ org }) => `https://api.ashbyhq.com/posting-api/job-board/${org}`,
    // Ashby's posting-api has a server-side latency floor and rate-limits repeated
    // unauthenticated hits (see providers/ashby.mjs). Give it more room than the ATS
    // default so a slow-but-live board doesn't time out into a Playwright fallback.
    timeoutMs: 20_000,
    async interpret(res, { jobId }) {
      let json;
      try {
        json = await res.json();
      } catch {
        return null; // unparseable body → inconclusive, let the browser decide
      }
      return classifyAshbyBoard(json, jobId);
    },
  },
  {
    id: 'workday',
    // {tenant}.{shard}.myworkdayjobs.com[/{xx-XX}]/{site}/job/{jobPath...}
    // Mirrors the tenant/shard/site detection in providers/workday.mjs, but for a
    // single posting rather than the board-wide CXS search endpoint. Workday's
    // per-job CXS endpoint (`/wday/cxs/{tenant}/{site}/job/{jobPath}`) is a
    // genuinely PER-JOB API like Greenhouse/Lever — a 200 is itself proof the
    // posting is live, confirmed against real tenants (BMO, TD, Manulife, CIBC):
    // an existing posting returns 200, a garbage job id returns 404.
    //
    // jobPath is intentionally multi-segment (Workday encodes a location slug and
    // a title slug as separate path parts, e.g.
    // "Toronto-ON-CAN/Agentic-AI-Engineer_R260010125") — isSafeValue (not the
    // single-segment SAFE_SEGMENT check other providers use directly) validates
    // it component-by-component.
    match(u) {
      const m = `${u.hostname}${u.pathname}`.match(
        /^([\w-]+)\.(wd[\w-]*)\.myworkdayjobs\.com\/(?:[a-z]{2}-[A-Z]{2}\/)?([^/?#]+)\/job\/(.+?)\/?$/
      );
      if (!m) return null;
      const [, tenant, shard, site, jobPath] = m;
      return { tenant, shard, site, jobPath };
    },
    api: ({ tenant, shard, site, jobPath }) =>
      `https://${tenant}.${shard}.myworkdayjobs.com/wday/cxs/${tenant}/${site}/job/${jobPath}`,
    // Workday does NOT 404 every dead posting. Tenants differ: Leidos answers 404
    // for a removed job, while CACI, Parsons and BAH answer 403 `errorCode: "S22"`
    // ("permission denied") — the posting still exists in the tenant, it is just
    // no longer published. A bogus job path on those same tenants returns 404
    // `errorCode: "S21"`, and a live posting returns 200, so S22 is specifically
    // "exists but unpublished", not a blanket refusal.
    //
    // That distinction is the whole reason this is safe to read. A WAF or CDN
    // block also arrives as 403, but as an HTML challenge page — so the JSON
    // content type plus the exact errorCode must both hold before the 403 is
    // taken as an answer. Anything else stays null and falls to the browser.
    //
    // Ten postings sat in the queue unresolvable on this: the API said "don't
    // know" while the tenant was in fact saying "unpublished".
    async interpretOther(res) {
      if (res.status !== 403) return null;
      if (!/^application\/json/i.test(res.headers.get('content-type') || '')) return null; // WAF/CDN HTML → not an answer
      let json;
      try {
        json = await res.json();
      } catch {
        return null;
      }
      if (json?.errorCode !== 'S22') return null; // some other refusal → inconclusive
      return { result: 'expired', code: 'workday_api_unpublished', reason: 'Workday CXS 403 S22 — posting is no longer published' };
    },
  },
  {
    id: 'eightfold',
    // Eightfold AI serves employers' career sites from the employer's OWN branded
    // host (careers.qualcomm.com, apply.careers.microsoft.com), with no shared
    // suffix to key on — the reason these postings had no API rung and fell to
    // Playwright, which cannot recognize them either.
    //
    // The per-job endpoint is `/api/apply/v2/jobs/{id}` on the same branded host:
    // 200 for a live posting, 404 `{"message":"Job with ID {id} not found"}` for
    // one that is gone. That is a genuine per-job answer, so a bare 404 is
    // trustworthy here — unlike the embedded-Greenhouse case, nothing about the
    // request is guessed.
    //
    // Callers elsewhere pass `?domain={company}.com`. It is omitted deliberately:
    // the endpoint answers correctly without it, and a WRONG domain returns a 404
    // HTML page — that is, a guessed parameter could manufacture a false expiry.
    // Not sending it removes the guess entirely.
    //
    // Unlike every other provider here, the API host is the posting's own host
    // rather than a fixed vendor host, so it is pinned to an allowlist instead.
    // The path shape `/careers/job/{digits}` is not distinctive enough to prove a
    // site is Eightfold, and fetching whatever host happened to match would give
    // up the fixed-host property the rest of this module relies on. Adding an
    // employer is one line in EIGHTFOLD_HOSTS.
    match(u) {
      const host = u.hostname.toLowerCase();
      if (!EIGHTFOLD_HOSTS.has(host) && !/(^|\.)eightfold\.ai$/.test(host)) return null;
      const m = u.pathname.match(/^\/careers\/job\/(\d+)\/?$/);
      return m ? { host, id: m[1] } : null;
    },
    api: ({ host, id }) => `https://${host}/api/apply/v2/jobs/${id}`,
  },
];

// Branded hosts served by Eightfold AI. See the `eightfold` provider above for
// why this is an allowlist and not a pattern.
const EIGHTFOLD_HOSTS = new Set([
  'apply.careers.microsoft.com',
  'careers.qualcomm.com',
]);

/**
 * Decide liveness for one Ashby posting from its org's job-board API payload.
 * Pure + deterministic (no I/O), mirroring classifyLiveness in liveness-core.mjs.
 *
 * The public board lists only currently-published postings, so a posting that is
 * absent (or explicitly `isListed: false`) has been removed/unlisted → expired.
 * A present, listed posting → active. An unexpected shape → null (inconclusive),
 * so a future API change degrades to a Playwright fallback rather than a false
 * "expired".
 *
 * @param {any} json - parsed job-board response, expected shape `{ jobs: [...] }`
 * @param {string} jobId - the {jobId} from jobs.ashbyhq.com/{org}/{jobId}
 * @returns {{ result: 'active' | 'expired', code: string, reason: string } | null}
 */
export function classifyAshbyBoard(json, jobId) {
  if (!json || !Array.isArray(json.jobs)) return null; // unexpected shape → fall back
  const target = String(jobId).toLowerCase();
  const job = json.jobs.find((j) => typeof j?.id === 'string' && j.id.toLowerCase() === target);
  if (job && job.isListed !== false) {
    return { result: 'active', code: 'ashby_api_ok', reason: 'Ashby posting is listed on the board (live)' };
  }
  return { result: 'expired', code: 'ashby_api_unlisted', reason: 'Ashby posting not listed on the board — removed/unlisted' };
}

// A Greenhouse-embedded careers page — coinbase.com/careers/positions/N?gh_jid=N,
// pinterestcareers.com/jobs/?gh_jid=N — carries the job id but not the board
// token, so resolveAtsApi (URL-only by design, and SSRF-tight) cannot map it.
// portals.yml already names every board this pipeline scans; match the host
// against those tokens rather than guessing one from the domain.
let GH_BOARDS = null;
function ghBoards() {
  if (GH_BOARDS) return GH_BOARDS;
  const text = existsSync(join(ROOT, 'portals.yml')) ? readFileSync(join(ROOT, 'portals.yml'), 'utf-8') : '';
  GH_BOARDS = [...new Set([...text.matchAll(/boards-api\.greenhouse\.io\/v1\/boards\/([a-z0-9-]+)\//gi)]
    .map(m => m[1].toLowerCase()))];
  return GH_BOARDS;
}

export function greenhouseEmbed(rawUrl, boards = ghBoards()) {
  let u;
  try { u = new URL(rawUrl); } catch { return null; }
  const id = u.searchParams.get('gh_jid');
  if (!id || !/^[0-9]+$/.test(id)) return null;
  const host = u.hostname.toLowerCase();
  const board = boards.find(b => host.includes(b));
  return board ? `https://boards-api.greenhouse.io/v1/boards/${board}/jobs/${id}` : null;
}

/**
 * Map a posting URL to its ATS API URL, or null if it isn't a known ATS posting
 * (or any extracted segment fails the strict charset). Pure + deterministic.
 * @param {string} rawUrl
 * @returns {{ ats: string, apiUrl: string, parts: Record<string, string>, timeoutMs?: number, interpret?: (res: Response, parts: Record<string, string>) => Promise<{ result: 'active' | 'expired', code: string, reason: string } | null> } | null}
 */
export function resolveAtsApi(rawUrl) {
  let u;
  try {
    u = new URL(rawUrl);
  } catch {
    return null;
  }
  if (u.protocol !== 'https:') return null;
  for (const provider of ATS_PROVIDERS) {
    const parts = provider.match(u);
    if (!parts) continue;
    // SSRF guard: every derived value must be safe — a single path segment for
    // most providers, or (Workday) a slash-separated sequence of safe segments.
    // isSafeValue enforces the same charset + no-".." rule either way.
    if (!Object.values(parts).every(isSafeValue)) return null;
    return {
      ats: provider.id,
      apiUrl: provider.api(parts),
      parts,
      timeoutMs: provider.timeoutMs,
      interpret: provider.interpret,
      interpretGone: provider.interpretGone,
      interpretOther: provider.interpretOther,
      accept: provider.accept,
    };
  }
  return null;
}

/** True if `url` is an ATS posting we can check via API (lets callers stay lazy about the browser). */
export function isAtsPosting(url) {
  return resolveAtsApi(url) !== null;
}

/**
 * Zero-token liveness check via the posting's ATS API.
 * @param {string} url
 * @returns {Promise<{ result: 'active' | 'expired', code: string, reason: string } | null>}
 *   null = not a known ATS posting, or inconclusive → caller should fall back to Playwright.
 */
export async function checkLivenessViaApi(url) {
  // Second rung: a careers page that embeds a Greenhouse board carries the job id
  // in ?gh_jid but not the board token, so resolveAtsApi (URL-only, SSRF-tight)
  // cannot map it. stripe.com/jobs/search?gh_jid=N is the worst case — the page
  // itself is a search view that takes 15s to render and then shows no single
  // posting, so the browser rung could only ever time out into `uncertain`.
  const resolved = resolveAtsApi(url)
    ?? (() => {
      const apiUrl = greenhouseEmbed(url);
      return apiUrl ? { ats: 'greenhouse', apiUrl, parts: {}, interpret: undefined, timeoutMs: undefined } : null;
    })();
  if (!resolved) return null;
  const { ats, apiUrl, parts, interpret, interpretGone, interpretOther, accept, timeoutMs } = resolved;

  // The timeout guards the whole classification (fetch + any `interpret` body read),
  // since aborting the shared signal also tears down an in-flight res.json().
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs || TIMEOUT_MS);
  try {
    let res;
    try {
      res = await fetch(apiUrl, {
        method: 'GET',
        headers: { 'user-agent': DEFAULT_USER_AGENT, accept: accept || 'application/json' },
        redirect: 'error', // refuse server-side redirects (SSRF + ambiguity guard)
        signal: controller.signal,
      });
    } catch {
      return null; // network / timeout / redirect → inconclusive, let Playwright decide
    }

    if (res.status === 404 || res.status === 410) {
      // Where the same status can mean "wrong board" as well as "posting removed",
      // the body decides — and an unreadable body stays inconclusive.
      if (interpretGone) return await interpretGone(res, parts);
      return { result: 'expired', code: `${ats}_api_gone`, reason: `ATS API ${res.status} — posting removed` };
    }
    if (res.status === 200) {
      // Org-level APIs (Ashby) inspect the body to confirm THIS posting; per-job
      // APIs (Greenhouse, Lever) treat a 200 as proof the posting is live.
      if (interpret) return await interpret(res, parts);
      return { result: 'active', code: `${ats}_api_ok`, reason: 'ATS API returns the posting (live)' };
    }
    // 429/5xx/other → inconclusive by default. A provider may claim one of these
    // statuses when its ATS answers there with an APP-level verdict about THIS
    // posting (Workday's 403 for an unpublished job) rather than a transport
    // failure or a WAF block. The default stays null.
    if (interpretOther) return await interpretOther(res, parts);
    return null;
  } catch {
    return null; // interpret abort / unexpected error → inconclusive
  } finally {
    clearTimeout(timer);
  }
}
