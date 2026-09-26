#!/usr/bin/env node
/**
 * resume-heat.mjs — zero-LLM keyword heat map: which terms the postings worth
 * reading demand, and whether cv.md already carries them.
 *
 * It reuses the dashboard's own match logic instead of a second opinion.
 * callback-score.mjs bands every pending posting; the hat signal terms in
 * enrich-jd.mjs are what put a posting in a band, and skill-extract.mjs names
 * the tools. Weighting each term by the band of every posting that uses it
 * (premier 3, strong 2, ordinary 1; low and gated postings count 0) ranks
 * terms by where the reachable roles are, not by raw frequency across the scrape.
 *
 * Each term gets one of three CV states:
 *   named    already in cv.md's Skills section
 *   shown    only in cv.md's prose — safe to name in Skills, in your own words
 *   missing  no trace in cv.md — add only if true; never auto-added
 *
 * Never writes to cv.md. Reads data/jd-cache (fill it with `node enrich-jd.mjs`).
 *
 *   node resume-heat.mjs                   corpus heat map (JSON)
 *   node resume-heat.mjs --summary         ranked tables
 *   node resume-heat.mjs --html            writes output/resume-heat.html
 *   node resume-heat.mjs --url <posting>   one cached posting against cv.md
 *   node resume-heat.mjs --jd <file>       one JD file against cv.md
 *   node resume-heat.mjs --top 40          rows per table (default 25)
 *   node resume-heat.mjs --cv <file>       read a draft instead of cv.md (before/after)
 *   node resume-heat.mjs --profile alex    profiles/alex: their pipeline, scoring, cv.md, output/
 *
 * --profile follows build-artifact's --root: the whole user layer moves, not
 * just the CV. Reading only CAREER_OPS_CV would score the owner's pipeline
 * against someone else's resume. The JD cache is keyed by posting URL, so it
 * stays shared.
 */
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { HATS, hatsIn } from './enrich-jd.mjs';
import { extractSkills } from './skill-extract.mjs';
import { splitSkillsSection } from './jd-skill-gap.mjs';
import { flagValue, hasFlag, safeIntFlag } from './lib/cli-flags.mjs';
import { isMainModule } from './lib/is-main-module.mjs';
import { profileDir } from './profiles.mjs';

const ROOT = dirname(fileURLToPath(import.meta.url));
export const BAND_WEIGHT = { premier: 3, strong: 2, ordinary: 1 };
const HAT_LABEL = { designer: 'designer', developer: 'developer', ai_advocate: 'AI advocate' };

// Widened to the whole word so the stem 'prototyp' reports as the JD's own
// 'prototyping'; the most common spelling across the corpus labels the term.
const HAT_TERMS = Object.entries(HATS).flatMap(([hat, res]) =>
  res.map((re, i) => ({ id: `${hat}#${i}`, hat, re: new RegExp(`(?:${re.source})[\\w.]*`, 'i') })));

/** Terms one posting uses: hat signal terms first, then named tools the hats don't already cover. */
export function termsIn(text) {
  const out = new Map();
  for (const t of HAT_TERMS) {
    const m = text.match(t.re);
    if (m) out.set(t.id, { hat: t.hat, spelling: m[0].toLowerCase() });
  }
  for (const skill of extractSkills(text)) {
    // Plural check: without it the hat term for "llm" lets the tool "LLMs" through as a second row.
    if (HAT_TERMS.some(t => t.re.test(skill) || t.re.test(skill.replace(/s$/, '')))) continue;
    out.set(`skill:${skill}`, { hat: null, spelling: skill });
  }
  return out;
}

function cvStatusFor(id, cv) {
  if (id.startsWith('skill:')) {
    const skill = id.slice(6);
    return cv.namedSkills.has(skill) ? 'named' : cv.proseSkills.has(skill) ? 'shown' : 'missing';
  }
  const { re } = HAT_TERMS.find(t => t.id === id);
  return re.test(cv.named) ? 'named' : re.test(cv.prose) ? 'shown' : 'missing';
}

export function readCv(cvText) {
  const { namedSkillsText, proseText } = splitSkillsSection(cvText);
  return {
    named: namedSkillsText, prose: proseText,
    namedSkills: extractSkills(namedSkillsText), proseSkills: extractSkills(proseText),
    hats: hatsIn(cvText),
  };
}

/**
 * @param {{text: string, band: string}[]} postings
 * @param {string} cvText
 */
export function heatMap(postings, cvText) {
  const cv = readCv(cvText);
  const reachable = postings.filter(p => BAND_WEIGHT[p.band]);
  const bands = Object.fromEntries(Object.keys(BAND_WEIGHT).map(b => [b, reachable.filter(p => p.band === b).length]));
  const terms = new Map();
  const hatDemand = Object.fromEntries(Object.keys(HATS).map(h => [h, 0]));
  for (const p of reachable) {
    for (const h of hatsIn(p.text)) hatDemand[h]++;
    for (const [id, { hat, spelling }] of termsIn(p.text)) {
      const t = terms.get(id) || { id, hat, spellings: new Map(), heat: 0, postings: 0, bands: { premier: 0, strong: 0, ordinary: 0 } };
      t.spellings.set(spelling, (t.spellings.get(spelling) || 0) + 1);
      t.heat += BAND_WEIGHT[p.band];
      t.postings++;
      t.bands[p.band]++;
      terms.set(id, t);
    }
  }
  const ranked = [...terms.values()].map(t => ({
    term: [...t.spellings].sort((a, b) => b[1] - a[1])[0][0],
    hat: t.hat, heat: t.heat, postings: t.postings,
    share: reachable.length ? Math.round(100 * t.postings / reachable.length) : 0,
    bands: t.bands, cv: cvStatusFor(t.id, cv),
  })).sort((a, b) => b.heat - a.heat || a.term.localeCompare(b.term));
  return {
    reachable: reachable.length, bands,
    hats: Object.keys(HATS).map(h => ({
      hat: HAT_LABEL[h], demandedBy: hatDemand[h],
      share: reachable.length ? Math.round(100 * hatDemand[h] / reachable.length) : 0,
      cvShows: cv.hats.includes(h),
    })),
    terms: ranked,
  };
}

/** One posting: every term it uses, with the CV state. */
export function postingTerms(text, cvText) {
  const cv = readCv(cvText);
  return [...termsIn(text)].map(([id, { hat, spelling }]) => ({ term: spelling, hat, cv: cvStatusFor(id, cv) }))
    .sort((a, b) => ['missing', 'shown', 'named'].indexOf(a.cv) - ['missing', 'shown', 'named'].indexOf(b.cv));
}

const cachePath = url => join(ROOT, 'data/jd-cache', `${createHash('sha1').update(url).digest('hex')}.txt`);

async function loadPostings(root) {
  const { buildModel } = await import('./build-artifact.mjs');
  return buildModel({ root }).rows
    .map(r => ({ url: r.u, company: r.c, title: r.t, score: r.cb, band: r.cbBand, path: cachePath(r.u) }))
    .filter(r => existsSync(r.path))
    .map(r => ({ ...r, text: readFileSync(r.path, 'utf8') }));
}

const hatTag = h => (h ? HAT_LABEL[h] : 'tool');

function printSummary(map, top) {
  const b = map.bands;
  console.log(`Resume heat: ${map.reachable} reachable postings (${b.premier} premier, ${b.strong} strong, ${b.ordinary} ordinary) against cv.md\n`);
  console.log('Hats the postings demand:');
  for (const h of map.hats) console.log(`  ${h.hat.padEnd(12)} ${String(h.share).padStart(3)}% of postings   cv.md ${h.cvShows ? 'demonstrates it' : 'does NOT demonstrate it'}`);
  const table = (title, rows) => {
    if (!rows.length) return;
    console.log(`\n${title}`);
    console.log('   heat  share  prem strong  ord  kind         term');
    for (const t of rows.slice(0, top)) {
      console.log(`  ${String(t.heat).padStart(5)}  ${String(t.share).padStart(4)}%  ${String(t.bands.premier).padStart(4)} ${String(t.bands.strong).padStart(6)} ${String(t.bands.ordinary).padStart(4)}  ${hatTag(t.hat).padEnd(12)} ${t.term}`);
    }
  };
  table('Name these in Skills (cv.md already shows them in prose):', map.terms.filter(t => t.cv === 'shown'));
  table('Gaps (no trace in cv.md; add only if true):', map.terms.filter(t => t.cv === 'missing'));
  table('Already named in Skills:', map.terms.filter(t => t.cv === 'named'));
}

const esc = s => String(s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);

function renderHtml(map, top) {
  const max = Object.fromEntries(Object.keys(BAND_WEIGHT).map(b => [b, Math.max(1, ...map.terms.map(t => t.bands[b]))]));
  const rows = map.terms.filter(t => t.cv !== 'named').slice(0, top).concat(map.terms.filter(t => t.cv === 'named').slice(0, Math.ceil(top / 3)));
  const cell = (t, b) => `<td style="--a:${(t.bands[b] / max[b]).toFixed(2)}">${t.bands[b] || ''}</td>`;
  const label = { shown: 'name in Skills', missing: 'gap: add only if true', named: 'covered' };
  return `<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Resume Heat Map</title>
<style>
:root{--bg:#F4F5F2;--ink:#1B201D;--muted:#5E6762;--rule:#D6DAD3;--heat:#C2410C;--shown:#1D6B8F;--missing:#A3302A;--named:#4B7A2C}
@media (prefers-color-scheme:dark){:root{--bg:#121513;--ink:#E3E7E2;--muted:#9AA39D;--rule:#2B312D;--heat:#F28B4B;--shown:#6BB6D8;--missing:#F0857D;--named:#9BCB78}}
body{background:var(--bg);color:var(--ink);font:14px/1.5 ui-sans-serif,system-ui,sans-serif;margin:0;padding:32px 16px}
main{max-width:980px;margin:0 auto}h1{font-size:26px;margin:0 0 6px}p{color:var(--muted);margin:0 0 16px;max-width:70ch}
.hats{display:flex;flex-wrap:wrap;gap:8px 24px;margin:0 0 20px;font-size:13px}.hats b{color:var(--ink)}
.scroll{overflow-x:auto}table{border-collapse:collapse;width:100%;font-variant-numeric:tabular-nums}
th,td{padding:5px 10px;border-bottom:1px solid var(--rule);text-align:left;white-space:nowrap}
th{font-size:11px;letter-spacing:.06em;text-transform:uppercase;color:var(--muted);font-weight:600}
td[style]{text-align:center;background:color-mix(in srgb,var(--heat) calc(var(--a)*70%),transparent)}
.chip{font-size:12px;padding:1px 8px;border-radius:9px;border:1px solid currentColor}
.shown{color:var(--shown)}.missing{color:var(--missing)}.named{color:var(--named)}.kind{color:var(--muted);font-size:12px}
</style><main>
<h1>Resume heat map</h1>
<p>${map.reachable} postings the dashboard scores Ordinary or better (${map.bands.premier} premier, ${map.bands.strong} strong, ${map.bands.ordinary} ordinary), read against cv.md. Heat weights a premier posting 3, strong 2, ordinary 1. Cells are posting counts, shaded within each band.</p>
<div class="hats">${map.hats.map(h => `<span><b>${esc(h.hat)}</b> demanded by ${h.share}%, ${h.cvShows ? 'cv.md demonstrates it' : '<span class="missing">cv.md does not demonstrate it</span>'}</span>`).join('')}</div>
<div class="scroll"><table><thead><tr><th>Term</th><th>Kind</th><th>Heat</th><th>Premier</th><th>Strong</th><th>Ordinary</th><th>cv.md</th></tr></thead><tbody>
${rows.map(t => `<tr><td>${esc(t.term)}</td><td class="kind">${hatTag(t.hat)}</td><td>${t.heat}</td>${cell(t, 'premier')}${cell(t, 'strong')}${cell(t, 'ordinary')}<td><span class="chip ${t.cv}">${label[t.cv]}</span></td></tr>`).join('\n')}
</tbody></table></div></main>`;
}

async function main(args) {
  const top = safeIntFlag(flagValue(args, '--top'), 25);
  const profile = flagValue(args, '--profile');
  const root = profile ? profileDir(profile) : ROOT;
  if (!existsSync(root)) {
    console.error(`No profile "${profile}". Create it with \`node profiles.mjs new ${profile}\`.`);
    process.exitCode = 1;
    return;
  }
  const cvText = readFileSync(flagValue(args, '--cv') || join(root, 'cv.md'), 'utf8');
  const url = flagValue(args, '--url'), jd = flagValue(args, '--jd');

  if (url || jd) {
    const path = jd || cachePath(url);
    if (!existsSync(path)) {
      console.error(jd ? `No such file: ${jd}` : 'That posting is not cached. Run `node enrich-jd.mjs` first.');
      process.exitCode = 1;
      return;
    }
    const terms = postingTerms(readFileSync(path, 'utf8'), cvText);
    if (!hasFlag(args, '--summary')) return console.log(JSON.stringify(terms, null, 2));
    for (const state of ['missing', 'shown', 'named']) {
      const list = terms.filter(t => t.cv === state).map(t => t.term);
      if (list.length) console.log(`${{ missing: 'Gaps (add only if true)', shown: 'Name in Skills', named: 'Covered' }[state]}: ${list.join(', ')}`);
    }
    return;
  }

  const postings = await loadPostings(root);
  if (!postings.length) {
    console.error('No cached descriptions. Run `node enrich-jd.mjs` first.');
    process.exitCode = 1;
    return;
  }
  const map = heatMap(postings, cvText);
  if (hasFlag(args, '--html')) {
    mkdirSync(join(root, 'output'), { recursive: true });
    const out = join(root, 'output/resume-heat.html');
    writeFileSync(out, renderHtml(map, top));
    console.log(`${out}: ${map.terms.length} terms across ${map.reachable} postings`);
  } else if (hasFlag(args, '--summary')) printSummary(map, top);
  else console.log(JSON.stringify(map, null, 2));
}

if (isMainModule(import.meta.url)) await main(process.argv.slice(2));
