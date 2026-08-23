#!/usr/bin/env node
/**
 * build-artifact.mjs — render the pending pipeline as one self-contained HTML page.
 *
 * THE PROBLEM
 * The published "Corridor Shortlist" artifact carried its 49 rows as a
 * hand-typed `const D = [...]` array. Every scan drifted it, and refreshing it
 * meant retyping the data. A snapshot that cannot be regenerated is a
 * transcript, not a view.
 *
 * WHAT THIS DOES
 * Reads the files that already are the source of truth — data/pipeline.md,
 * config/lanes.yml, data/scan-history.tsv, data/applications.md,
 * data/expired-jobs.md, data/discard.log, portals.yml — and emits a single
 * HTML file with the rows embedded as JSON. No network, no dependencies beyond
 * what the repo already installs, nothing written outside the output path.
 *
 * The parsing is not reimplemented here: rows come from swarm.mjs
 * (parsePendingRows/classifyRows), lanes from lanes.mjs, keyword matching from
 * scan.mjs. This file is a renderer.
 *
 *   node build-artifact.mjs --out page.html
 */
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import yaml from 'js-yaml';
import { parsePendingRows, classifyRows } from './swarm.mjs';
import { loadLanes, LANES_PATH } from './lanes.mjs';
import { matchedTitleKeywords, buildTitleFilter } from './scan.mjs';
import { buildScorer, calibrate, SIGNALS, BANDS } from './callback-score.mjs';

const ROOT = dirname(fileURLToPath(import.meta.url));

// Corridor segments. The location strings come from 83 different ATS vendors,
// so this is a best-effort bucketing — the "other" bucket is displayed rather
// than hidden, because on live data it is the second largest one.
const SEGMENTS = [
  ['San Diego', /san diego|la jolla|carlsbad|escondido|oceanside/i],
  ['OC / LA', /irvine|costa mesa|newport|anaheim|los angeles|santa monica|el segundo|culver|pasadena|burbank|long beach|torrance|redlands/i],
  ['Central Coast', /ventura|thousand oaks|santa barbara|goleta|san luis obispo|monterey|santa cruz/i],
  ['Bay Area', /san francisco|san jose|bay area|palo alto|mountain view|sunnyvale|santa clara|menlo|cupertino|redwood city|san mateo|foster city|fremont|milpitas|oakland|berkeley|emeryville/i],
  ['Remote', /remote|telework|anywhere|distributed/i],
];

export function segmentFor(location) {
  for (const [name, re] of SEGMENTS) if (re.test(location || '')) return name;
  return 'Other / unknown';
}

/**
 * Freshness bands derived from portals.yml rather than hardcoded. The old
 * artifact's 14/45/120/365 bands contradicted `max_posting_age_days: 45` —
 * they described ages the scanner is configured never to admit.
 */
export function freshnessBands(maxAgeDays) {
  const cut = [7, 14, 30, maxAgeDays].filter((n, i, a) => n > 0 && a.indexOf(n) === i).sort((a, b) => a - b);
  const bands = [];
  let prev = 0;
  for (const c of cut) {
    bands.push({ id: `≤${c}d`, max: c, label: prev === 0 ? `${c} days or less` : `${prev + 1} to ${c} days` });
    prev = c;
  }
  bands.push({ id: `${prev + 1}d+`, max: Infinity, label: `Over ${prev} days — past the scan window` });
  return bands;
}

export function bandFor(age, bands) {
  if (age === null || age === undefined) return 'unknown';
  for (const b of bands) if (age <= b.max) return b.id;
  return bands[bands.length - 1].id;
}

function readIf(path) {
  return existsSync(path) ? readFileSync(path, 'utf-8') : '';
}

/** scan-history.tsv, indexed by URL — the only place posted_at and trust live. */
function loadHistory(root) {
  const text = readIf(join(root, 'data/scan-history.tsv'));
  if (!text) return { byUrl: new Map(), added: [] };
  const lines = text.split(/\r?\n/).filter(Boolean);
  const cols = lines[0].split('\t');
  const idx = Object.fromEntries(cols.map((c, i) => [c, i]));
  const byUrl = new Map();
  const added = [];
  for (const line of lines.slice(1)) {
    const c = line.split('\t');
    const row = {
      url: c[idx.url],
      title: c[idx.title] || '',
      company: c[idx.company] || '',
      posted: c[idx.posted_at] || '',
      trust: c[idx.trust_score] || '',
      flags: c[idx.trust_flags] || '',
      status: c[idx.status] || '',
      portal: c[idx.portal] || '',
    };
    if (row.url) byUrl.set(row.url, row);
    if (row.status === 'added' && row.title) added.push(row);
  }
  return { byUrl, added };
}

/**
 * Applications tracker has no URL column, so a row is matched on company+role.
 * Today the tracker is empty and every posting reads `pending`; the column is
 * built now so scores render in place the moment evaluations start landing.
 */
function loadApplications(root) {
  const text = readIf(join(root, 'data/applications.md'));
  const byKey = new Map();
  for (const line of text.split(/\r?\n/)) {
    if (!line.startsWith('|') || /^\|\s*[-#]/.test(line)) continue;
    const cells = line.split('|').map(s => s.trim());
    const [, , , company, role, score, status] = cells;
    if (!company || company === 'Company') continue;
    byKey.set(`${company}|${role}`.toLowerCase(), { score, status });
  }
  return byKey;
}

function loadExpired(root) {
  const text = readIf(join(root, 'data/expired-jobs.md'));
  const count = Number(text.match(/_(\d+) postings? recorded\._/)?.[1] || 0);
  const rows = text.split(/\r?\n/)
    .filter(l => l.startsWith('| 20'))
    .map(l => l.split('|').map(s => s.trim()))
    .map(c => ({ removed: c[1], company: c[2], title: c[3], evidence: c[6] }));
  return { count, rows };
}

function loadDiscards(root) {
  return readIf(join(root, 'data/discard.log')).split(/\r?\n/).filter(Boolean).map(l => {
    const [ts, url, reason] = l.split('\t');
    return { ts, url, reason };
  });
}

/**
 * Keyword yield: for each title_filter.positive, how many postings the scanner
 * ever added on it, how many ONLY it caught, and how many are pending now.
 * `unique` is the number that matters — a keyword with zero unique hits can be
 * deleted without losing a single posting.
 */
export function keywordYield(positives, addedRows, pendingRows) {
  const filter = { positive: positives };
  const stats = new Map(positives.map(k => [k, { keyword: k, added: 0, unique: 0, pending: 0, sample: '' }]));
  for (const row of addedRows) {
    const hits = matchedTitleKeywords(row.title, filter);
    for (const h of hits) {
      const s = stats.get(h);
      if (!s) continue;
      s.added++;
      if (hits.length === 1) {
        s.unique++;
        if (!s.sample) s.sample = row.title;
      }
    }
  }
  for (const row of pendingRows) {
    for (const h of matchedTitleKeywords(row.title || '', filter)) stats.get(h) && stats.get(h).pending++;
  }
  return [...stats.values()].sort((a, b) => a.unique - b.unique || a.added - b.added);
}

export function buildModel({ root = ROOT, now = new Date() } = {}) {
  const portals = yaml.load(readFileSync(join(root, 'portals.yml'), 'utf-8')) || {};
  const positives = portals.title_filter?.positive || [];
  const maxAge = portals.max_posting_age_days || 45;
  const bands = freshnessBands(maxAge);
  // LANES_PATH is already absolute (or an explicit env override); joining it
  // onto root would produce a path that never resolves and silently classify
  // every posting as `core`.
  const lanes = loadLanes(root === ROOT ? LANES_PATH : join(root, 'config', 'lanes.yml'));
  const history = loadHistory(root);
  const apps = loadApplications(root);
  const titleFilter = { positive: positives };

  const pipelineText = readFileSync(join(root, 'data/pipeline.md'), 'utf-8');
  const parsed = classifyRows(parsePendingRows(pipelineText), lanes);
  const today = new Date(now.toISOString().slice(0, 10) + 'T00:00:00Z');

  const rows = parsed.map(r => {
    const h = history.byUrl.get(r.url);
    // The pipeline row wins; scan-history backfills the 20% with no posted date.
    const posted = r.posted || h?.posted?.slice(0, 10) || null;
    const age = posted ? Math.round((today - new Date(posted + 'T00:00:00Z')) / 864e5) : null;
    const app = apps.get(`${r.company}|${r.title}`.toLowerCase());
    return {
      u: r.url,
      c: r.company || '—',
      t: r.title || '—',
      l: r.location || '',
      seg: segmentFor(r.location),
      p: posted,
      age,
      band: bandFor(age, bands),
      lane: r.lane,
      kw: r.laneKeywords || [],
      all: matchedTitleKeywords(r.title || '', titleFilter),
      trust: h?.trust ? Number(h.trust) : null,
      flags: h?.flags || '',
      portal: h?.portal || '',
      status: app ? (app.status || 'evaluated') : 'pending',
      score: app?.score ? Number(app.score) : null,
    };
  });

  // Response-likelihood prior. Runs after rows exist because two of its
  // signals — how many reqs a company has open, how often a company+title pair
  // has been seen — are properties of the pipeline, not of a single row.
  const profile = existsSync(join(root, 'config/profile.yml'))
    ? yaml.load(readFileSync(join(root, 'config/profile.yml'), 'utf-8')) || {}
    : {};
  const scoreRow = buildScorer({ profile, lanes, rows, history: history.added });
  for (const r of rows) {
    const s = scoreRow(r);
    r.cb = s.score;
    r.cbBand = s.band;
    r.why = s.signals;
  }

  const laneMeta = [
    ...lanes.map(l => ({ id: l.id, label: l.archetype, max: l.max_evaluations ?? null })),
    { id: 'core', label: 'Core targeting (AI / front-end / forward-deployed)', max: null },
  ];

  const dead = positives.filter(k => !keywordCount(k, rows));
  // No provider in this config has ever written a trust score, so the column
  // would render as 547 dashes. It appears only once the data exists.
  const hasTrust = rows.some(r => r.trust !== null);
  return {
    generated: now.toISOString().slice(0, 10),
    hasTrust,
    maxAge,
    bands,
    lanes: laneMeta,
    rows,
    segments: [...SEGMENTS.map(s => s[0]), 'Other / unknown'],
    yields: keywordYield(positives, history.added, rows),
    dead,
    expired: loadExpired(root),
    discards: loadDiscards(root),
    processed: (pipelineText.match(/^- \[x\] /gm) || []).length,
    historyAdded: history.added.length,
    signals: SIGNALS,
    cbBands: BANDS.map(b => ({ id: b.id, label: b.label, min: b.min === -Infinity ? 0 : b.min })),
    calibration: calibrate(rows),
  };
}

function keywordCount(kw, rows) {
  return rows.some(r => r.all.includes(kw));
}

const esc = s => String(s ?? '').replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

export function renderHtml(model) {
  const data = JSON.stringify(model).replace(/</g, '\\u003c');
  return `<title>Corridor Pipeline</title>
<style>
:root{
  --ground:#e9edee; --surface:#f7f9f9; --surface-2:#dfe6e7;
  --line:#c2cdcf; --line-soft:#d6dedf;
  --text:#12242c; --text-2:#4a6068; --text-3:#74898f;
  --accent:#0f6f6b; --accent-soft:#0f6f6b1a;
  --devrel:#7a4fb0; --tcsm:#0f6f6b; --gtm:#a06a1f; --core:#4a6068;
  --fresh:#2c7a51; --recent:#3f7f6d; --aging:#9a7420; --stale:#a04f2a; --none:#8b8b8b;
  --shadow:0 1px 2px #12242c14, 0 8px 24px #12242c0f;
}
@media (prefers-color-scheme: dark){
  :root:not([data-theme="light"]){
    --ground:#0c1a21; --surface:#122630; --surface-2:#193440;
    --line:#28454f; --line-soft:#1e3a44;
    --text:#e2ecee; --text-2:#9db4bb; --text-3:#718b93;
    --accent:#4fc9be; --accent-soft:#4fc9be1f;
    --devrel:#b78ee6; --tcsm:#4fc9be; --gtm:#d3a63f; --core:#9db4bb;
    --fresh:#54c98a; --recent:#5cbba6; --aging:#d3a63f; --stale:#e0824f; --none:#7e909a;
    --shadow:0 1px 2px #0006, 0 10px 28px #0004;
  }
}
:root[data-theme="dark"]{
  --ground:#0c1a21; --surface:#122630; --surface-2:#193440;
  --line:#28454f; --line-soft:#1e3a44;
  --text:#e2ecee; --text-2:#9db4bb; --text-3:#718b93;
  --accent:#4fc9be; --accent-soft:#4fc9be1f;
  --devrel:#b78ee6; --tcsm:#4fc9be; --gtm:#d3a63f; --core:#9db4bb;
  --fresh:#54c98a; --recent:#5cbba6; --aging:#d3a63f; --stale:#e0824f; --none:#7e909a;
  --shadow:0 1px 2px #0006, 0 10px 28px #0004;
}
*{box-sizing:border-box}
body{margin:0;background:var(--ground);color:var(--text);
  font-family:"Iowan Old Style","Palatino Linotype",Palatino,Georgia,serif;
  font-size:15px;line-height:1.55;-webkit-font-smoothing:antialiased}
h1,h2,th,.ui{font-family:"Segoe UI",-apple-system,BlinkMacSystemFont,"Helvetica Neue",Arial,sans-serif}
.mono,.eyebrow,.glab,.n,.kw,.fl{font-family:"Cascadia Mono",Consolas,"SF Mono",ui-monospace,monospace}
.wrap{max-width:1320px;margin:0 auto;padding:32px 24px 72px}
header{display:flex;flex-direction:column;gap:6px}
.eyebrow{font-size:11px;letter-spacing:.16em;text-transform:uppercase;color:var(--accent)}
h1{font-size:clamp(28px,4.4vw,42px);line-height:1.05;margin:0;letter-spacing:-.022em;font-weight:650}
.sub{color:var(--text-2);max-width:70ch;margin:2px 0 0}
.stats{display:grid;grid-template-columns:repeat(auto-fit,minmax(132px,1fr));gap:1px;
  background:var(--line-soft);border:1px solid var(--line);border-radius:3px;overflow:hidden;margin:26px 0 20px}
.stat{background:var(--surface);padding:13px 15px;display:flex;flex-direction:column;gap:3px}
.stat b{font-family:"Segoe UI",sans-serif;font-size:26px;font-weight:640;line-height:1;
  font-variant-numeric:tabular-nums;letter-spacing:-.02em}
.stat span{font-family:"Cascadia Mono",Consolas,ui-monospace,monospace;font-size:10px;
  letter-spacing:.11em;text-transform:uppercase;color:var(--text-3)}
.bar{display:flex;flex-wrap:wrap;gap:18px 26px;align-items:flex-end;margin-bottom:14px}
.group{display:flex;flex-direction:column;gap:7px}
.glab{font-size:10px;letter-spacing:.13em;text-transform:uppercase;color:var(--text-3)}
.chips{display:flex;flex-wrap:wrap;gap:6px}
.chip{font-family:"Segoe UI",sans-serif;font-size:12.5px;padding:5px 11px;border:1px solid var(--line);
  border-radius:2px;background:var(--surface);color:var(--text-2);cursor:pointer;
  transition:background .13s,color .13s,border-color .13s}
.chip:hover{border-color:var(--accent);color:var(--text)}
.chip[aria-pressed="true"]{background:var(--accent);border-color:var(--accent);color:var(--ground);font-weight:600}
.chip .n{font-size:11px;opacity:.72;margin-left:5px}
.chip.lane[aria-pressed="true"]{background:var(--lc);border-color:var(--lc)}
.chip.lane i{display:inline-block;width:8px;height:8px;border-radius:50%;background:var(--lc);margin-right:6px;vertical-align:baseline}
.chip:focus-visible,select:focus-visible,input:focus-visible,a:focus-visible,summary:focus-visible{
  outline:2px solid var(--accent);outline-offset:2px}
select,input{font-family:"Segoe UI",sans-serif;font-size:13px;padding:6px 9px;border:1px solid var(--line);
  border-radius:2px;background:var(--surface);color:var(--text)}
input[type=search]{min-width:230px}
.tablewrap{overflow-x:auto;border:1px solid var(--line);border-radius:3px;background:var(--surface);box-shadow:var(--shadow)}
table{border-collapse:collapse;width:100%;min-width:1020px}
thead th{position:sticky;top:0;z-index:2;background:var(--surface-2);font-size:10px;letter-spacing:.12em;
  text-transform:uppercase;font-weight:650;color:var(--text-2);text-align:left;padding:10px 12px;
  border-bottom:1px solid var(--line);white-space:nowrap}
th.sortable{cursor:pointer;user-select:none}
th.sortable:hover{color:var(--accent)}
th .car{opacity:.45;font-size:9px;margin-left:3px}
th[aria-sort] .car{opacity:1;color:var(--accent)}
tbody td{padding:10px 12px;border-bottom:1px solid var(--line-soft);vertical-align:top}
tbody tr:hover{background:var(--accent-soft)}
td.stripe{border-left:3px solid var(--lc,var(--line))}
tr[data-lane=devrel]{--lc:var(--devrel)} tr[data-lane=tcsm]{--lc:var(--tcsm)}
tr[data-lane=gtm]{--lc:var(--gtm)} tr[data-lane=core]{--lc:var(--core)}
.co{font-family:"Segoe UI",sans-serif;font-weight:640;font-size:13.5px}
.role a{color:var(--text);text-decoration:none;border-bottom:1px solid var(--line)}
.role a:hover{color:var(--accent);border-bottom-color:var(--accent)}
.loc{font-size:12px;color:var(--text-3);margin-top:2px}
.kw{display:inline-block;font-size:10px;letter-spacing:.04em;padding:2px 6px;margin:0 4px 3px 0;
  border:1px solid var(--line);border-radius:2px;color:var(--text-2);white-space:nowrap}
.lanetag{display:inline-block;font-family:"Segoe UI",sans-serif;font-size:10px;font-weight:680;
  letter-spacing:.09em;text-transform:uppercase;padding:3px 7px;border-radius:2px;
  border:1px solid currentColor;color:var(--lc);white-space:nowrap}
.st{font-family:"Segoe UI",sans-serif;font-size:11px;font-weight:650;letter-spacing:.06em;text-transform:uppercase;color:var(--text-3)}
.score{font-size:15px;font-weight:650;font-variant-numeric:tabular-nums;font-family:"Segoe UI",sans-serif}
.age{font-variant-numeric:tabular-nums;font-size:13px;white-space:nowrap}
.agebar{height:3px;border-radius:2px;background:var(--line);margin-top:5px;width:70px;overflow:hidden}
.agebar i{display:block;height:100%}
.fl{display:block;font-size:9.5px;letter-spacing:.09em;margin-top:4px;color:var(--text-3)}
.trust{font-variant-numeric:tabular-nums;font-size:13px}
.cb{font-family:"Segoe UI",sans-serif;font-size:19px;font-weight:660;font-variant-numeric:tabular-nums;
  line-height:1;letter-spacing:-.02em;color:var(--bc)}
.cbband{display:block;font-family:"Cascadia Mono",Consolas,ui-monospace,monospace;font-size:9.5px;
  letter-spacing:.09em;text-transform:uppercase;color:var(--text-3);margin-top:4px;white-space:nowrap}
.cbbar{height:3px;border-radius:2px;background:var(--line);margin-top:5px;width:64px;overflow:hidden}
.cbbar i{display:block;height:100%;background:var(--bc)}
tr[data-cb=strong]{--bc:var(--fresh)} tr[data-cb=likely]{--bc:var(--recent)}
tr[data-cb=even]{--bc:var(--aging)} tr[data-cb=low]{--bc:var(--none)}
.wh{margin:0;padding:0;list-style:none;font-size:12px}
.wh li{display:flex;justify-content:space-between;gap:12px;padding:2px 0;border-bottom:1px solid var(--line-soft)}
.wh b{font-variant-numeric:tabular-nums;font-family:"Cascadia Mono",Consolas,ui-monospace,monospace;font-weight:600}
.wh .up{color:var(--fresh)} .wh .dn{color:var(--stale)}
.empty{padding:48px 20px;text-align:center;color:var(--text-3)}
details{margin-top:26px;border:1px solid var(--line);border-radius:3px;background:var(--surface)}
summary{cursor:pointer;padding:13px 16px;font-family:"Segoe UI",sans-serif;font-weight:640;font-size:14px}
details .body{padding:0 16px 18px;border-top:1px solid var(--line-soft)}
details h3{font-family:"Segoe UI",sans-serif;font-size:12px;letter-spacing:.1em;text-transform:uppercase;
  color:var(--text-3);margin:18px 0 8px}
.mini{width:100%;border-collapse:collapse;font-size:13px}
.mini th{text-align:left;font-size:10px;letter-spacing:.1em;text-transform:uppercase;color:var(--text-3);
  padding:6px 8px;border-bottom:1px solid var(--line)}
.mini td{padding:5px 8px;border-bottom:1px solid var(--line-soft);vertical-align:top}
.mini td.num{font-variant-numeric:tabular-nums;text-align:right;width:70px}
.zero td{color:var(--stale)}
footer{margin-top:26px;color:var(--text-3);font-size:12.5px;max-width:78ch}
footer b{color:var(--text-2);font-weight:600}
@media (prefers-reduced-motion:reduce){*{transition:none!important}}
</style>

<div class="wrap">
<header>
  <div class="eyebrow" id="eyebrow"></div>
  <h1>Corridor Pipeline</h1>
  <p class="sub">Every pending posting the scanner has surfaced, classified into role families by the same
  keyword mechanism that admitted it. Generated from <span class="mono">data/pipeline.md</span> — rebuild with
  <span class="mono">node build-artifact.mjs</span>, never by hand.</p>
</header>

<div class="stats" id="stats"></div>

<div class="bar">
  <div class="group"><div class="glab">Role family</div><div class="chips" id="lanes"></div></div>
  <div class="group"><div class="glab">Reply odds</div><div class="chips" id="cbbands"></div></div>
  <div class="group"><div class="glab">Corridor segment</div><div class="chips" id="segs"></div></div>
  <div class="group"><div class="glab">Posting age</div><select id="fsel"></select></div>
  <div class="group"><div class="glab">Company</div>
    <input list="colist" id="co" placeholder="Any company" aria-label="Filter by company"><datalist id="colist"></datalist></div>
  <div class="group"><div class="glab">Search</div>
    <input type="search" id="q" placeholder="Company, role, keyword" aria-label="Search postings"></div>
</div>

<div class="tablewrap">
<table>
  <thead><tr>
    <th class="sortable" data-k="cb" style="padding-left:15px">Reply odds<span class="car">▼</span></th>
    <th class="sortable" data-k="status">Status<span class="car">▼</span></th>
    <th class="sortable" data-k="company">Company &amp; role<span class="car">▼</span></th>
    <th class="sortable" data-k="lane">Family &amp; keyword<span class="car">▼</span></th>
    <th class="sortable" data-k="age">Age<span class="car">▲</span></th>
    <th class="sortable" data-k="seg">Segment<span class="car">▼</span></th>
    <th class="sortable" data-k="trust" id="thtrust">Trust<span class="car">▼</span></th>
  </tr></thead>
  <tbody id="rows"></tbody>
</table>
</div>
<div class="empty" id="empty" hidden>No postings match those filters.</div>
<div class="empty" id="more" hidden></div>

<details id="cfg">
  <summary>Scanner configuration — keyword yield, removals, retired postings</summary>
  <div class="body" id="cfgbody"></div>
</details>

<footer>
  <p><b>What reply odds are.</b> An estimate, out of 100, that this posting produces a recruiter reply or
  interview email — not a fit score, and not a rejection verdict. Fit is scored separately and downstream by
  the A–G rubric. Every posting stays visible, linked and applicable at any number; a low one means the
  evidence is thin, and on this pipeline the most common reason is that the board published no date. Hover
  any score to see every signal that moved it and by how much.</p>
  <p><b>It is a prior, not a prediction.</b> The weights are hand-set from published matching behaviour, not
  trained on outcomes. They stay honest only once <span class="mono">data/applications.md</span> carries
  replies — the panel below reports the observed reply rate per band as soon as there is one.</p>
  <p><b>No protected characteristic is an input</b>, and none is inferable from one. The score reads title,
  matched keywords, role family, posting age, location bucket, employer posting volume, repost pattern and
  provider trust. Location is used as a proxy for how many people are competing for the req, never as a
  statement about any applicant.</p>
  <p><b>What the family column means.</b> A posting enters the pipeline because its title matched a
  <span class="mono">title_filter.positive</span> keyword in <span class="mono">portals.yml</span>. The same
  matched keyword — shown as written — is what assigns the role family, so the column below is both the
  classification and the audit trail for why the row is here at all.</p>
  <p><b>What status is not telling you yet.</b> Evaluation runs downstream of this page. Until a posting is
  scored, it reads <span class="mono">pending</span> and carries no score; the column fills in from
  <span class="mono">data/applications.md</span> as evaluations land.</p>
  <p><b>Ages are upper bounds.</b> A missing posted date means the vendor's list payload shipped none, not
  that the posting is new. Those rows sort last under an age sort and are filterable as
  <span class="mono">unknown</span>.</p>
</footer>
</div>

<script>
const M = ${data};
const LC = {devrel:'var(--devrel)',tcsm:'var(--tcsm)',gtm:'var(--gtm)',core:'var(--core)'};
const PAGE = 200;
const el = id => document.getElementById(id);
const esc = s => String(s ?? '').replace(/[&<>"]/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c]));
const rows = M.rows;

el('eyebrow').textContent =
  \`Generated \${M.generated} · \${rows.length} pending · \${new Set(rows.map(r=>r.c)).size} companies · scan window \${M.maxAge}d\`;

const dated = rows.filter(r => r.age !== null).map(r => r.age).sort((a,b)=>a-b);
el('stats').innerHTML = [
  [rows.length, 'Pending'],
  [rows.filter(r=>r.cbBand==='strong'||r.cbBand==='likely').length, 'Reply odds ≥58'],
  [rows.filter(r=>r.lane!=='core').length, 'In a role family'],
  [rows.filter(r=>r.age!==null&&r.age<=14).length, 'Fresh ≤14d'],
  [rows.filter(r=>r.age===null).length, 'No posted date'],
  [dated.length ? dated[Math.floor(dated.length/2)]+'d' : '—', 'Median age'],
  [M.expired.count, 'Retired'],
].map(([n,l])=>\`<div class="stat"><b>\${n}</b><span>\${l}</span></div>\`).join('');

// ---- controls --------------------------------------------------------
const state = {lane:null, seg:null, cbband:null, band:'', co:'', q:''};
let limit = PAGE;

el('lanes').innerHTML = M.lanes.map(l => {
  const n = rows.filter(r=>r.lane===l.id).length;
  return \`<button class="chip lane" style="--lc:\${LC[l.id]||'var(--core)'}" data-lane="\${l.id}" aria-pressed="false" title="\${esc(l.label)}"><i></i>\${l.id}<span class="n">\${n}</span></button>\`;
}).join('');
el('cbbands').innerHTML = M.cbBands.map(b => {
  const n = rows.filter(r=>r.cbBand===b.id).length;
  return n ? \`<button class="chip" data-cbband="\${b.id}" aria-pressed="false">\${esc(b.label)}<span class="n">\${n}</span></button>\` : '';
}).join('');
el('segs').innerHTML = M.segments.map(s => {
  const n = rows.filter(r=>r.seg===s).length;
  return n ? \`<button class="chip" data-seg="\${esc(s)}" aria-pressed="false">\${esc(s)}<span class="n">\${n}</span></button>\` : '';
}).join('');
el('fsel').innerHTML = ['<option value="">Any age</option>']
  .concat(M.bands.map(b=>\`<option value="\${b.id}">\${b.id} — \${b.label}</option>\`))
  .concat([\`<option value="unknown">unknown — board published no date (\${rows.filter(r=>r.age===null).length})</option>\`]).join('');
el('colist').innerHTML = [...new Set(rows.map(r=>r.c))].sort()
  .map(c=>\`<option value="\${esc(c)}">\`).join('');

if (!M.hasTrust) el('thtrust').remove();

let sortKey = 'cb', sortDir = 1;

function ageBar(age){
  if (age === null) return 0;
  return Math.min(100, Math.round(Math.log10(Math.max(age,1)+1)/Math.log10(400)*100));
}
const SIGLAB = Object.fromEntries(M.signals.map(s=>[s.id,s.label]));
const bandLabel = id => (M.cbBands.find(b=>b.id===id)||{}).label || id;
function whyText(r){
  return 'Reply odds ' + r.cb + '/100 — ' + bandLabel(r.cbBand) + '\\n'
    + (r.why||[]).map(w=>\`\${w.delta>0?'+':''}\${w.delta}  \${SIGLAB[w.id]||w.id}: \${w.why}\`).join('\\n')
    + '\\n\\nPrior, not a verdict. Every posting stays applicable.';
}
function bandColor(band){
  if (band === 'unknown') return 'var(--none)';
  const i = M.bands.findIndex(b=>b.id===band);
  return ['var(--fresh)','var(--recent)','var(--aging)','var(--stale)'][i] || 'var(--stale)';
}

function render(){
  const f = rows.filter(r =>
    (!state.lane || r.lane === state.lane) &&
    (!state.seg  || r.seg === state.seg) &&
    (!state.cbband || r.cbBand === state.cbband) &&
    (!state.band || (state.band === 'unknown' ? r.age === null : r.band === state.band)) &&
    (!state.co   || r.c.toLowerCase() === state.co) &&
    (!state.q    || (r.c+' '+r.t+' '+r.l+' '+r.all.join(' ')).toLowerCase().includes(state.q))
  );
  f.sort((a,b)=>{
    let x;
    if (sortKey === 'cb') x = b.cb - a.cb || (a.age ?? 1e9) - (b.age ?? 1e9);
    else if (sortKey === 'age') x = (a.age ?? 1e9) - (b.age ?? 1e9);
    else if (sortKey === 'trust') x = (b.trust ?? -1) - (a.trust ?? -1);
    else if (sortKey === 'status') x = (b.score ?? -1) - (a.score ?? -1) || a.status.localeCompare(b.status);
    else if (sortKey === 'company') x = a.c.localeCompare(b.c) || a.t.localeCompare(b.t);
    else if (sortKey === 'lane') x = a.lane.localeCompare(b.lane) || (a.age ?? 1e9) - (b.age ?? 1e9);
    else x = a.seg.localeCompare(b.seg);
    return x * sortDir;
  });
  el('empty').hidden = f.length > 0;
  const shown = f.slice(0, limit);
  el('rows').innerHTML = shown.map(r => \`<tr data-lane="\${r.lane}" data-cb="\${r.cbBand}">
    <td class="stripe" style="padding-left:12px" title="\${esc(whyText(r))}">
      <span class="cb">\${r.cb}</span>
      <div class="cbbar"><i style="width:\${r.cb}%"></i></div>
      <span class="cbband">\${esc(bandLabel(r.cbBand))}</span></td>
    <td>\${r.score!==null?\`<span class="score">\${r.score.toFixed(1)}</span><br>\`:''}<span class="st">\${esc(r.status)}</span></td>
    <td class="role"><a href="\${esc(r.u)}" target="_blank" rel="noopener"><span class="co">\${esc(r.c)}</span> — \${esc(r.t)}</a>
      <div class="loc">\${esc(r.l) || '<i>no location published</i>'}</div></td>
    <td><span class="lanetag">\${r.lane}</span><div style="margin-top:5px">\${(r.all.length?r.all:['—']).map(k=>\`<span class="kw">\${esc(k)}</span>\`).join('')}</div></td>
    <td><span class="age">\${r.age===null?'unknown':r.age+' d'}</span>
      <div class="agebar"><i style="width:\${ageBar(r.age)}%;background:\${bandColor(r.band)}"></i></div>
      <span class="fl">\${r.p || 'no date'}</span></td>
    <td style="font-size:12.5px;white-space:nowrap">\${esc(r.seg)}</td>
    \${M.hasTrust?\`<td class="trust">\${r.trust===null?'<span class="fl">—</span>':r.trust+(r.flags?\`<span class="fl">\${esc(r.flags)}</span>\`:'')}</td>\`:''}
  </tr>\`).join('');
  el('more').hidden = f.length <= limit;
  el('more').innerHTML = f.length > limit
    ? \`Showing \${shown.length} of \${f.length} — <button class="chip" id="showmore">show \${Math.min(PAGE, f.length-limit)} more</button>\`
    : '';
  const btn = el('showmore');
  if (btn) btn.onclick = () => { limit += PAGE; render(); };
}

function toggler(containerId, key, attr){
  el(containerId).addEventListener('click', e => {
    const b = e.target.closest('['+attr+']');
    if (!b) return;
    state[key] = state[key] === b.getAttribute(attr) ? null : b.getAttribute(attr);
    [...el(containerId).querySelectorAll('['+attr+']')]
      .forEach(x => x.setAttribute('aria-pressed', String(x.getAttribute(attr) === state[key])));
    limit = PAGE; render();
  });
}
toggler('lanes','lane','data-lane');
toggler('segs','seg','data-seg');
toggler('cbbands','cbband','data-cbband');
el('fsel').addEventListener('change', e => { state.band = e.target.value; limit = PAGE; render(); });
el('co').addEventListener('input', e => { state.co = e.target.value.toLowerCase().trim(); limit = PAGE; render(); });
el('q').addEventListener('input', e => { state.q = e.target.value.toLowerCase().trim(); limit = PAGE; render(); });
document.querySelectorAll('th.sortable').forEach(th => {
  th.addEventListener('click', () => {
    const k = th.dataset.k;
    if (sortKey === k) sortDir *= -1; else { sortKey = k; sortDir = (k === 'age' || k === 'cb' || k === 'company' || k === 'seg' || k === 'lane') ? 1 : -1; }
    document.querySelectorAll('th.sortable').forEach(x => x.removeAttribute('aria-sort'));
    th.setAttribute('aria-sort', sortDir === 1 ? 'ascending' : 'descending');
    th.querySelector('.car').textContent = sortDir === 1 ? '▲' : '▼';
    render();
  });
});
document.querySelector('th[data-k="cb"]').setAttribute('aria-sort','descending');

// ---- configuration panel --------------------------------------------
const y = M.yields;
el('cfgbody').innerHTML = \`
<h3>Reply-odds rubric — \${M.signals.length} signals, base \${50}</h3>
<p style="color:var(--text-2);font-size:13px;margin:0 0 10px">
  Each signal moves the score by at most the cap shown. Keyword evidence is capped at 8 on purpose: no
  amount of keyword matching can carry a row on its own, so the column cannot be inflated by adding broad
  positives to <span class="mono">portals.yml</span>.</p>
<table class="mini"><thead><tr><th>Signal</th><th class="num">Cap</th><th>What it reads</th></tr></thead><tbody>
\${M.signals.map(s=>\`<tr><td>\${esc(s.label)}</td><td class="num">±\${s.max}</td><td style="color:var(--text-3);font-size:12px">\${esc({
  fit:'role family vs the archetypes in config/profile.yml',
  level:'seniority words in the title vs your target level',
  evidence:'how many portals.yml positives matched, and how specific',
  fresh:'days since the board published it',
  pool:'corridor segment as a proxy for how many people are applying',
  volume:'how many reqs this employer has open in the pipeline',
  repost:'same company and title surfaced under more than one URL',
  trust:'provider trust score, when the scanner recorded one',
}[s.id]||'')}</td></tr>\`).join('')}
</tbody></table>
<h3>Calibration</h3>
<p style="color:var(--text-2);font-size:13px;margin:0 0 10px">\${
  M.calibration.length
    ? 'Observed reply rate per band, from data/applications.md:'
    : 'Uncalibrated. No applied posting in data/applications.md carries an outcome yet, so these weights have not been checked against a single real reply. Treat the ordering as a triage hint, not a probability.'
}</p>
\${M.calibration.length ? \`<table class="mini"><thead><tr><th>Band</th><th class="num">Applied</th><th class="num">Replied</th><th class="num">Rate</th></tr></thead><tbody>
\${M.calibration.map(c=>\`<tr><td>\${esc(c.band)}</td><td class="num">\${c.applied}</td><td class="num">\${c.replied}</td><td class="num">\${Math.round(c.replied/c.applied*100)}%</td></tr>\`).join('')}
</tbody></table>\` : ''}
<h3>Keyword yield — \${y.length} positives against \${M.historyAdded} scanner-added postings</h3>
<p style="color:var(--text-2);font-size:13px;margin:0 0 10px">
  <b>Unique</b> is the count only that keyword caught. A keyword with zero unique hits can be deleted
  without losing a posting; a keyword whose unique sample reads like an unrelated job is matching as a
  substring. Sorted lowest yield first.</p>
<table class="mini"><thead><tr><th>Keyword</th><th class="num">Added</th><th class="num">Unique</th><th class="num">Pending</th><th>Only this keyword caught</th></tr></thead><tbody>
\${y.map(k=>\`<tr class="\${k.added===0?'zero':''}"><td class="mono">\${esc(k.keyword)}</td><td class="num">\${k.added}</td><td class="num">\${k.unique}</td><td class="num">\${k.pending}</td><td style="color:var(--text-3);font-size:12px">\${esc(k.sample)}</td></tr>\`).join('')}
</tbody></table>
<h3>Pruned from the pipeline — \${M.discards.length} postings</h3>
<table class="mini"><thead><tr><th>When</th><th>Reason</th></tr></thead><tbody>
\${M.discards.slice(-15).reverse().map(d=>\`<tr><td class="mono" style="white-space:nowrap">\${esc((d.ts||'').slice(0,10))}</td><td style="font-size:12px">\${esc(d.reason)}</td></tr>\`).join('') || '<tr><td colspan="2">none</td></tr>'}
</tbody></table>
<h3>Retired postings — \${M.expired.count} confirmed gone</h3>
<table class="mini"><thead><tr><th>Removed (est.)</th><th>Evidence</th><th>Company</th></tr></thead><tbody>
\${M.expired.rows.slice(0,10).map(r=>\`<tr><td class="mono" style="white-space:nowrap">\${esc(r.removed)}</td><td class="mono" style="font-size:12px">\${esc(r.evidence)}</td><td>\${esc(r.company)}</td></tr>\`).join('') || '<tr><td colspan="3">none</td></tr>'}
</tbody></table>\`;

render();
</script>
`;
}

function main(argv) {
  const outIdx = argv.indexOf('--out');
  const out = outIdx >= 0 ? argv[outIdx + 1] : join(ROOT, 'output', 'pipeline-artifact.html');
  const model = buildModel();
  const html = renderHtml(model);
  writeFileSync(resolve(out), html);
  const laneCounts = model.lanes.map(l => `${l.id}=${model.rows.filter(r => r.lane === l.id).length}`).join(' ');
  console.log(`${out} — ${model.rows.length} pending (${laneCounts}), ${Math.round(html.length / 1024)}KB`);
}

if (import.meta.url === pathToFileURL(process.argv[1] || '').href) main(process.argv.slice(2));
