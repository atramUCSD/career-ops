// @ts-check
/** @typedef {import('./_types.js').Provider} Provider */

// CalCareers (State of California civil service) provider — a job_boards:
// entry for the state's own hiring portal. Every posting is a California
// state department, so it is employer-attributed by construction.
//
// The site is ASP.NET WebForms with no API, RSS, sitemap or query-string
// search: criteria live in the server session and are accepted only through
// a form postback. So each keyword is a short postback chain inside one
// session cookie (live-probed 2026-10-04):
//   1. GET  JobSearchResults.aspx → empty search form, ASP.NET_SessionId
//      cookie, hidden __VIEWSTATE / __EVENTVALIDATION.
//   2. POST txtKeyword + btnUpdateResults → first 10 cards and
//      "Classification: N job(s) found." (or "No jobs found matching your
//      search criteria.").
//   3. N > 10: POST __EVENTTARGET=ddlRowCount, ddlRowCount=100 → 100 cards.
//   4. N > 100: POST __EVENTTARGET=ddlSortBy, "PublishDate DESC" → the 100
//      newest. Steps 3–4 must be separate postbacks off the previous page's
//      hidden fields: setting either select on the step-2 POST, or posting
//      step 3 for a zero-hit search (no select rendered), 302s to
//      /Error.aspx?mode=500, which redirect:'error' surfaces as a failure.
// robots.txt is fully commented out (no rules).
//
// Card fields: classification (the link text), Working Title, Job Control,
// Salary Range, Work Type/Schedule, Department, Location (a county),
// Telework, Publish Date (M/D/YYYY).
//
// Configure via a portals.yml job_boards: entry:
//
//   - name: CalCareers — CA state
//     provider: calcareers
//     calcareers:
//       keywords: ["user experience", "web developer"]  # full-text, not title-only;
//                                         # falls back to profile.yml target_roles
//     enabled: true

import { resolveProfileKeywords } from './_profile-keywords.mjs';
import { decodeEntities } from './_html-entities.mjs';

const SEARCH_URL = 'https://calcareers.ca.gov/CalHrPublic/Search/JobSearchResults.aspx';
const POSTING_URL = 'https://www.calcareers.ca.gov/CalHrPublic/Jobs/JobPosting.aspx?JobControlId=';
const F = 'ctl00$cphMainContent$';
const FIRST_PAGE = 10;
const MAX_ROWS = 100;

/**
 * Hidden inputs of a WebForms page, decoded, as the base of the next postback.
 * @param {string} html
 */
export function hiddenFields(html) {
  const form = new URLSearchParams();
  for (const m of html.matchAll(/<input\b[^>]*\btype="hidden"[^>]*>/g)) {
    const name = /\bname="([^"]*)"/.exec(m[0]);
    if (!name) continue;
    const value = /\bvalue="([^"]*)"/.exec(m[0]);
    form.set(decodeEntities(name[1]), decodeEntities(value ? value[1] : ''));
  }
  return form;
}

/**
 * Reads the result count: a number, 0 for the explicit no-match banner, or
 * null when neither marker is present (markup change).
 * @param {string} html
 */
export function resultCount(html) {
  if (/No jobs found(?:<\/strong>)?\s*matching your search criteria/.test(html)) return 0;
  const m = /id="cphMainContent_lblTotalResultCount"[^>]*>\s*([\d,]+)\s*</.exec(html);
  return m ? Number(m[1].replace(/,/g, '')) : null;
}

/** @param {string} s */
const text = s => decodeEntities(s.replace(/<[^>]+>/g, ' ')).replace(/\s+/g, ' ').trim();

/**
 * Parses result cards into Jobs. Rows without a numeric Job Control or a
 * title are dropped.
 * @param {string} html
 */
export function parseCards(html) {
  const jobs = [];
  for (const card of html.split(/id="cphMainContent_rptResults_pnlCardContainer_\d+"/).slice(1)) {
    /** @type {Record<string, string>} */
    const f = {};
    for (const m of card.matchAll(/job-label">([^<]*)<\/div>\s*<div class="col-xs-6 job-details">([\s\S]*?)<\/div>/g)) {
      f[text(m[1]).replace(/:$/, '')] = text(m[2]);
    }
    const id = f['Job Control'];
    if (!id || !/^\d+$/.test(id)) continue;
    const link = /id="cphMainContent_rptResults_hlViewJobPosting_\d+"[^>]*>([^<]*)</.exec(card);
    const classification = link ? text(link[1]) : '';
    const title = f['Working Title'] || classification;
    if (!title) continue;
    // Location is a county; the state suffix lets location_filter's
    // "California" rule see it.
    const where = f.Location ? `${f.Location}, California` : 'California';
    /** @type {{title: string, url: string, company: string, location: string, description?: string, postedAt?: number}} */
    const job = {
      title,
      url: POSTING_URL + id,
      company: f.Department || 'State of California',
      location: f.Telework ? `${where} (${f.Telework})` : where,
    };
    const desc = [classification && `Classification: ${classification}`, f['Salary Range'] && `${f['Salary Range']}/mo`, f['Work Type/Schedule']]
      .filter(Boolean).join(' · ');
    if (desc) job.description = desc;
    const d = /^(\d{1,2})\/(\d{1,2})\/(\d{4})$/.exec(f['Publish Date'] || '');
    if (d) job.postedAt = Date.UTC(+d[3], +d[1] - 1, +d[2]);
    jobs.push(job);
  }
  return jobs;
}

/** @type {Provider} */
export default {
  id: 'calcareers',

  async fetch(entry, ctx) {
    const cfg = (entry && entry.calcareers) || {};
    let keywords = Array.isArray(cfg.keywords)
      ? cfg.keywords.filter(k => typeof k === 'string' && k.trim()).map(k => k.trim())
      : [];
    if (!keywords.length) keywords = resolveProfileKeywords();
    if (!keywords.length) {
      throw new Error(`calcareers: entry "${entry.name || '(unnamed)'}" has no calcareers.keywords[] and profile.yml provided no target_roles`);
    }

    /** @type {Map<string, string>} */
    const jar = new Map();
    /** @param {URLSearchParams | null} form */
    const request = async (form) => {
      const res = await ctx.fetchResponse(SEARCH_URL, {
        method: form ? 'POST' : 'GET',
        headers: {
          ...(form ? { 'content-type': 'application/x-www-form-urlencoded', referer: SEARCH_URL } : {}),
          ...(jar.size ? { cookie: [...jar].map(([k, v]) => `${k}=${v}`).join('; ') } : {}),
        },
        body: form ? form.toString() : null,
        redirect: 'error',
        timeoutMs: 30_000,
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      for (const c of (typeof res.headers.getSetCookie === 'function' ? res.headers.getSetCookie() : [])) {
        const [pair] = c.split(';');
        const eq = pair.indexOf('=');
        if (eq > 0) jar.set(pair.slice(0, eq).trim(), pair.slice(eq + 1).trim());
      }
      return res.text();
    };
    /** @param {string} html @param {string} keyword @param {Record<string, string>} set */
    const postback = (html, keyword, set) => {
      const form = hiddenFields(html);
      form.set(`${F}txtKeyword`, keyword);
      for (const [k, v] of Object.entries(set)) form.set(k, v);
      return request(form);
    };

    const byUrl = new Map();
    const errors = [];
    let succeeded = 0;
    let html;
    try {
      html = await request(null);
    } catch (err) {
      throw new Error(`calcareers: search page unreachable — ${(err && err.message) || err}`);
    }
    for (const kw of keywords) {
      try {
        html = await postback(html, kw, { [`${F}btnUpdateResults`]: 'Search' });
        const total = resultCount(html);
        if (total === null) throw new Error('no result-count marker — markup changed?');
        if (total > FIRST_PAGE) {
          html = await postback(html, kw, { __EVENTTARGET: `${F}ddlRowCount`, [`${F}ddlRowCount`]: String(MAX_ROWS), [`${F}ddlSortBy`]: 'Relevance DESC' });
        }
        if (total > MAX_ROWS) {
          // ponytail: newest 100 per keyword, no pager walk. Narrow keywords
          // stay under it; a broad one ("information technology", ~680)
          // only loses postings older than the newest 100.
          html = await postback(html, kw, { __EVENTTARGET: `${F}ddlSortBy`, [`${F}ddlRowCount`]: String(MAX_ROWS), [`${F}ddlSortBy`]: 'PublishDate DESC' });
        }
        const jobs = total ? parseCards(html) : [];
        if (total && !jobs.length) throw new Error(`${total} job(s) reported but no card parsed — markup changed?`);
        succeeded++;
        for (const job of jobs) if (!byUrl.has(job.url)) byUrl.set(job.url, job);
      } catch (err) {
        errors.push(`"${kw}": ${(err && err.message) || err}`);
        // A failed postback leaves html at a state the next keyword can't
        // post from; restart the session form.
        try { html = await request(null); } catch { break; }
      }
      if (ctx.sleep) await ctx.sleep(500);
    }

    if (succeeded === 0 && errors.length) {
      throw new Error(`calcareers: all ${keywords.length} keyword request(s) failed — ${errors[0]}`);
    }
    return [...byUrl.values()];
  },
};
