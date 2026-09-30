// @ts-check
/** @typedef {import('./_types.js').Provider} Provider */

// CalOpps provider — the California public-agency job board
// (https://www.calopps.org): cities, counties, special districts and transit
// agencies post there directly, so every listing is employer-attributed. Wire
// in via a `job_boards:` entry with `provider: calopps`.
//
// Why HTML, and why this page: measured 2026-09-29, the board has no API or
// feed, but serves a server-rendered Drupal table view at /job-search-list
// (25 rows a page, ~575 postings, newest first). The card view at /job-search
// carries the same postings at 10 a page, so the table costs 2.5x fewer
// requests. robots.txt (fetched 2026-09-29) disallows only Drupal's standard
// paths (/search/, /admin/, /user/*, ...) and sets `Crawl-delay: 10`, which is
// the pacing below. Reading a listing needs no account; applying does.
//
// PARSING CONTRACT: a row is a `<tr>` whose label cell links
// `/{agency-slug}/job-{id}`. The agency slug is the only employer signal the
// table gives, so `company` is that slug title-cased ("san-mateo-county" →
// "San Mateo County"). The region cell ("East Bay", "San Francisco/Peninsula")
// becomes `{region}, California` so a location_filter can match the state.
// The table carries no posted date, so postedAt is omitted rather than
// guessed; its close date ("Until Filled", "10/16/2026") is not a posted date.

import { fetchTextWithRetry, sleep } from './_http.mjs';
import { decodeEntities } from './_html-entities.mjs';

const BASE = 'https://www.calopps.org';
const LIST_URL = `${BASE}/job-search-list`;

/** Rows per table page; a shorter page is the last one. */
const PAGE_SIZE = 25;

/** 40 pages x 25 rows covers the whole board (~23 pages on 2026-09-29) with headroom. */
const DEFAULT_MAX_PAGES = 40;

/** Hard ceiling on a configured `max_pages`, so one entry cannot sweep forever. */
const MAX_PAGES_CAP = 200;

/** robots.txt `Crawl-delay: 10`. A full sweep takes ~4 minutes because of it. */
const INTER_PAGE_DELAY_MS = 10_000;

const ROW_RE = /<tr\b[^>]*>([\s\S]*?)<\/tr>/gi;
const LABEL_RE = /views-field-label[^>]*>\s*<a\b[^>]*href=["']\/([a-z0-9-]+)\/job-(\d+)["'][^>]*>([\s\S]*?)<\/a>/i;
const REGION_RE = /views-field-ss-term-name-field-rec-location[^>]*>([\s\S]*?)<\/td>/i;

const SMALL_WORDS = new Set(['and', 'of', 'the', 'for', 'at', 'on', 'in', 'de', 'del', 'la', 'los', 'las']);

/** @param {string} fragment */
function visibleText(fragment) {
  return decodeEntities(String(fragment ?? '').replace(/<[^>]+>/g, ' ')).replace(/\s+/g, ' ').trim();
}

/**
 * "golden-gate-bridge-highway-and-transportation-district" → "Golden Gate Bridge Highway and Transportation District"
 * @param {string} slug
 */
export function agencyName(slug) {
  return String(slug ?? '')
    .split('-')
    .filter(Boolean)
    .map((w, i) => (i > 0 && SMALL_WORDS.has(w) ? w : w[0].toUpperCase() + w.slice(1)))
    .join(' ');
}

/** @param {number} page - zero-based, like the board's own pager */
export function buildListUrl(page) {
  return page === 0 ? LIST_URL : `${LIST_URL}?page=${page}`;
}

/**
 * @param {string} html - One table page.
 * @returns {{rows: number, jobs: {title: string, url: string, company: string, location: string}[]}}
 *   `rows` counts posting rows seen, including ones dropped for a missing field,
 *   so the short-page stop is not fooled by a malformed row.
 */
export function parseListingPage(html) {
  const jobs = [];
  let rows = 0;
  for (const [, row] of String(html ?? '').matchAll(ROW_RE)) {
    const label = LABEL_RE.exec(row);
    if (!label) continue;
    rows++;
    const [, slug, id, rawTitle] = label;
    const title = visibleText(rawTitle);
    if (!title) continue;
    const region = visibleText(REGION_RE.exec(row)?.[1]);
    jobs.push({
      title,
      url: `${BASE}/${slug}/job-${id}`,
      company: agencyName(slug),
      location: region ? `${region}, California` : 'California',
    });
  }
  return { rows, jobs };
}

/**
 * A page that still links postings but parsed to nothing is a markup change,
 * not an empty board — report it instead of returning [].
 * @param {string} html
 * @param {string} url
 */
export function assertParsedSomething(html, url) {
  if (!/href=["']\/[a-z0-9-]+\/job-\d+["']/i.test(String(html ?? ''))) return;
  throw new Error(`calopps: ${url} still links postings but no row could be parsed — the listing markup changed`);
}

/** @type {Provider} */
export default {
  id: 'calopps',

  detect(entry) {
    return entry?.provider === 'calopps' ? { url: LIST_URL } : null;
  },

  async fetch(entry, ctx) {
    const entryMaxPages = Number.isInteger(entry?.max_pages) && entry.max_pages > 0
      ? Math.min(entry.max_pages, MAX_PAGES_CAP)
      : DEFAULT_MAX_PAGES;
    const probing = Number.isInteger(ctx?.maxPages) && ctx.maxPages > 0;
    const maxPages = Math.min(entryMaxPages, probing ? ctx.maxPages : Infinity);

    /** @type {any[]} */
    const jobs = [];
    const seen = new Set();
    let complete = false;

    for (let page = 0; page < maxPages; page++) {
      if (page > 0) await sleep(INTER_PAGE_DELAY_MS, ctx);
      const url = buildListUrl(page);
      let html;
      try {
        html = await fetchTextWithRetry(ctx, url, { redirect: 'error' });
      } catch (err) {
        // Page 0 failing is a failed board. A later page keeps the pages already
        // read: at 10s a page, dropping them would waste the whole sweep.
        if (page === 0 || probing) throw err;
        console.error(`⚠️  calopps: ${entry?.name ?? 'CalOpps'} truncated at page ${page + 1} after ${err?.attempts ?? '?'} attempts (${jobs.length} jobs): ${err?.message ?? err}`);
        complete = true; // not a cap stop, so no "raise max_pages" advice
        break;
      }

      const { rows, jobs: parsed } = parseListingPage(html);
      if (parsed.length === 0 && page === 0) assertParsedSomething(html, url);
      const before = seen.size;
      for (const job of parsed) {
        if (seen.has(job.url)) continue;
        seen.add(job.url);
        jobs.push(job);
      }
      if (rows < PAGE_SIZE || seen.size === before) { complete = true; break; }
    }

    if (!complete && !probing && maxPages === entryMaxPages) {
      console.error(`⚠️  calopps: ${entry?.name ?? 'CalOpps'} stopped at the ${maxPages}-page limit with more pages left — raise max_pages to read the rest`);
    }
    return jobs;
  },
};
