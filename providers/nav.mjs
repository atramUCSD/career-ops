// @ts-check
/** @typedef {import('./_types.js').Provider} Provider */

// NAV pam-stilling-feed provider — the official job-vacancy feed behind
// arbeidsplassen.nav.no (Norway's public job board, run by the welfare agency
// NAV). https://pam-stilling-feed.nav.no, a Javalin app; source at
// github.com/navikt/pam-stilling-feed.
//
// All shapes below were LIVE-PROBED on 2026-08-29 unless marked otherwise.
//
// TOKEN MECHANICS (live-verified):
//   The API wants `Authorization: Bearer <JWT>` on every /api/v1/* call
//   (missing/bad token → HTTP 401, Javalin JSON error body). NAV publishes a
//   PUBLIC ROTATING token on the service itself:
//     GET /api/publicToken            → 200 text/plain, no auth needed:
//       "Current public token for Nav Job Vacancy Feed:\n<JWT>"
//   The probed token's payload had iat/exp ~35 days apart (aud "feed-api-v2",
//   sub nav.team.arbeidsplassen@nav.no), so it rotates — fetch it fresh per
//   run, never hard-code it. Extraction: first JWT-shaped (eyJ...) string in
//   the body. Registered per-consumer tokens exist (repo README) but need a
//   manual signup with NAV; the public token is the documented anonymous path.
//
// FEED SHAPE (live-verified). JSON Feed 1.0-flavoured, oldest first,
// append-only, up to 1000 items per stored page:
//   GET /api/v1/feed                → first (2023) page
//   GET /api/v1/feed?last=true      → newest, still-filling page
//   GET /api/v1/feed  + If-Modified-Since: <RFC1123>
//                                   → FIRST PAGE NEWER than that date (the
//                                     catch-up entry point this provider uses);
//                                     404 with empty body when nothing is newer
//                                     (probed with a future date).
//   GET /api/v1/feed/{feedPageId}   → specific page; 404 unknown, 304 empty
//                                     page (both DOCUMENTED-ONLY, from the
//                                     navikt/pam-stilling-feed source — not
//                                     live-probed)
//   Page: {version, title, home_page_url, feed_url, description, next_url,
//          id, next_id, items[]} — next_url/next_id are null on the last page,
//          next_url is HOST-RELATIVE ("/api/v1/feed/<uuid>").
//   Item: {id, url, title, content_text: "Stillingsannonse", date_modified,
//          _feed_entry: {uuid, status: "ACTIVE"|"INACTIVE", title,
//                        businessName, municipal, sistEndret}}
//   A feed item is a CHANGE EVENT, not a posting: the same uuid reappears each
//   time the ad changes, and deactivation arrives as a later INACTIVE event —
//   so dedup must keep the LAST event per uuid before filtering to ACTIVE.
//   INACTIVE events may be anonymized (title "...", businessName "").
//   Server date-parsing gotcha (probed): If-Modified-Since is parsed with
//   Java's RFC_1123_DATE_TIME, and a WRONG WEEKDAY makes parsing fail
//   SILENTLY, falling back to the first-ever (2023) page. JS
//   Date.prototype.toUTCString() emits the correct weekday, so build the
//   header with it and never by hand.
//
// PER-ENTRY ENDPOINT (live-verified — this is the liveness rung's surface):
//   GET /api/v1/feedentry/{uuid}
//     ACTIVE ad   → 200 {uuid, ad_content: {uuid, published, expires, title,
//                    jobtitle, description, link, employer: {name, orgnr, ...},
//                    workLocations: [{country, address, city, postalCode,
//                    county, municipal}], applicationUrl, sourceurl, sector,
//                    extent, engagementtype, ...}, sistEndret, status: "ACTIVE"}
//     INACTIVE ad → 200 {uuid, sistEndret, status: "INACTIVE"} — NO ad_content
//     unknown uuid (well-formed) → 404, EMPTY body (authoritative not-found)
//     malformed id (not a UUID)  → 500 Javalin JSON error body
//     no/bad token               → 401 (token failure, NOT a verdict on the ad)
//
// PUBLIC AD URL (live-verified via ad_content.link):
//   https://arbeidsplassen.nav.no/stillinger/stilling/{uuid}
//
// Ingest strategy: fetch the public token, then walk the feed forward from
// `If-Modified-Since: now - days` following next_url (maxPages cap), keep the
// last event per uuid, return only ACTIVE ads. Feed volume observed ~2.5k
// events/day, so the defaults (days: 2, maxPages: 10 = up to 10k events)
// comfortably cover a daily scan; page selection is server-side per stored
// page, so the days cushion also absorbs the page-boundary slack.
//
// Configure via a portals.yml entry with `provider: nav` (no detect() — the
// feed is a national board, not a per-company ATS):
//
//   - name: NAV arbeidsplassen.no
//     provider: nav
//     nav:
//       days: 2        # catch-up window (feed pages newer than now - days)
//       maxPages: 10   # cap on feed pages walked (up to 1000 events each)
//     enabled: true
//
// scan.mjs applies title_filter/location_filter downstream, so this provider
// over-fetches (recall-first), same as arbeitsagentur.

import { intInRange } from './_config-utils.mjs';

const FEED_ORIGIN = 'https://pam-stilling-feed.nav.no';
const FEED_URL = `${FEED_ORIGIN}/api/v1/feed`;
const TOKEN_URL = `${FEED_ORIGIN}/api/publicToken`;
const AD_BASE = 'https://arbeidsplassen.nav.no/stillinger/stilling/';
const PAGE_DELAY_MS = 120; // polite pacing between page requests (csod's value)

/**
 * Pull the rotating public JWT out of the /api/publicToken plain-text body.
 * @param {unknown} text @returns {string}
 */
export function extractPublicToken(text) {
  const m = typeof text === 'string' ? text.match(/\beyJ[\w-]+\.[\w-]+\.[\w-]+/) : null;
  return m ? m[0] : '';
}

/**
 * Reads and sanitizes the entry's `nav:` config block.
 * @param {{ nav?: any }} entry
 * @returns {{ days: number, maxPages: number }}
 */
export function parseNavConfig(entry) {
  const cfg = (entry && entry.nav) || {};
  return {
    days: intInRange(cfg.days, 2, 1, 30),
    maxPages: intInRange(cfg.maxPages, 10, 1, 50),
  };
}

/**
 * Normalizes one feed item (change event) into a Job carrying its uuid and
 * status (both stripped before the provider returns). Null only when the
 * event lacks a uuid. A title is deliberately NOT required here: anonymized
 * INACTIVE events can arrive without one, and dropping them from the dedup
 * map would revive the earlier ACTIVE event for the same uuid. Titleless
 * jobs are filtered from the final ACTIVE output instead.
 * @param {any} item
 * @returns {({title: string, url: string, company: string, location: string, postedAt?: number, uuid: string, status: string}) | null}
 */
export function normalizeItem(item) {
  const fe = (item && item._feed_entry) || {};
  const uuid = String(fe.uuid || (item && item.id) || '').trim();
  const title = String(fe.title || (item && item.title) || '').trim();
  if (!uuid) return null;
  /** @type {any} */
  const job = {
    title,
    url: AD_BASE + encodeURIComponent(uuid),
    company: String(fe.businessName || '').trim(),
    location: String(fe.municipal || '').trim(),
    uuid,
    status: String(fe.status || ''),
  };
  const postedAt = Date.parse(String((item && item.date_modified) || ''));
  if (Number.isFinite(postedAt)) job.postedAt = postedAt;
  return job;
}

/** @type {Provider} */
export default {
  id: 'nav',

  /**
   * Fetches recent feed events from pam-stilling-feed and returns the ads
   * whose LAST event within the window is ACTIVE.
   * @param {{ name?: string, nav?: any }} entry
   * @param {import('./_types.js').Context} ctx
   * @returns {Promise<Array<{title: string, url: string, company: string, location: string}>>}
   */
  async fetch(entry, ctx) {
    const cfg = parseNavConfig(entry);
    // Honor the health probe's pagination hint (verify-portals passes 1).
    const maxPages = Math.min(cfg.maxPages, ctx.maxPages > 0 ? ctx.maxPages : Infinity);

    // 1. Rotating public token — fetched fresh per run (see header). A failure
    //    here is a total outage: throw so scan.mjs warns instead of logging a
    //    fake empty board.
    const tokenText = await ctx.fetchText(TOKEN_URL, { redirect: 'error', timeoutMs: 10_000 });
    const token = extractPublicToken(tokenText);
    if (!token) throw new Error(`nav: no public token in ${TOKEN_URL} response`);
    const headers = { authorization: `Bearer ${token}`, accept: 'application/json' };

    // 2. Catch-up entry point: first page newer than the window start.
    //    toUTCString() gets the weekday right — mandatory, see header.
    const since = new Date(Date.now() - cfg.days * 86_400_000).toUTCString();
    let json;
    try {
      json = await ctx.fetchJson(FEED_URL, {
        redirect: 'error',
        timeoutMs: 15_000,
        headers: { ...headers, 'if-modified-since': since },
      });
    } catch (err) {
      // 404 = "no page newer than the cutoff" (probed with a future date) and
      // 304 = "page empty": both are a legitimately quiet feed, not an outage.
      if (err && (err.status === 404 || err.status === 304)) return [];
      throw err;
    }

    const wait = (ms) => (ctx.sleep ? ctx.sleep(ms) : new Promise((r) => setTimeout(r, ms)));
    const byUuid = new Map();
    for (let page = 1; ; page++) {
      if (!json || !Array.isArray(json.items)) {
        // First page unreadable = the board is unreadable, not empty. A later
        // page going bad only truncates the walk.
        if (page === 1) throw new Error(`nav: unexpected API response shape (no items[]) for "${entry.name || '(unnamed)'}"`);
        console.error(`⚠️  nav: page ${page} had no items[] — keeping ${byUuid.size} events from earlier pages`);
        break;
      }
      // Chronological feed: a later event for the same uuid supersedes the
      // earlier one (ACTIVE then INACTIVE means the ad is gone).
      for (const raw of json.items) {
        const job = normalizeItem(raw);
        if (job) byUuid.set(job.uuid, job);
      }
      if (page >= maxPages || !json.next_url) break;
      // next_url is host-relative; resolve against the feed origin and refuse
      // anything that leaves it (a poisoned payload must not steer requests).
      let next;
      try {
        next = new URL(String(json.next_url), FEED_ORIGIN);
      } catch {
        console.error(`⚠️  nav: unparseable next_url — stopping the walk`);
        break;
      }
      if (next.origin !== FEED_ORIGIN) {
        console.error(`⚠️  nav: next_url left ${FEED_ORIGIN} — stopping the walk`);
        break;
      }
      await wait(PAGE_DELAY_MS);
      try {
        json = await ctx.fetchJson(next.href, { redirect: 'error', timeoutMs: 15_000, headers });
      } catch (err) {
        // Keep what the completed pages already yielded; a partial window is
        // real data, unlike a fabricated empty board.
        console.error(`⚠️  nav: page walk stopped at page ${page + 1} (${(err && err.message) || err}) — keeping ${byUuid.size} events`);
        break;
      }
    }

    return [...byUuid.values()]
      .filter(job => job.status === 'ACTIVE' && job.title)
      .map(({ uuid, status, ...job }) => job);
  },
};
