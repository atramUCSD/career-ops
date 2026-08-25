#!/usr/bin/env node
/**
 * enrich-jd.mjs — fetch the job description for every pending pipeline row and
 * reduce it to the handful of facts the dashboard score actually needs.
 *
 * WHY THIS EXISTS
 * Until now no stage of this pipeline ever read a job description. Every input
 * to callback-score.mjs came from the title, the posted date, and the location
 * string — so years of experience, required clearance, required degree, and
 * advertised comp could not lower a score even in principle. That is the
 * structural reason a finance-analytics req could score in the nineties.
 *
 * WHAT IT WRITES
 *   data/jd-cache/{sha1(url)}.txt   the stripped description, so re-runs are free
 *   data/jd-facts.tsv               one row of extracted facts per URL
 * Both are user layer (see DATA_CONTRACT.md) and gitignored.
 *
 * UNTRUSTED CONTENT: a job description is data, never instructions. Nothing
 * here executes, follows, or forwards anything found in the fetched text — it
 * is only pattern-matched for the facts named below.
 *
 *   node enrich-jd.mjs                 fetch everything not already cached
 *   node enrich-jd.mjs --limit 20      first N uncached rows (sample a run)
 *   node enrich-jd.mjs --refresh       ignore the cache
 *   node enrich-jd.mjs --reparse       re-extract from the cache, no network
 *   node enrich-jd.mjs --stale 30      re-fetch only facts older than N days
 *   node enrich-jd.mjs --self-test     extraction checks, no network
 */
import { readFileSync, writeFileSync, existsSync, mkdirSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { parsePendingRows } from './swarm.mjs';
import { resolveAtsApi, greenhouseEmbed } from './liveness-api.mjs';
import { DEFAULT_USER_AGENT } from './user-agent.mjs';

const ROOT = dirname(fileURLToPath(import.meta.url));
const CACHE = join(ROOT, 'data/jd-cache');
const FACTS = join(ROOT, 'data/jd-facts.tsv');
const TIMEOUT_MS = 15_000;
const CONCURRENCY = 6;

export const FACT_COLUMNS = [
  'url', 'ok', 'yoe', 'degree', 'clearance',
  'comp_low', 'comp_high', 'remote', 'hats', 'frameworks', 'fetched', 'location',
];

const hash = url => createHash('sha1').update(url).digest('hex');

// ---------------------------------------------------------------- extraction

export function stripHtml(html) {
  return String(html || '')
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(p|li|div|h\d|tr)>/gi, '\n')
    .replace(/<li[^>]*>/gi, '- ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&#39;|&rsquo;|&apos;/g, "'")
    .replace(/&quot;|&ldquo;|&rdquo;/g, '"').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&#43;/g, '+').replace(/&[a-z]+;/gi, ' ')
    .replace(/[ \t]+/g, ' ').replace(/\n{3,}/g, '\n\n')
    .trim();
}

/**
 * Hat detection. A hat fires on >= 2 DISTINCT signal terms from its class —
 * the same "two of three signal classes" convention Block G already uses, so
 * one stray mention of Figma in a benefits paragraph cannot manufacture a
 * designer role.
 */
const HATS = {
  designer: [
    /user research/i, /wireframe/i, /prototyp/i, /\bfigma\b/i, /usability/i,
    /design system/i, /\bwcag\b|section 508|accessib/i, /interaction design/i,
    /visual design/i, /journey map/i, /\bux\b|user experience/i, /design review/i,
  ],
  developer: [
    /\breact\b/i, /typescript/i, /javascript/i, /\bhtml\b|\bcss\b/i,
    /\brest\b|graphql|\bapi\b/i, /code review/i, /component library/i,
    /\bnode\.?js\b/i, /\bpython\b/i, /\bgit\b|version control/i,
    /front[- ]?end|full[- ]?stack/i, /ship (?:code|features)|write code|software development/i,
  ],
  ai_advocate: [
    /\bllm\b|large language model/i, /gen(?:erative )?ai\b/i, /forward[- ]deployed/i,
    /prompt engineer/i, /ai adoption|ai enablement|drive adoption/i,
    /customer demo|demo(?:ing)? to (?:customers|clients)/i, /evangeli[sz]/i,
    /\bagentic\b/i, /train(?:ing)? users|enablement/i, /machine learning/i,
  ],
};

// A hat fires on two distinct signal terms. The developer class needs one more
// rule: 'API' and 'Python' appear in every analytics req ever written, so two
// of those alone is not a building job. At least one term has to name the
// craft itself (a framework, the front end, shipping code).
const DEVELOPER_CORE = /\breact\b|typescript|javascript|\bhtml\b|\bcss\b|component library|\bnode\.?js\b|front[- ]?end|full[- ]?stack|code review|ship (?:code|features)|write code/i;

export function hatsIn(text) {
  const out = [];
  for (const [hat, terms] of Object.entries(HATS)) {
    if (terms.filter(re => re.test(text)).length < 2) continue;
    if (hat === 'developer' && !DEVELOPER_CORE.test(text)) continue;
    out.push(hat);
  }
  return out;
}

const FRAMEWORKS = {
  foundry: /palantir|\bfoundry\b/i,
  salesforce: /salesforce|\bapex\b.*\bvisualforce\b/i,
  servicenow: /servicenow|service now/i,
  power_platform: /power platform|power apps|powerapps|power automate/i,
};

/**
 * A framework counts only when it is the WORK, not a system the team happens to
 * own data in. The test is the title or the role summary — the opening ~800
 * characters — because a finance JD that syncs Salesforce into a warehouse
 * mentions Salesforce three times in its body and is not a Salesforce job.
 */
export function frameworksIn(text, title = '') {
  const head = `${title}\n${text.slice(0, 800)}`;
  return Object.entries(FRAMEWORKS).filter(([, re]) => re.test(head)).map(([k]) => k);
}

/**
 * Clearance. Order is load-bearing: "Top Secret" contains "Secret", so the
 * hard-stop tier must be tested first or every TS/SCI req reads as a bonus.
 */
export function clearanceIn(text) {
  // Two boilerplate blocks fire the naive patterns and must go first: the
  // Employee Polygraph Protection Act notice every federal contractor footer
  // carries, and prose uses of 'secret' or 'public trust' that name no clearance.
  const t = String(text || '').replace(/employee polygraph protection act|polygraph protection/gi, '');
  const TS = /\bts\s*\/\s*sci\b|top[- ]secret|\bsci\b(?!ence)|polygraph|\bpoly\b|special program access|\bsap\/par\b|\bpar\b access/i;
  const m = t.match(TS);
  if (m) {
    // 'Desired active Secret or Top-Secret clearance' is not a hard requirement;
    // treat a wished-for TS as the Secret tier so it scores instead of gating.
    const lead = t.slice(Math.max(0, m.index - 40), m.index);
    if (!/desired|preferred|nice to have|plus\b|bonus/i.test(lead)) return 'ts_sci';
  }
  // The Secret tier needs clearance context, not the bare word: 'secret
  // handling of customer data' and 'public trust is at risk' are not clearances.
  // 'Active Secret' is the one clearance phrasing that carries no context word,
  // because it is how titles say it: 'UI/UX Developer / Active Secret'.
  if (/\bactive\s+(?:dod\s+)?secret\b/i.test(t)) return 'secret';
  if (/security clearance|\bsecret\b[^.]{0,40}clearance|clearance[^.]{0,40}\bsecret\b|public trust[^.]{0,40}(?:clearance|position|investigation|level)|(?:clearance|investigation)[^.]{0,40}public trust|\bdod\b[^.]{0,20}clearance/i.test(t)) return 'secret';
  if (m) return 'secret';
  return 'none';
}

const DEGREE_NEAR = /(bachelor|\bb\.?s\.?\b|\bb\.?a\.?\b|master|\bm\.?s\.?\b|\bm\.?eng\b|ph\.?d|doctorate)/i;

function degreeClass(word = '') {
  const w = word.toLowerCase();
  if (/ph\.?d|doctor/.test(w)) return 'phd';
  if (/master|m\.?s|m\.?eng/.test(w)) return 'master';
  return 'bachelor';
}

/**
 * Years-of-experience branches. A defense JD reads "BS + 12 years OR MS + 10
 * OR PhD + 8" — taking the minimum across all of that would score the PhD
 * branch, which is not a branch this candidate can ever satisfy. So every
 * (degree, years) pair is captured and the caller picks the best branch it can
 * actually stand on.
 *
 * ponytail: window-based association, not a grammar. A JD that separates the
 * degree from its year count by more than ~90 characters lands in the
 * degree-less bucket, which is the conservative direction (no false gate).
 */
export function yoeBranches(text) {
  const out = [];
  const re = /(\d{1,2})\s*(?:\+|\s*or more|\s*-\s*\d{1,2}|\s*to\s*\d{1,2})?\s*(?:\+\s*)?years?/gi;
  let m;
  while ((m = re.exec(text))) {
    const years = Number(m[1]);
    if (!Number.isFinite(years) || years < 1 || years > 30) continue;
    // The NEAREST degree word to the left wins. "BS+14 OR MS+12 OR PhD+9"
    // puts three degree words in one window; taking the first would file the
    // PhD branch's 9 years under the bachelor's branch and gate the row on a
    // requirement it never carried.
    const window = text.slice(Math.max(0, m.index - 90), m.index);
    const deg = [...window.matchAll(new RegExp(DEGREE_NEAR, 'gi'))].pop();
    out.push({ degree: deg ? degreeClass(deg[1]) : 'none', years });
  }
  return out;
}

/** Lowest year count on a branch this candidate could stand on (BS today, MS if enrolled). */
export function yoeFloor(branches) {
  const usable = branches.filter(b => b.degree !== 'phd');
  if (!usable.length) return null;
  return Math.min(...usable.map(b => b.years));
}

export function degreeIn(text, branches = []) {
  const hasNonPhdBranch = branches.some(b => b.degree !== 'phd');
  const phd = /ph\.?d|doctorate/i.test(text);
  const bachelorOrLess = /bachelor|\bb\.?s\.?\b|\bb\.?a\.?\b|equivalent (?:practical )?experience|or equivalent/i.test(text);
  const master = /master'?s? (?:degree|of)|\bm\.?s\.?\b|\bm\.?eng\b/i.test(text);
  if (phd && !hasNonPhdBranch && !bachelorOrLess && !master) return 'phd';
  if (master && !bachelorOrLess) return 'master';
  return 'open';
}

/**
 * Advertised comp. Only annual USD figures are read; an hourly rate or a
 * bare "competitive salary" leaves both bounds null, and a null never gates.
 */
export function compIn(text) {
  const nums = [];
  const re = /\$\s?(\d{2,3})(?:,(\d{3})|\s?[kK])\b/g;
  let m;
  while ((m = re.exec(text))) {
    const n = m[2] ? Number(`${m[1]}${m[2]}`) : Number(m[1]) * 1000;
    if (n >= 40_000 && n <= 800_000) nums.push(n);
  }
  if (!nums.length) return { low: null, high: null };
  return { low: Math.min(...nums), high: Math.max(...nums) };
}

export function remoteIn(text) {
  if (/fully remote|100% remote|remote[- ](?:first|friendly|eligible)|work from anywhere|telework/i.test(text)) return 'remote';
  if (/hybrid/i.test(text)) return 'hybrid';
  if (/on[- ]?site|in[- ]?office|in the office \d|relocat/i.test(text)) return 'onsite';
  return '';
}

/** Reduce one description to the facts the scorer consumes. */
export function extractFacts(text, title = '') {
  const branches = yoeBranches(text);
  const comp = compIn(text);
  return {
    yoe: yoeFloor(branches),
    degree: degreeIn(text, branches),
    clearance: clearanceIn(text),
    comp_low: comp.low,
    comp_high: comp.high,
    remote: remoteIn(text),
    hats: hatsIn(text),
    frameworks: frameworksIn(text, title),
  };
}

// ------------------------------------------------------------------ fetching

/** Pull the description out of an ATS API payload, by vendor. */
function descFromApi(ats, json, parts) {
  if (ats === 'greenhouse') return json?.content || '';
  if (ats === 'lever') return [json?.descriptionPlain || json?.description || '',
    ...(json?.lists || []).map(l => `${l.text}\n${l.content}`)].join('\n');
  if (ats === 'workday') return json?.jobPostingInfo?.jobDescription || '';
  if (ats === 'ashby') {
    const job = (json?.jobs || []).find(j => String(j?.id).toLowerCase() === String(parts.jobId).toLowerCase());
    return job?.descriptionPlain || job?.descriptionHtml || '';
  }
  return '';
}

async function get(url, headers) {
  const c = new AbortController();
  const t = setTimeout(() => c.abort(), TIMEOUT_MS);
  try {
    return await fetch(url, { headers: { 'user-agent': DEFAULT_USER_AGENT, ...headers }, signal: c.signal });
  } finally {
    clearTimeout(t);
  }
}

/** ATS API first (structured, cheap); otherwise the public page, tags stripped. */
async function fetchJd(url) {
  const ats = resolveAtsApi(url);
  if (ats) {
    try {
      const res = await get(ats.apiUrl, { accept: 'application/json' });
      if (res.ok) {
        const text = stripHtml(descFromApi(ats.ats, await res.json(), ats.parts));
        if (text.length >= 300) return text;
      }
    } catch { /* fall through to the page */ }
  }
  const gh = greenhouseEmbed(url);
  if (gh) {
    try {
      const res = await get(gh, { accept: 'application/json' });
      if (res.ok) {
        const text = stripHtml((await res.json())?.content || '');
        if (text.length >= 300) return text;
      }
    } catch { /* fall through to the page */ }
  }
  try {
    const res = await get(url, { accept: 'text/html' });
    if (!res.ok) return '';
    const text = stripHtml(await res.text());
    return text.length >= 400 ? text : '';
  } catch {
    return '';
  }
}

// --------------------------------------------------------------- browser read

// A minority of postings never put the description in the HTML the fetch above
// receives. iCIMS renders it in a second frame; a few hydrate it client-side.
// A headless read is the only way to see those, so it runs as a second pass
// over the rows that came back empty — never as the first attempt, because it
// costs about a second per page against fifty milliseconds for a fetch.
//
// The guard matters more than the read: a retired posting still answers, with
// a generic "no longer available" page that is long enough to pass every
// length test and parses into confident nonsense. Only a 200 is a description.
const BROWSER_CONCURRENCY = 3;

/** Location from schema.org JSON-LD, else the "{Title} in {Place} | …" title. */
export function locationFromTitle(title = '') {
  const m = title.match(/\bin ([^|]+?)\s*\|/);
  return m ? m[1].trim() : '';
}

async function readPage(ctx, url) {
  const page = await ctx.newPage();
  try {
    const res = await page.goto(url, { waitUntil: 'networkidle', timeout: TIMEOUT_MS * 2 });
    if (!res || res.status() !== 200) return { text: '', location: '' };
    // The description can be in any frame; the longest one is it.
    let text = '';
    for (const f of page.frames()) {
      const t = stripHtml(await f.content().catch(() => ''));
      if (t.length > text.length) text = t;
    }
    const ld = await page.evaluate(() => {
      for (const s of document.querySelectorAll('script[type="application/ld+json"]')) {
        let j;
        try { j = JSON.parse(s.textContent); } catch { continue; }
        for (const o of [j, ...(j['@graph'] || [])]) {
          const jl = Array.isArray(o?.jobLocation) ? o.jobLocation[0] : o?.jobLocation;
          const a = jl?.address;
          if (a) return [a.addressLocality, a.addressRegion].filter(Boolean).join(', ');
        }
      }
      return '';
    }).catch(() => '');
    return {
      text: text.length >= 400 ? text : '',
      location: ld || locationFromTitle(await page.title().catch(() => '')),
    };
  } catch {
    return { text: '', location: '' };
  } finally {
    await page.close().catch(() => {});
  }
}

/** Read every url with a browser. Returns url -> { text, location }. */
export async function browserPass(urls, onEach = () => {}) {
  const out = new Map();
  if (!urls.length) return out;
  const { chromium } = await import('playwright');
  const browser = await chromium.launch();
  const ctx = await browser.newContext({ userAgent: DEFAULT_USER_AGENT });
  try {
    const queue = [...urls];
    await Promise.all(Array.from({ length: BROWSER_CONCURRENCY }, async () => {
      for (let url = queue.shift(); url; url = queue.shift()) {
        const r = await readPage(ctx, url);
        out.set(url, r);
        onEach(url, r);
      }
    }));
  } finally {
    await browser.close().catch(() => {});
  }
  return out;
}

// ------------------------------------------------------------------- runtime

function loadFacts() {
  if (!existsSync(FACTS)) return new Map();
  const lines = readFileSync(FACTS, 'utf-8').split(/\r?\n/).filter(Boolean);
  const cols = lines[0].split('\t');
  return new Map(lines.slice(1).map(l => {
    const c = l.split('\t');
    const row = Object.fromEntries(cols.map((k, i) => [k, c[i] ?? '']));
    return [row.url, row];
  }));
}

function writeFacts(map) {
  const out = [FACT_COLUMNS.join('\t')];
  for (const row of map.values()) out.push(FACT_COLUMNS.map(k => String(row[k] ?? '')).join('\t'));
  writeFileSync(FACTS, out.join('\n') + '\n');
}

async function main() {
  const argv = process.argv.slice(2);
  if (argv.includes('--self-test')) return selfTest();
  const refresh = argv.includes('--refresh');
  // --reparse re-runs extraction over what is already cached, with no network
  // at all. Every rule change below wants this, not a re-fetch.
  const reparse = argv.includes('--reparse');
  const limit = Number(argv[argv.indexOf('--limit') + 1]) || Infinity;
  // --stale re-reads postings whose facts were captured more than N days ago.
  // A posting can be edited after it is published — a comp range added, a
  // clearance line changed — and nothing else in this script ever re-reads one.
  const staleDays = argv.includes('--stale') ? Number(argv[argv.indexOf('--stale') + 1]) : null;
  const staleBefore = staleDays > 0
    ? new Date(Date.now() - staleDays * 86400000).toISOString().slice(0, 10)
    : null;

  mkdirSync(CACHE, { recursive: true });
  const facts = loadFacts();
  const rows = parsePendingRows(readFileSync(join(ROOT, 'data/pipeline.md'), 'utf-8'))
    .filter(r => /^https?:/.test(r.url || ''));
  const isStale = url => staleBefore && (facts.get(url)?.fetched || '') < staleBefore;
  // A row recorded ok=0 is never retried on its own — a posting that could not
  // be read once usually cannot be read again, and a retry costs a fetch every
  // run. --retry-unread is how a new reader (the browser pass) gets a shot at
  // the backlog it was written for.
  const retryUnread = argv.includes('--retry-unread');
  const todo = rows
    .filter(r => refresh || reparse || !facts.has(r.url) || isStale(r.url)
      || (retryUnread && facts.get(r.url)?.ok !== '1'))
    .slice(0, limit);
  const today = new Date().toISOString().slice(0, 10);
  let done = 0, ok = 0;

  const record = (r, text, location = '') => {
    const f = text ? extractFacts(text, r.title || '') : {};
    facts.set(r.url, {
      url: r.url,
      ok: text ? '1' : '0',
      yoe: f.yoe ?? '',
      degree: f.degree ?? '',
      clearance: f.clearance ?? '',
      comp_low: f.comp_low ?? '',
      comp_high: f.comp_high ?? '',
      remote: f.remote ?? '',
      hats: (f.hats || []).join(','),
      frameworks: (f.frameworks || []).join(','),
      fetched: today,
      // Only ever set by the browser pass — the fetch path never sees a
      // rendered page. The pipeline row's own location still wins downstream.
      location: location || facts.get(r.url)?.location || '',
    });
  };

  const queue = [...todo];
  await Promise.all(Array.from({ length: CONCURRENCY }, async () => {
    for (let r = queue.shift(); r; r = queue.shift()) {
      const file = join(CACHE, `${hash(r.url)}.txt`);
      let text = !refresh && !isStale(r.url) && existsSync(file) ? readFileSync(file, 'utf-8') : '';
      if (!text && !reparse) {
        text = await fetchJd(r.url);
        if (text) writeFileSync(file, text);
      }
      record(r, text);
      if (text) ok++;
      if (++done % 25 === 0) { writeFacts(facts); process.stderr.write(`${done}/${todo.length}\n`); }
    }
  }));

  writeFacts(facts);

  // Second pass: everything the fetch path could not read, read with a browser.
  // --reparse stays offline, so it never gets here.
  let browsed = 0, located = 0;
  const blind = reparse || argv.includes('--no-browser')
    ? []
    : todo.filter(r => facts.get(r.url)?.ok !== '1');
  if (blind.length) {
    process.stderr.write(`browser pass: ${blind.length} unread\n`);
    const byUrl = new Map(blind.map(r => [r.url, r]));
    await browserPass(blind.map(r => r.url), (url, { text, location }) => {
      if (text) { writeFileSync(join(CACHE, `${hash(url)}.txt`), text); browsed++; }
      if (location) located++;
      record(byUrl.get(url), text, location);
    });
    writeFacts(facts);
  }

  console.log(JSON.stringify({
    pending: rows.length, attempted: todo.length, fetched: ok,
    browser_attempted: blind.length, browser_read: browsed, locations: located,
    cached: readdirSync(CACHE).length, facts: facts.size,
  }, null, 1));
}

function selfTest() {
  const assert = (cond, msg) => { if (!cond) { console.error(`FAIL ${msg}`); process.exitCode = 1; } };
  const ngc = 'Must have a Bachelor’s degree in a STEM discipline and 14 or more years of experience OR a Master’s degree and 12 or more years OR a PhD in a STEM discipline and 9 years. Must have an active Secret clearance and eligibility for TS/SCI.';
  const b = yoeBranches(ngc);
  assert(b.some(x => x.degree === 'bachelor' && x.years === 14), 'BS branch');
  assert(b.some(x => x.degree === 'phd' && x.years === 9), 'PhD branch');
  assert(yoeFloor(b) === 12, `best satisfiable branch is MS+12, got ${yoeFloor(b)}`);
  assert(clearanceIn(ngc) === 'ts_sci', 'TS/SCI beats the bare Secret mention');
  assert(clearanceIn('Active Secret clearance required') === 'secret', 'plain Secret');
  assert(clearanceIn('No clearance needed') === 'none', 'no clearance');

  const ux = 'Own user research and wireframes, build the design system in Figma, ship React and TypeScript components, and drive AI adoption with LLM demos to customers.';
  const hats = hatsIn(ux);
  assert(hats.length === 3, `three hats, got ${hats.join(',')}`);
  assert(hatsIn('Manage the quarterly financial model in Excel and SQL.').length === 0, 'finance JD fires no hats');
  assert(hatsIn('We use Figma.').length === 0, 'one term is not a hat');

  assert(frameworksIn('experience with ServiceNow ITSM').includes('servicenow'), 'servicenow');
  assert(frameworksIn('x'.repeat(900) + ' we sync Salesforce into the warehouse').length === 0,
    'a framework named deep in the body is a data source, not the job');
  assert(frameworksIn('nothing here', 'Senior Salesforce Developer').includes('salesforce'), 'framework in the title');
  assert(degreeIn('PhD in Machine Learning required.', []) === 'phd', 'phd-only');
  assert(degreeIn('PhD or Bachelor’s with equivalent experience', []) === 'open', 'phd with a BS alternative');
  assert(compIn('The range is $120,000 - $185,000 per year.').high === 185000, 'comp high');
  assert(compIn('$95k to $130K').low === 95000, 'k-suffix comp');
  assert(compIn('Competitive salary and equity').low === null, 'no comp published');

  const B = ['coinbase', 'pinterest', 'dropbox'];
  assert(greenhouseEmbed('https://www.pinterestcareers.com/jobs/?gh_jid=7684636', B)
    === 'https://boards-api.greenhouse.io/v1/boards/pinterest/jobs/7684636', 'embedded Greenhouse board');
  assert(greenhouseEmbed('https://evil.example.com/x?gh_jid=1', B) === null, 'an unknown host resolves to no board');
  assert(greenhouseEmbed('https://www.coinbase.com/careers/positions/8?gh_jid=../x', B) === null, 'a non-numeric job id is refused');

  assert(locationFromTitle('UI/UX Developer / Active Secret in Scott AFB, Illinois | Careers at Peraton')
    === 'Scott AFB, Illinois', 'location out of an iCIMS page title');
  assert(locationFromTitle('Software Engineer') === '', 'a title with no location yields none');

  if (!process.exitCode) console.log('enrich-jd self-test OK');
}

if (process.argv[1] && process.argv[1].endsWith('enrich-jd.mjs')) await main();
