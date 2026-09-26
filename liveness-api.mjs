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
 * Three endpoint shapes:
 *   - Per-job (Greenhouse, Lever, Workday): the URL maps to a single-job endpoint,
 *     so a 200 is itself proof the posting is live.
 *   - Org-level (Ashby): the URL maps to the org's whole job board. A 200 only
 *     proves the board exists, so the provider's `interpret` step parses the board
 *     and confirms THIS posting is still listed before returning active/expired.
 *     (Ashby pages are JS-rendered, so the browser/static rung sees only nav/footer
 *     and false-reports live postings as expired — this API rung is authoritative.)
 *   - Per-job HTML (LinkedIn): the guest endpoint returns the rendered posting as
 *     HTML and answers 200 for closed postings too, so `interpret` reads two
 *     independent signals out of the body and only concludes when they agree.
 *
 * SSRF-safe by construction: the request URL is built from a FIXED, hard-coded API
 * host plus path segments extracted from the posting URL with a strict charset
 * (no slashes / traversal), and server-side redirects are refused.
 */

import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DEFAULT_USER_AGENT, BROWSER_LIKE_USER_AGENT } from './user-agent.mjs';
import { classifyFullListAbsence } from './liveness-core.mjs';
import { parseWwrFeed } from './providers/weworkremotely.mjs';
import { getCareerOpsRoot } from './path-resolver.mjs';

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

// Second request, only on the 404 path of a GUESSED Greenhouse board (rare):
// does this board exist? 200 → the token was right, so the 404 means the
// posting is gone. Anything else → the token was a bad guess and the 404 proves
// nothing.
async function confirmGuessedBoard({ board }) {
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
}

// Each ATS: detect its posting URL, then map to a public JSON API URL.
// `match` returns the extracted path params (or null); `api` builds the FIXED-host URL.
// Optional per-provider fields:
//   `timeoutMs`  — override the default fetch timeout (slow/rate-limited APIs).
//   `throttleMs` — minimum interval between our requests to this provider.
//   `accept`     — override the Accept header (providers that answer in HTML).
//   `headers`    — extra request headers (APIs gated on a public client key).
//                  May be an async function `(parts) => headers | null` for
//                  rungs gated on a RUNTIME credential (an OAuth token, a
//                  rotating JWT): resolving to null skips the rung cleanly —
//                  no request, no verdict, never a throw.
//   `interpret`  — read the 200 response body to decide liveness (org-level APIs
//                  where a 200 alone doesn't prove THIS posting is live, and
//                  per-job APIs that answer 200 for a closed posting).
//   `api404Authoritative` — defaults to true (a 404/410 means gone). Set to
//                  false when the provider's public API can 404 a posting that
//                  is still genuinely live elsewhere (see the `lever` entry).
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
    id: 'greenhouse-embedded',
    // A careers page on the employer's OWN domain that embeds a Greenhouse board
    // exposes only ?gh_jid — e.g. databricks.com/company/careers/open-positions/job
    // ?gh_jid=8546367002. The board token is not in the URL. 145 of the 228
    // postings this module once could not check were of this shape.
    //
    // Greenhouse's embed endpoint answers with a redirect naming the board
    // (?for=), which is authoritative, so it is asked first. A second per-job API
    // request is still required, because even a closed job can have an embed
    // redirect. A redirect that is present but fails validation is refused
    // outright: that is a wrong answer, not a missing one.
    //
    // Only when there is no redirect at all does the domain label stand in for
    // the token (databricks.com -> "databricks", careers.airbnb.com -> "airbnb").
    // That is a guess, and the per-job endpoint answers {"error":"Job not found"}
    // both for a removed posting and for a board that does not exist, so
    // interpretGone confirms the guessed board before trusting a 404.
    match(u) {
      // greenhouse.io hosts carry the real board token in their path (next entry).
      if (/(^|\.)greenhouse\.io$/.test(u.hostname)) return null;
      const id = u.searchParams.get('gh_jid');
      if (!id || !/^\d+$/.test(id)) return null;
      // Strip the careers-subdomain conventions, then take the registrable label.
      const labels = u.hostname.toLowerCase().replace(/^(www|careers|jobs|apply|boards)\./, '').split('.');
      return labels.length >= 2 ? { id, board: labels[0] } : { id };
    },
    api: ({ id }) => `https://boards.greenhouse.io/embed/job_app?token=${id}`,
    async followEmbed(res, parts) {
      const { id } = parts;
      if (res.status !== 301 && res.status !== 302) {
        if (!parts.board) return null;
        parts.boardGuessed = true;
        return `https://boards-api.greenhouse.io/v1/boards/${parts.board}/jobs/${id}`;
      }
      let target;
      try { target = new URL(res.headers.get('location'), 'https://boards.greenhouse.io'); }
      catch { return null; }
      if (target.protocol !== 'https:' || !/(^|\.)greenhouse\.io$/.test(target.hostname)) return null;
      const board = target.searchParams.get('for');
      // The board is one URL path segment. isSafeValue also accepts Workday's
      // multi-segment paths, so reject a decoded slash here explicitly.
      if (!isSafeValue(board) || board.includes('/') || target.searchParams.get('token') !== id) return null;
      parts.board = board;
      return `https://boards-api.greenhouse.io/v1/boards/${board}/jobs/${id}`;
    },
    async interpretGone(res, parts) {
      if (!parts.boardGuessed) {
        return { result: 'expired', code: 'greenhouse-embedded_api_gone', reason: `ATS API ${res.status} — posting removed` };
      }
      return confirmGuessedBoard(parts);
    },
  },
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
    id: 'lever',
    // jobs.(eu.)?lever.co/{slug}/{id}
    match(u) {
      const host = u.hostname.match(/^jobs\.((?:eu\.)?lever\.co)$/);
      if (!host) return null;
      const m = u.pathname.match(/^\/([^/]+)\/([^/?#]+)\/?$/);
      return m ? { apiHost: `api.${host[1]}`, slug: m[1], id: m[2] } : null;
    },
    api: ({ apiHost, slug, id }) => `https://${apiHost}/v0/postings/${slug}/${id}`,
    // Lever's Confidential/Internal Postings feature explicitly excludes some
    // live postings from the public v0/postings API while the direct
    // jobs.lever.co page keeps serving them normally. Real-world repro
    // (2026-08-09): api.lever.co 404s two postings whose jobs.lever.co pages
    // return 200 with the real job title and a working Apply control. A 404
    // here is NOT proof of removal — fall through to Playwright instead.
    api404Authoritative: false,
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
  {
    id: 'smartrecruiters',
    match(u) {
      if (u.hostname !== 'jobs.smartrecruiters.com') return null;
      const m = u.pathname.match(/^\/([^/]+)\/([A-Za-z0-9]+)(?:-[^/]*)?\/?$/);
      return m ? { company: m[1], id: m[2] } : null;
    },
    api: ({ company, id }) => `https://api.smartrecruiters.com/v1/companies/${company}/postings/${id}`,
    api404Authoritative: false, // the API also uses 400 for unknown IDs
    // A 200 here is NOT proof of life. SmartRecruiters keeps closed postings
    // addressable and reports their state in the body: `active: false` on a
    // posting that has been taken down, with the 200 unchanged. Two ServiceNow
    // postings the browser rung had correctly called dead came back
    // `smartrecruiters_api_ok` on the status code alone — a false ACTIVE, which
    // leaves a dead job in the queue looking verified.
    //
    // Only an explicit boolean `active` on the posting we asked for decides. A
    // missing field, a different id, or an unreadable body returns null.
    async interpret(res, { id }) {
      let posting;
      try { posting = await res.json(); } catch { return null; }
      if (String(posting?.id) !== id || typeof posting.active !== 'boolean') return null;
      return posting.active
        ? { result: 'active', code: 'smartrecruiters_api_active', reason: 'SmartRecruiters marks the posting active' }
        : { result: 'expired', code: 'smartrecruiters_api_inactive', reason: 'SmartRecruiters marks the posting inactive' };
    },
  },
  {
    id: 'weworkremotely',
    match(u) {
      if (u.hostname !== 'weworkremotely.com' || !/^\/remote-jobs\/[^/]+\/?$/.test(u.pathname)) return null;
      return { slug: u.pathname.split('/')[2] };
    },
    api: () => 'https://weworkremotely.com/remote-jobs.rss',
    accept: 'application/rss+xml',
    api404Authoritative: false,
    async interpret(res, { slug }) {
      let feed;
      try { feed = await res.text(); } catch { return null; }
      if (!/<rss\b/i.test(feed)) return null;
      const listed = parseWwrFeed(feed).some((job) => new URL(job.url).pathname.replace(/\/$/, '') === `/remote-jobs/${slug}`);
      return listed
        ? { result: 'active', code: 'weworkremotely_feed_listed', reason: 'Posting is listed in the current RSS feed' }
        : null; // feed is bounded; absence cannot prove expiry
    },
  },
  {
    id: 'linkedin',
    // linkedin.com/jobs/view/{id} · .../jobs/view/{title-slug}-{id} · any page that
    // carries the posting in ?currentJobId= (search and collection views).
    //
    // LinkedIn had no rung here, so every LinkedIn URL fell through to Playwright —
    // where /jobs/view/{id} redirects to a generic search page and no verdict can be
    // trusted. The guest endpoint below returns the rendered posting as HTML with no
    // auth and no browser, and it answers 200 for closed postings as well as live
    // ones, so liveness has to come from the body (`interpret`), never from the
    // status code alone.
    match(u) {
      if (!/(^|\.)linkedin\.com$/.test(u.hostname)) return null;
      const path = u.pathname.match(/^\/jobs\/view\/(?:.*-)?(\d+)\/?$/);
      if (path) return { id: path[1] };
      const current = u.searchParams.get('currentJobId');
      return current && /^\d+$/.test(current) ? { id: current } : null;
    },
    api: ({ id }) => `https://www.linkedin.com/jobs-guest/jobs/api/jobPosting/${id}`,
    // The endpoint is unauthenticated and rate-limited. Space our calls; the
    // interval sits on the provider so it holds for every caller rather than only
    // the loop in check-liveness.mjs.
    throttleMs: 3_500,
    // We parse HTML here, so ask for it. The endpoint also serves HTML under an
    // application/json Accept, but a request that misdescribes what it wants is one
    // content-negotiation change away from breaking silently.
    accept: 'text/html',
    async interpret(res) {
      let html;
      try {
        html = await res.text();
      } catch {
        return null; // unreadable body → inconclusive, let the browser decide
      }
      return classifyLinkedInPosting(html);
    },
  },
  {
    id: 'arbeitsagentur',
    // www.arbeitsagentur.de/jobsuche/jobdetail/{refnr} — the outgoing URL shape
    // providers/arbeitsagentur.mjs builds. The per-job endpoint is
    // /pc/v4/jobdetails/{base64url(refnr)} with the same public client key the
    // v6 search uses. #2494's 404s hit the v4/v5 SEARCH endpoints; this v4
    // DETAIL endpoint still answers (probed 2026-08-28: 200 JSON for ten live
    // refnrs sampled from a fresh v6 search, 404 STELLENANGEBOT_NICHT_GEFUNDEN
    // for an unknown one, and every v5/v6 detail variant 403s this key), so a
    // genuine per-job answer: 200 is proof of life, a bare 404 is trustworthy.
    //
    // base64url, not standard base64 — "+" and "/" would break the path
    // segment — and its output alphabet [A-Za-z0-9_-] satisfies SAFE_SEGMENT by
    // construction, so the refnr itself (which may carry "_", e.g. partner
    // refnr 12265-346369_JB5232982-S) never reaches the URL raw.
    match(u) {
      if (u.hostname !== 'www.arbeitsagentur.de') return null;
      const m = u.pathname.match(/^\/jobsuche\/jobdetail\/([^/]+)\/?$/);
      if (!m) return null;
      let refnr;
      try {
        refnr = decodeURIComponent(m[1]);
      } catch {
        return null; // malformed percent-encoding → not a refnr we can claim
      }
      return refnr ? { ref: Buffer.from(refnr).toString('base64url') } : null;
    },
    api: ({ ref }) => `https://rest.arbeitsagentur.de/jobboerse/jobsuche-service/pc/v4/jobdetails/${ref}`,
    headers: { 'X-API-Key': 'jobboerse-jobsuche' }, // the endpoint 403s without it
    async interpretGone(res) {
      // This route died wholesale once (#2494). A posting-level 404 carries
      // messages[].code STELLENANGEBOT_NICHT_GEFUNDEN in its body; a
      // route-level 404 would not — so only the former is trusted as removal,
      // and a dead route degrades to the browser rung instead of mass-expiring
      // every German posting.
      let body;
      try {
        body = await res.text();
      } catch {
        return null; // unreadable body → inconclusive, let the browser decide
      }
      if (!body.includes('STELLENANGEBOT_NICHT_GEFUNDEN')) return null;
      return {
        result: 'expired',
        code: 'arbeitsagentur_api_gone',
        reason: 'jobdetails 404 STELLENANGEBOT_NICHT_GEFUNDEN — posting removed',
      };
    },
  },
  {
    id: 'jobtech',
    // arbetsformedlingen.se/platsbanken/annonser/{id} — exactly the URL shape
    // providers/jobtech.mjs builds from the ad id (it never trusts webpage_url).
    // GET /ad/{id} on the JobSearch API is zero-auth and genuinely per-ad, and
    // it answers removals with a 200 TOMBSTONE (removed: true, removed_date
    // set, headline null — probed minutes after a real removal) long before an
    // ad is purged to a true 404 — so liveness comes from the body, not the
    // status code alone.
    match(u) {
      if (u.hostname !== 'arbetsformedlingen.se' && u.hostname !== 'www.arbetsformedlingen.se') return null;
      const m = u.pathname.match(/^\/platsbanken\/annonser\/(\d+)\/?$/);
      return m ? { id: m[1] } : null;
    },
    api: ({ id }) => `https://jobsearch.api.jobtechdev.se/ad/${id}`,
    // The gateway is slow on healthy days (the sibling /search endpoint took
    // 12.3s for a five-hit page; providers/jobtech.mjs budgets 25s). /ad is
    // lighter, but the 8s ATS default would time out live ads into the browser
    // rung for no reason.
    timeoutMs: 15_000,
    async interpret(res) {
      let json;
      try {
        json = await res.json();
      } catch {
        return null; // unparseable body → inconclusive, let the browser decide
      }
      if (json?.removed === true) {
        return {
          result: 'expired',
          code: 'jobtech_removed_tombstone',
          reason: 'JobTech serves the ad as a removed:true tombstone — ad withdrawn',
        };
      }
      if (json?.removed === false || (json?.removed === undefined && json?.headline)) {
        return { result: 'active', code: 'jobtech_api_ok', reason: 'JobTech serves the ad without a removal mark (live)' };
      }
      return null; // neither shape → unrecognized payload, let the browser decide
    },
    async interpretGone(res) {
      // Two 404 shapes with opposite meanings: a posting-level 404 says
      // 'Ad not found' in its body; a route/gateway-level 404 has a different
      // shape ({tracking_id, cause: {...}}, captured live from a bogus path)
      // with no such marker. Trusting the latter would mass-expire every
      // Swedish posting the day the route breaks — same #2494 reasoning as the
      // arbeitsagentur rung above.
      let body;
      try {
        body = await res.text();
      } catch {
        return null;
      }
      if (!body.includes('Ad not found')) return null;
      return { result: 'expired', code: 'jobtech_api_gone', reason: "JobSearch 404 'Ad not found' — ad purged" };
    },
  },
  {
    id: 'francetravail',
    // candidat.francetravail.fr/offres/recherche/detail/{id} — exactly the
    // fallback URL shape providers/francetravail.mjs emits. Partner-origin
    // offers live on partner hosts and never match here — this API cannot
    // attest those pages, so it never claims them.
    //
    // DOCUMENTED-ONLY rung (never exercised with real credentials): response
    // semantics come from the official OpenAPI spec (api id 84). The spec's
    // gone signal is 204 — "L'offre n'existe pas" — and a 404 is UNDOCUMENTED
    // for this endpoint, so it stays inconclusive (api404Authoritative: false)
    // rather than expiring on a status the contract never defined.
    match(u) {
      if (u.hostname !== 'candidat.francetravail.fr') return null;
      const m = u.pathname.match(/^\/offres\/recherche\/detail\/([A-Za-z0-9]+)$/);
      return m ? { id: m[1] } : null;
    },
    api: ({ id }) => `https://api.francetravail.io/partenaire/offresdemploi/v2/offres/${id}`,
    headers: francetravailHeaders, // OAuth bearer, resolved per run; null (creds absent) skips the rung
    throttleMs: 150, // documented limit is 10 calls/s — stay well under it
    api404Authoritative: false,
    async interpret(res, { id }) {
      let json;
      try {
        json = await res.json();
      } catch {
        json = null;
      }
      if (json && String(json.id ?? '') === id) {
        return { result: 'active', code: 'francetravail_api_ok', reason: 'France Travail API returns the offer (live)' };
      }
      // A 200 whose body is unreadable or names a different offer proves
      // nothing in either direction — never gone, never live.
      return {
        result: 'uncertain',
        code: 'francetravail_api_unrecognized',
        reason: 'France Travail 200 without a matching offer id — unrecognized payload',
      };
    },
    async interpretOther(res) {
      if (res.status === 401 || res.status === 403) {
        // Credential outage (live-verified to arrive with an empty body), not
        // evidence about this offer. Poison the batch's token so the sweep
        // stops hammering the API with a dead bearer; every France Travail URL
        // degrades to the browser rung instead.
        ftCredsBroken = true;
        ftTokenPromise = null;
        return null;
      }
      if (res.status !== 204) return null; // 400/5xx/anything else → inconclusive
      let body = '';
      try {
        body = await res.text();
      } catch {
        return null;
      }
      if (body !== '') return null; // a 204 with a body is not the documented gone shape
      return {
        result: 'expired',
        code: 'francetravail_api_gone',
        reason: 'France Travail 204 — the spec\'s "L\'offre n\'existe pas" (offer gone)',
      };
    },
  },
  {
    id: 'usajobs',
    // www.usajobs.gov/job/{controlNumber} — the public posting page, NOT the
    // search API: the authenticated Position Search API has no per-control-
    // number lookup at all (and historicjoa 400s one), so search-absence could
    // never be authoritative, while the page itself answers per job with no
    // key. Closed announcements keep serving 200 indefinitely with a
    // server-rendered closed marker, so liveness comes from the body; a 404
    // means removed/never-existed.
    match(u) {
      if (u.hostname !== 'www.usajobs.gov' && u.hostname !== 'usajobs.gov') return null;
      const m = u.pathname.match(/^\/job\/(\d+)\/?$/)
        // Legacy PositionURI form; it 301s to /job/{cn}, and redirects are
        // refused module-wide, so normalize instead of following.
        || u.pathname.match(/^\/GetJob\/ViewDetails\/(\d+)/i);
      return m ? { id: m[1] } : null;
    },
    api: ({ id }) => `https://www.usajobs.gov/job/${id}`,
    accept: 'text/html',
    // The Akamai edge 403s non-browser UAs ('Access Denied' HTML) before the
    // origin is ever reached; the browser-like UA clears it. A 403 that still
    // arrives is the edge talking, not the posting — the default null for
    // unclaimed statuses already keeps it inconclusive.
    headers: { 'user-agent': BROWSER_LIKE_USER_AGENT },
    async interpret(res) {
      let html;
      try {
        html = await res.text();
      } catch {
        return null; // unreadable body → inconclusive, let the browser decide
      }
      if (typeof html !== 'string' || html.length === 0) return null;
      if (html.includes('This job announcement has closed') || /"ClockDisplay"\s*:\s*"JobClosed"/.test(html)) {
        return {
          result: 'expired',
          code: 'usajobs_page_closed',
          reason: 'USAJOBS shows "This job announcement has closed" — announcement closed',
        };
      }
      return { result: 'active', code: 'usajobs_page_ok', reason: 'USAJOBS serves the announcement with no closed marker (live)' };
    },
    async interpretGone() {
      // The 404 for an unknown control number is BARE — no posting-level body
      // marker exists to demand — so a broken /job route would mass-404 every
      // federal posting. Mitigate like the greenhouse_embed rung: confirm the
      // route still answers 200 for a sentinel announcement before trusting
      // this 404 as posting-level.
      if (!(await usajobsRouteAlive())) return null;
      return {
        result: 'expired',
        code: 'usajobs_page_gone',
        reason: 'USAJOBS 404 with the /job route confirmed healthy — announcement removed',
      };
    },
  },
  {
    id: 'nav',
    // arbeidsplassen.nav.no/stillinger/stilling/{uuid} — exactly the URL shape
    // providers/nav.mjs emits. The feed's per-entry endpoint answers with the
    // ad's lifecycle status, and it RETAINS INACTIVE entries for years — a
    // genuinely dead ad presents as 200/INACTIVE, so a 404 (empty body) more
    // likely means a mangled uuid than a removal. The 404 therefore stays
    // inconclusive (api404Authoritative: false); the body decides.
    match(u) {
      if (u.hostname !== 'arbeidsplassen.nav.no') return null;
      const m = u.pathname.match(
        /^\/stillinger\/stilling\/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\/?$/
      );
      return m ? { uuid: m[1] } : null;
    },
    api: ({ uuid }) => `https://pam-stilling-feed.nav.no/api/v1/feedentry/${uuid}`,
    headers: navHeaders, // rotating public JWT, fetched per run; null (token outage) skips the rung
    api404Authoritative: false,
    async interpret(res) {
      let json;
      try {
        json = await res.json();
      } catch {
        return null; // unparseable body → inconclusive, let the browser decide
      }
      if (json?.status === 'INACTIVE') {
        return { result: 'expired', code: 'nav_feedentry_inactive', reason: 'Nav feed entry is INACTIVE — ad withdrawn/expired' };
      }
      if (json?.status === 'ACTIVE') {
        return { result: 'active', code: 'nav_feedentry_active', reason: 'Nav feed entry is ACTIVE (live)' };
      }
      return null; // unrecognized payload → browser decides
    },
    async interpretOther(res) {
      // 401 = the public token rotated mid-run (or the fetch raced a rotation)
      // — not a verdict on the ad. Drop the cached token so the next Nav URL
      // fetches a fresh one instead of riding the dead JWT all sweep.
      if (res.status === 401) navTokenPromise = null;
      return null;
    },
  },
];

// ── Government-channel rung prerequisites ────────────────────────────────────
// France Travail and Nav gate their per-job endpoints on a runtime credential
// (an OAuth token, a rotating public JWT). Each helper resolves the request
// headers at most once per process and returns null when the prerequisite is
// missing — checkLivenessViaApi turns that null into a clean rung skip
// (browser fallback), never a throw and never a per-job warning.

let ftTokenPromise = null; // one token fetch per run; failure paths clear it so the next offer retries
let ftCredsBroken = false; // a deterministic credential failure degrades the whole batch, not one offer

async function francetravailHeaders() {
  if (ftCredsBroken) return null;
  // Lazy import: the provider module rides providers/_http.mjs side effects,
  // same reason the full-list section below defers its imports.
  const { readCredentials } = await import('./providers/francetravail.mjs');
  const creds = readCredentials();
  if (!creds) return null; // credentials absent → skip silently, never warn per-offer
  ftTokenPromise ??= (async () => {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
    try {
      const res = await fetch('https://entreprise.francetravail.fr/connexion/oauth2/access_token?realm=%2Fpartenaire', {
        method: 'POST',
        headers: {
          'user-agent': DEFAULT_USER_AGENT,
          'content-type': 'application/x-www-form-urlencoded',
          accept: 'application/json',
        },
        body: new URLSearchParams({
          grant_type: 'client_credentials',
          client_id: creds.clientId,
          client_secret: creds.clientSecret,
          scope: 'api_offresdemploiv2 o2dsoffre',
        }).toString(),
        redirect: 'error',
        signal: controller.signal,
      });
      // 400 is the endpoint's answer for bad credentials as well as malformed
      // requests (live-verified: invalid_client arrives as HTTP 400) —
      // deterministic, so retrying the same creds cannot succeed. Anything
      // else non-200 may be transient; the null-token cleanup below un-caches
      // it so the next offer retries.
      if (res.status === 400) ftCredsBroken = true;
      if (res.status !== 200) return '';
      const json = await res.json();
      return typeof json?.access_token === 'string' ? json.access_token : '';
    } catch {
      return ''; // network/timeout → no token this attempt
    } finally {
      clearTimeout(timer);
    }
  })();
  const token = await ftTokenPromise;
  if (!token) ftTokenPromise = null; // transient failure → let the next offer retry
  return token ? { authorization: `Bearer ${token}` } : null;
}

let navTokenPromise = null; // one token fetch per run; the nav 401 path above clears it

async function navHeaders() {
  navTokenPromise ??= (async () => {
    const { extractPublicToken } = await import('./providers/nav.mjs');
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
    try {
      const res = await fetch('https://pam-stilling-feed.nav.no/api/publicToken', {
        method: 'GET',
        headers: { 'user-agent': DEFAULT_USER_AGENT, accept: 'text/plain' },
        redirect: 'error',
        signal: controller.signal,
      });
      if (res.status !== 200) return '';
      // The body is a prefix line plus the JWT; '' when no JWT is found.
      // Rotates ~every 35 days — fetched per run, NEVER hard-coded.
      return extractPublicToken(await res.text());
    } catch {
      return '';
    } finally {
      clearTimeout(timer);
    }
  })();
  const token = await navTokenPromise;
  if (!token) navTokenPromise = null; // transient failure → let the next URL retry
  return token ? { authorization: `Bearer ${token}` } : null;
}

// USAJOBS route-health sentinel: an announcement that closed in 2020 and that
// USAJOBS serves 200 indefinitely (closed postings never 404 there — they show
// the closed marker instead). If the sentinel answers 200, the /job route
// works, so a 404 elsewhere is about THAT control number. Success is cached
// for the run; failure is not, so a transient edge hiccup costs a re-probe on
// the next 404 instead of condemning the whole sweep's 404s to the browser.
const USAJOBS_SENTINEL = 'https://www.usajobs.gov/job/309472900';
let usajobsRoutePromise = null;

async function usajobsRouteAlive() {
  usajobsRoutePromise ??= (async () => {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
    try {
      const res = await fetch(USAJOBS_SENTINEL, {
        method: 'GET',
        headers: { 'user-agent': BROWSER_LIKE_USER_AGENT, accept: 'text/html' },
        redirect: 'error',
        signal: controller.signal,
      });
      return res.status === 200;
    } catch {
      return false;
    } finally {
      clearTimeout(timer);
    }
  })();
  const ok = await usajobsRoutePromise;
  if (!ok) usajobsRoutePromise = null;
  return ok;
}

// Branded hosts served by Eightfold AI. See the `eightfold` provider above for
// why this is an allowlist and not a pattern.
const EIGHTFOLD_HOSTS = new Set([
  'apply.careers.microsoft.com',
  'careers.qualcomm.com',
]);
// LinkedIn renders a closed posting with an explicit banner
// (`<figcaption class="closed-job__flavor--closed">No longer accepting
// applications</figcaption>`) and drops the apply control. A live posting shows one
// of two apply controls: the on-site button, or the off-site sign-in modal.
const LINKEDIN_CLOSED_MARKER = /No longer accepting applications/i;
const LINKEDIN_APPLY_CONTROL = /public_jobs_apply-link-onsite|job-details-topcard-apply-modal/;

/**
 * Decide liveness for one LinkedIn posting from its guest-endpoint HTML.
 * Pure + deterministic (no I/O), mirroring classifyLiveness in liveness-core.mjs.
 *
 * The two signals are read independently and must agree before this concludes
 * anything. A body carrying the closed banner AND an apply control, or neither, is
 * a page we do not recognise — a layout change, a partial render, an interstitial —
 * and it returns `uncertain` rather than picking the likelier answer.
 *
 * The asymmetry is deliberate and is the whole reason for the two-signal rule, and
 * it is this module's CONSERVATIVE BY DESIGN rule applied to a body read rather than
 * a status code: a wrong `expired` costs the user a real job they never see again,
 * while a wrong `uncertain` costs one re-check on the next sweep.
 *
 * @param {any} html - the guest endpoint's response body
 * @returns {{ result: 'active' | 'expired' | 'uncertain', code: string, reason: string } | null}
 *   null = nothing to read (empty or non-string body) → caller falls back.
 */
export function classifyLinkedInPosting(html) {
  if (typeof html !== 'string' || html.length === 0) return null;
  const closed = LINKEDIN_CLOSED_MARKER.test(html);
  const apply = LINKEDIN_APPLY_CONTROL.test(html);
  if (closed && !apply) {
    return {
      result: 'expired',
      code: 'linkedin_closed_marker',
      reason: 'LinkedIn shows "No longer accepting applications" and no apply control',
    };
  }
  if (apply && !closed) {
    return {
      result: 'active',
      code: 'linkedin_apply_control',
      reason: 'LinkedIn shows an apply control and no closure banner (live)',
    };
  }
  return {
    result: 'uncertain',
    code: 'linkedin_signals_disagree',
    reason: closed
      ? 'LinkedIn shows both a closure banner and an apply control — unrecognised page'
      : 'LinkedIn shows neither a closure banner nor an apply control — unrecognised page',
  };
}

// Reserved send times per provider, so back-to-back callers queue behind each
// other instead of all reading the same "last request" timestamp and firing
// together.
const nextRequestAt = new Map();

/**
 * Wait until this provider's next request slot, then reserve the one after it.
 *
 * @param {string} providerId
 * @param {number} [intervalMs] - minimum spacing; falsy means no throttling
 * @returns {Promise<number>} milliseconds actually waited
 */
export async function throttleProviderRequest(providerId, intervalMs) {
  if (!intervalMs) return 0;
  const now = Date.now();
  const earliest = Math.max(now, nextRequestAt.get(providerId) ?? 0);
  nextRequestAt.set(providerId, earliest + intervalMs);
  const wait = earliest - now;
  if (wait > 0) await new Promise((resolve) => setTimeout(resolve, wait));
  return wait;
}

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
  const portals = process.env.CAREER_OPS_PORTALS || join(getCareerOpsRoot(), 'portals.yml');
  const text = existsSync(portals) ? readFileSync(portals, 'utf-8') : '';
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
 * @returns {{ ats: string, apiUrl: string, parts: Record<string, string>, timeoutMs?: number, throttleMs?: number, accept?: string, headers?: Record<string, string> | ((parts: Record<string, string>) => Promise<Record<string, string> | null>), interpret?: (res: Response, parts: Record<string, string>) => Promise<{ result: 'active' | 'expired' | 'uncertain', code: string, reason: string } | null>, api404Authoritative: boolean } | null}
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
      followEmbed: provider.followEmbed,
      interpret: provider.interpret,
      interpretGone: provider.interpretGone,
      interpretOther: provider.interpretOther,
      accept: provider.accept,
      headers: provider.headers,
      throttleMs: provider.throttleMs,
      api404Authoritative: provider.api404Authoritative !== false,
    };
  }
  return null;
}

/** True if `url` is an ATS posting we can check via API (lets callers stay lazy about the browser). */
export function isAtsPosting(url) {
  return resolveAtsApi(url) !== null;
}

// ATS ids whose public API returns the actual JD body (not just a liveness
// signal). Greenhouse (`content`), Lever (`descriptionPlain`), Ashby
// (`descriptionPlain` on the org board), Workday (`jobPostingInfo.jobDescription`
// on the per-job CXS endpoint) all ship full text for free in the same payload
// resolveAtsApi() already points at. Microsoft and LinkedIn are on ATS_PROVIDERS
// for liveness only — their public endpoints answer search/status, never body
// text — so they are deliberately excluded here; see fetch-jd.mjs / the
// fetch*Jd() family in browser-extract.mjs for the per-provider fetchers.
export const JD_TEXT_API_ATS = new Set(['greenhouse', 'lever', 'ashby', 'workday']);

/**
 * Zero-token liveness check via the posting's ATS API.
 * @param {string} url
 * @returns {Promise<{ result: 'active' | 'expired' | 'uncertain', code: string, reason: string } | null>}
 *   null = not a known ATS posting, or inconclusive → caller should fall back to Playwright.
 *   `uncertain` is a conclusion in its own right: the provider reached the posting
 *   and could not read it, and no other rung would do better.
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
  // Third rung: full-list providers — the tenant's whole board in one fetch,
  // where absence from a SUCCESSFUL fetch is as authoritative as a per-job 404.
  if (!resolved) return checkLivenessViaFullList(url);
  const { ats, apiUrl, parts, interpret, interpretGone, interpretOther, accept, headers, followEmbed, timeoutMs, throttleMs, api404Authoritative } = resolved;

  // Resolve function-valued headers first (rungs gated on a runtime credential
  // or rotating token): null means the prerequisite is unavailable and the
  // rung is skipped cleanly — no request fired, no verdict, browser fallback.
  let requestHeaders = headers;
  if (typeof requestHeaders === 'function') {
    try {
      requestHeaders = await requestHeaders(parts);
    } catch {
      return null;
    }
    if (!requestHeaders) return null;
  }

  // Wait out any provider rate limit BEFORE arming the timeout, so the spacing
  // does not eat the budget the request itself needs.
  await throttleProviderRequest(ats, throttleMs);

  // The timeout guards the whole classification (fetch + any `interpret` body read),
  // since aborting the shared signal also tears down an in-flight res.json().
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs || TIMEOUT_MS);
  try {
    let res;
    try {
      res = await fetch(apiUrl, {
        method: 'GET',
        headers: { 'user-agent': DEFAULT_USER_AGENT, accept: accept || 'application/json', ...requestHeaders },
        // Refuse server-side redirects (SSRF + ambiguity guard), except where the
        // provider reads the redirect itself to find the embedded job's API URL.
        redirect: followEmbed ? 'manual' : 'error',
        signal: controller.signal,
      });
      if (followEmbed) {
        const jobApiUrl = await followEmbed(res, parts);
        if (!jobApiUrl) return null;
        res = await fetch(jobApiUrl, {
          method: 'GET',
          headers: { 'user-agent': DEFAULT_USER_AGENT, accept: 'application/json' },
          redirect: 'error',
          signal: controller.signal,
        });
      }
    } catch {
      return null; // network / timeout / redirect → inconclusive, let Playwright decide
    }

    if (res.status === 404 || res.status === 410) {
      // Where the same status can mean "wrong board" as well as "posting removed",
      // the body decides — and an unreadable body stays inconclusive.
      if (interpretGone) return await interpretGone(res, parts);
      if (!api404Authoritative) return null; // inconclusive → let Playwright check the real page
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

// ── Full-list providers ──────────────────────────────────────────────────────
// Seven ATSs return the tenant's ENTIRE board in one 200 response, so absence
// from a fresh successful fetch is proof of removal exactly as a per-job 404 is
// (the rule itself is classifyFullListAbsence in liveness-core.mjs). The board
// fetch is the scanner's own provider plugin — providers/*.mjs already carry
// every endpoint, retry policy, and SSRF guard, so nothing is reimplemented
// here. Each plugin's detect() only reads the hostname / first path segment of
// `careers_url`, which a posting URL carries too, so detection is simply
// `detect({ careers_url: url })`.
//
// `posting` narrows the claim to per-job URLs: a board root also satisfies
// detect() but is not a posting, and running the absence rule on it would
// manufacture exactly the false "expired" this module exists to avoid.
const FULL_LIST_PROVIDERS = [
  { module: './providers/ashby.mjs', posting: /^\/[^/]+\/[^/]+/ },
  { module: './providers/breezy.mjs', posting: /^\/p\/[^/]+/ },
  { module: './providers/jobvite.mjs', posting: /^\/[^/]+\/job\/[^/]+/i },
  { module: './providers/personio.mjs', posting: /^\/job\/\d+/ },
  { module: './providers/pinpoint.mjs', posting: /\/postings\/[^/]+/ },
  { module: './providers/rippling.mjs', posting: /^\/[^/]+\/jobs\/[^/]+/ },
  { module: './providers/teamtailor.mjs', posting: /^\/jobs\/\d+/ },
];

// Loaded lazily so the provider modules (and their transitive dns/ip-guard
// side effects in providers/_http.mjs) only load when a full-list URL is
// actually checked, not for every importer of this module.
let fullListLoaded = null;
async function loadFullListProviders() {
  fullListLoaded ??= (async () => {
    const { makeHttpCtx } = await import('./providers/_http.mjs');
    const providers = [];
    for (const { module, posting } of FULL_LIST_PROVIDERS) {
      providers.push({ provider: (await import(module)).default, posting });
    }
    return { ctx: makeHttpCtx(), providers };
  })();
  return fullListLoaded;
}

// One board fetch per tenant per process: a sweep checks many postings from the
// same board, and re-fetching per URL is what earns the 429s (app.jobvite.com
// throttles from the second request on). A failed fetch is evicted, so a later
// URL retries instead of inheriting a transient error.
const boardFetches = new Map();
function fetchBoardOnce(key, provider, entry, ctx) {
  let p = boardFetches.get(key);
  if (!p) {
    p = provider.fetch(entry, ctx);
    boardFetches.set(key, p);
    p.catch(() => boardFetches.delete(key));
  }
  return p;
}

/**
 * Full-list liveness check: fetch the whole tenant board via the scanner's own
 * provider plugin, then classify presence/absence (liveness-core owns the rule).
 * @param {string} url
 * @returns {Promise<{ result: 'active' | 'expired' | 'uncertain', code: string, reason: string } | null>}
 *   null = not a full-list posting URL, or the board fetch failed → caller
 *   falls back to the browser rung. A failed LIST fetch says nothing about the
 *   posting page itself, so the browser must still get to read that page —
 *   which is why the rule's `full_list_fetch_failed` verdict maps to null here
 *   rather than surfacing as a terminal `uncertain`. `full_list_empty` maps to
 *   null for the same reason: parsers launder an unreadable 200 into [], and
 *   the browser rung still catches a genuinely-all-closed board via 404/banner.
 */
export async function checkLivenessViaFullList(url) {
  let u;
  try {
    u = new URL(url);
  } catch {
    return null;
  }
  if (u.protocol !== 'https:') return null;
  const { ctx, providers } = await loadFullListProviders();
  for (const { provider, posting } of providers) {
    let hit;
    try {
      hit = provider.detect({ careers_url: url });
    } catch {
      hit = null;
    }
    if (!hit) continue;
    if (!posting.test(u.pathname)) return null; // this provider's board root, not a posting
    let jobs;
    let fetchSucceeded = true;
    try {
      jobs = await fetchBoardOnce(`${provider.id} ${hit.url}`, provider, { name: u.hostname, careers_url: url }, ctx);
    } catch {
      fetchSucceeded = false;
    }
    const verdict = classifyFullListAbsence({ fetchSucceeded, jobs, targetUrl: url, provider: provider.id });
    return verdict.code === 'full_list_fetch_failed' || verdict.code === 'full_list_empty' ? null : verdict;
  }
  return null;
}
