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
import { dirname, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import * as yaml from 'js-yaml';
import { parsePendingRows, classifyRows } from './swarm.mjs';
import { loadLanes, LANES_PATH } from './lanes.mjs';
import { matchedTitleKeywords, buildTitleFilter } from './scan.mjs';
import { buildScorer, calibrate, SIGNALS, BANDS } from './callback-score.mjs';
import { profileDir } from './profiles.mjs';
import { buildChannelTrust } from './channel-trust.mjs';
import { resolveColumns, parseTrackerRow } from './tracker-parse.mjs';
import { parseExpiredLog } from './expired-log.mjs';
import { isMainModule } from './lib/is-main-module.mjs';
import { cumulativeTiles } from './web/src/lib/funnel-tiles.mjs';
import { scaleLinear, barWidths, histogramBins, stackedSegments, sparklinePath, shadePct } from './web/src/lib/chart-geometry.mjs';
import { computeRunStats } from './stats.mjs';
import { analyze as analyzeVelocity, loadBenchmarks } from './funnel-velocity.mjs';
import { loadCanonicalStates } from './tracker-utils.mjs';
import { loadTrackerRows, loadFollowupRows, loadRepostClusters, buildCompanyCards, getCompanyCard, loadStatusLogSource } from './company-history.mjs';
import { parseObservations, fold } from './salary-gap.mjs';
import { parseReportGaps, aggregateGaps, knownSkillsText, extractSkills } from './upskill.mjs';
import { analyze as analyzePatterns } from './analyze-patterns.mjs';

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
      seen: c[idx.first_seen] || '',
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
  const lines = text.split(/\r?\n/);
  // Header-aware column mapping (tracker-parse.mjs), not fixed positions — an
  // inserted column (e.g. Location, #946) must not shift score into status.
  const colmap = resolveColumns(lines);
  const byKey = new Map();
  const list = [];
  for (const line of lines) {
    const row = parseTrackerRow(line, colmap);
    if (!row || !row.company) continue;
    byKey.set(`${row.company}|${row.role}`.toLowerCase(), { score: row.score, status: row.status });
    list.push({ num: row.num, company: row.company, role: row.role });
  }
  return { byKey, list };
}

function loadExpired(root) {
  // Count comes from the parsed rows, not the "_N postings recorded._" prose:
  // expired-log.mjs derives that sentence from the table it writes, and a row
  // deleted by hand stays deleted (the file is canonical), so the prose can
  // only ever be stale — never more right than the rows.
  const rows = [...parseExpiredLog(readIf(join(root, 'data/expired-jobs.md'))).values()]
    .map(r => ({ removed: r.removed, company: r.company, title: r.title, evidence: r.evidence }));
  return { count: rows.length, rows };
}

/**
 * data/jd-facts.tsv, indexed by URL — the description-derived facts the score
 * gates and grades on. Absent until enrich-jd.mjs has run; an empty map is a
 * supported state (every row then scores on its title family and says so).
 */
function loadJdFacts(root) {
  const text = readIf(join(root, 'data/jd-facts.tsv'));
  if (!text) return new Map();
  const lines = text.split(/\r?\n/).filter(Boolean);
  const cols = lines[0].split('\t');
  return new Map(lines.slice(1).map(l => {
    const c = l.split('\t');
    const row = Object.fromEntries(cols.map((k, i) => [k, c[i] ?? '']));
    return [row.url, row];
  }));
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

/**
 * Build the page model.
 *
 * `root` is where the DATA comes from and `profileRoot` is whose INTENT scores
 * it. They are the same directory for the repo owner. For anyone else they are
 * not: one scan produces one corpus, and each additional profile is a
 * projection of that corpus through its own target roles and lanes, keeping the
 * rows its own archetypes claim. A posting both people target appears for both
 * — the projection is a relevance test, not an ownership one.
 */
// ---- analytics panels -------------------------------------------------------
// Same degrade contract as readIf: a missing or malformed side file renders an
// absent panel, never a throw. Each loader traps its own errors so one bad
// analytics file cannot take down the whole page build.

/** data/alert-log.tsv — the hydration-reliability timeline scripts/alert.cmd writes. */
function loadAlerts(root) {
  const lines = readIf(join(root, 'data/alert-log.tsv')).split(/\r?\n/).filter(Boolean);
  if (lines.length < 2) return [];
  const idx = Object.fromEntries(lines[0].split('\t').map((c, i) => [c, i]));
  if (idx.when == null || idx.result == null) return [];
  return lines.slice(1).map(l => {
    const c = l.split('\t');
    const result = c[idx.result] || '';
    return { when: c[idx.when] || '', stage: c[idx.stage] || '', ok: result === 'ok', result };
  }).filter(a => a.when);
}

/** funnel-velocity, trimmed to what the page renders. Null when nothing can be measured. */
function loadVelocity(root, now) {
  try {
    const benchPath = existsSync(join(root, 'config/benchmarks.yml'))
      ? join(root, 'config/benchmarks.yml')
      : join(ROOT, 'templates/benchmarks.yml');
    const v = analyzeVelocity({
      trackerContent: readIf(join(root, 'data/applications.md')),
      logContent: readIf(join(root, 'data/status-log.tsv')),
      benchmarks: loadBenchmarks(benchPath).benchmarks,
      states: loadCanonicalStates(join(ROOT, 'templates/states.yml')),
      todayStr: now.toISOString().slice(0, 10),
    });
    return { hops: Object.values(v.velocity), waiting: v.waiting };
  } catch { return null; }
}

/**
 * company-history cards for the companies on this page, plus the repost
 * clusters (computed once, shared by the drawer and the Coverage panel).
 * statusLog is pre-loaded by the async CLI path; the sync build-hub path
 * passes nothing and the source reports itself absent.
 */
function loadCompanyData(root, companies, statusLog, now) {
  const out = { cards: {}, reposts: [], scanned: false };
  try {
    const tracker = loadTrackerRows(root);
    const followups = loadFollowupRows(root);
    // portalsPath passed explicitly so a fixture root never falls back to the env override.
    const scanHistory = loadRepostClusters(root, undefined, join(root, 'portals.yml'));
    const sl = statusLog || { loaded: false, appliedDateByNum: new Map(), medianResponseDays: null };
    const result = buildCompanyCards({
      trackerRows: tracker.rows,
      followupRows: followups.rows,
      repostClusters: scanHistory.clusters,
      aggregators: scanHistory.aggregators,
      sourcesLoaded: { tracker: tracker.loaded, followups: followups.loaded, scanHistory: scanHistory.loaded, statusLog: sl.loaded },
      statusLogAppliedByNum: sl.appliedDateByNum,
      medianResponseDays: sl.medianResponseDays,
    }, { now });
    out.scanned = scanHistory.loaded;
    out.reposts = scanHistory.clusters.map(c => ({
      company: c.company, role: c.role, n: c.repostCount, span: c.daysSpan, last: c.lastSeen,
    }));
    for (const name of companies) {
      const card = getCompanyCard(result, name, scanHistory.aggregators);
      // Only cards that say something: an all-defaults card on every row is noise.
      if (card.responsiveness.label === 'no-history' && card.postingChurn.clusters.length === 0
          && card.explanations.length === 0) continue;
      out.cards[name] = {
        resp: card.responsiveness.label,
        respDays: card.responsiveness.medianResponseDays,
        churn: card.postingChurn.label,
        clusters: card.postingChurn.clusters,
        notes: card.explanations,
      };
    }
  } catch { /* degrade to empty */ }
  return out;
}

/** salary-gap fold over data/salary-observations.tsv; null when no observations exist. */
function loadSalary(root, appRows, profile) {
  try {
    const obs = parseObservations(readIf(join(root, 'data/salary-observations.tsv')));
    if (!obs.length) return null;
    const apps = {};
    for (const a of appRows) apps[String(a.num)] = { company: a.company, role: a.role };
    const target = profile.compensation?.target_range;
    const folded = fold(obs, apps, target
      ? { amount: String(target), currency: profile.compensation?.currency || null } : null);
    const pick = o => (o ? { amount: o.amount, currency: o.currency } : null);
    return {
      applications: folded.applications.map(a => ({
        num: a.num, company: a.company, role: a.role,
        advertised: pick(a.advertised), actual: pick(a.actual),
        advToActPct: a.advToActPct, desiredToActPct: a.desiredToActPct,
      })),
      byCurrency: folded.aggregates.byCurrency,
      quality: {
        orphans: folded.quality.orphans.length,
        unparseable: folded.quality.unparseable.length,
        withoutActual: folded.quality.withoutActual,
      },
    };
  } catch { return null; }
}

/** upskill aggregation over the evaluation reports the tracker links; null when none carry gaps. */
function loadUpskill(root) {
  try {
    const lines = readIf(join(root, 'data/applications.md')).split(/\r?\n/);
    const colmap = resolveColumns(lines);
    const reports = [];
    for (const line of lines) {
      const row = parseTrackerRow(line, colmap);
      if (!row) continue;
      const m = String(row.report || '').match(/\]\(([^)]+)\)/);
      if (!m) continue;
      // Tracker links are relative to data/; legacy links are root-relative.
      for (const cand of new Set([join(root, 'data', m[1]), join(root, m[1])])) {
        // Lexical reports/ containment — same guard shape as upskill.mjs withinReports.
        const rel = relative(root, cand).split(sep).join('/');
        if (!rel.startsWith('reports/') || rel.includes('..')) continue;
        const txt = readIf(cand);
        if (!txt) continue;
        const g = parseReportGaps(txt);
        reports.push({ num: row.num, score: g.score, gapText: g.gapText });
        break;
      }
    }
    if (!reports.length) return null;
    const known = extractSkills(knownSkillsText(
      readIf(join(root, 'cv.md')), readIf(join(root, 'config/profile.yml')), () => {}));
    const agg = aggregateGaps(reports, known);
    if (!agg.gaps.length) return null;
    return { gaps: agg.gaps.slice(0, 12), totalLowFit: agg.totalLowFit, reports: reports.length };
  } catch { return null; }
}

/** analyze-patterns, trimmed. Its not-enough-data error is carried, not hidden. */
function loadPatterns(root) {
  try {
    const p = analyzePatterns({ root });
    if (p.error) return { error: p.error };
    return {
      total: p.metadata.total,
      funnel: p.funnel,
      recommendations: (p.recommendations || []).slice(0, 6).map(r => ({ action: r.action, impact: r.impact })),
    };
  } catch { return null; }
}

export function buildModel({ root = ROOT, now = new Date(), profileRoot = null, profileName = null, statusLog = null } = {}) {
  // Only the two intent files move; every data read below stays on `root`.
  const intentRoot = profileRoot || root;
  const portals = yaml.load(readFileSync(join(root, 'portals.yml'), 'utf-8')) || {};
  const positives = portals.title_filter?.positive || [];
  const maxAge = portals.max_posting_age_days || 45;
  const bands = freshnessBands(maxAge);
  // LANES_PATH is already absolute (or an explicit env override); joining it
  // onto root would produce a path that never resolves and silently classify
  // every posting as `core`.
  const lanes = loadLanes(intentRoot === ROOT ? LANES_PATH : join(intentRoot, 'config', 'lanes.yml'));
  const history = loadHistory(root);
  const apps = loadApplications(root);
  const titleFilter = { positive: positives };

  const pipelineText = readFileSync(join(root, 'data/pipeline.md'), 'utf-8');
  const parsed = classifyRows(parsePendingRows(pipelineText), lanes);
  const today = new Date(now.toISOString().slice(0, 10) + 'T00:00:00Z');

  const jdFacts = loadJdFacts(root);
  let rows = parsed.map(r => {
    const h = history.byUrl.get(r.url);
    // Some boards publish the location only on the rendered page, so the
    // browser pass in enrich-jd writes it back. The pipeline row still wins.
    const location = r.location || jdFacts.get(r.url)?.location || '';
    // The pipeline row wins; scan-history backfills the 20% with no posted date.
    const posted = r.posted || h?.posted?.slice(0, 10) || null;
    const age = posted ? Math.round((today - new Date(posted + 'T00:00:00Z')) / 864e5) : null;
    const app = apps.byKey.get(`${r.company}|${r.title}`.toLowerCase());
    return {
      u: r.url,
      c: r.company || '—',
      t: r.title || '—',
      l: location,
      seg: segmentFor(location),
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
  const profile = existsSync(join(intentRoot, 'config/profile.yml'))
    ? yaml.load(readFileSync(join(intentRoot, 'config/profile.yml'), 'utf-8')) || {}
    : {};
  const scoreRow = buildScorer({ profile, lanes, rows, history: history.added, facts: jdFacts });
  for (const r of rows) {
    const s = scoreRow(r);
    r.cb = s.score;
    r.cbBand = s.band;
    r.why = s.signals;
    r.family = s.family;
    if (s.gate) r.gate = s.gate;
    // The facts the drawer shows. Only rows whose description was actually
    // read carry one, so "no f" is exactly the unread set the chip counts.
    const fx = jdFacts.get(r.u);
    if (fx && fx.ok === '1') {
      r.f = {};
      for (const k of ['yoe', 'degree', 'clearance', 'comp_low', 'comp_high', 'remote', 'hats', 'frameworks']) {
        if (fx[k]) r.f[k] = fx[k];
      }
    }
  }

  // The projection. `family` is the scorer's own relevance verdict: a title
  // matching none of this profile's target roles, in none of its lanes, is
  // someone else's row. Deliberately applied AFTER scoring — how many reqs a
  // company has open and how often a title repeats are properties of the whole
  // corpus, and reading them off the slice would change the score a row gets
  // purely because of who is looking at it.
  const dropped = profileRoot ? rows.filter(r => r.family === 'unmatched').length : 0;
  if (profileRoot) rows = rows.filter(r => r.family !== 'unmatched');

  const laneMeta = [
    ...lanes.map(l => ({ id: l.id, label: l.archetype, max: l.max_evaluations ?? null })),
    { id: 'core', label: 'Core targeting (AI / front-end / forward-deployed)', max: null },
  ];

  const dead = positives.filter(k => !keywordCount(k, rows));
  // No provider in this config has ever written a trust score, so the column
  // would render as 547 dashes. It appears only once the data exists.
  const hasTrust = rows.some(r => r.trust !== null);
  const readCount = rows.filter(r => jdFacts.get(r.u)?.ok === '1').length;
  const gates = [...rows.filter(r => r.gate).reduce((m, r) => {
    const k = r.gate.replace(/\d+/g, 'N');
    return m.set(k, (m.get(k) || 0) + 1);
  }, new Map())].map(([reason, n]) => ({ reason, n })).sort((a, b) => b.n - a.n);
  // Bar widths ride on the model rather than being recomputed in the page
  // script, so the gate table's bars share the same geometry the charts use.
  barWidths(gates.map(g => g.n), 100).forEach((w, i) => { gates[i].w = w; });
  // Funnel counters for the progress chart. The top stages are pipeline
  // counts; the applied / interview / offer tail comes from the applications
  // tracker, with the cumulative math from funnel-tiles.mjs (an offer proves
  // the interview that led to it).
  const appList = [...apps.byKey.values()];
  const tiles = cumulativeTiles(appList.map(a => (a.status || '').toUpperCase()));
  const funnel = [
    { label: 'Scanner-added (all time)', n: history.added.length },
    { label: 'Pending now', n: rows.length },
    { label: 'Description read', n: readCount },
    { label: 'Match ≥ 42', n: rows.filter(r => r.cbBand === 'premier' || r.cbBand === 'strong').length },
    { label: 'Applied', n: appList.length },
    { label: 'Reached interview', n: tiles.interviews },
    { label: 'Offer', n: tiles.offers },
  ];
  // Weekly scanner additions per channel, oldest week first — the sparkline
  // series. Twelve fixed buckets so every row shares one x- and y-scale.
  const SPARK_WEEKS = 12;
  const seriesByPortal = new Map();
  for (const h of history.added) {
    const seen = (h.seen || '').slice(0, 10);
    if (!seen) continue;
    const w = Math.floor((today - new Date(seen + 'T00:00:00Z')) / (7 * 864e5));
    if (w < 0 || w >= SPARK_WEEKS) continue;
    const key = h.portal || 'unknown';
    if (!seriesByPortal.has(key)) seriesByPortal.set(key, Array(SPARK_WEEKS).fill(0));
    seriesByPortal.get(key)[SPARK_WEEKS - 1 - w]++;
  }
  const channelSeries = [...seriesByPortal]
    .map(([portal, weeks]) => ({ portal, weeks, total: weeks.reduce((a, b) => a + b, 0) }))
    .sort((a, b) => b.total - a.total);

  // Analytics panels — every loader degrades to null/empty on a missing file.
  const companyData = loadCompanyData(root, new Set(rows.map(r => r.c)), statusLog, now);
  return {
    generated: now.toISOString().slice(0, 10),
    // The date says which day the data is from; this says which hydration the
    // reader is being served. `hydrationState` needs the time, not the day.
    built: now.toISOString(),
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
    // Gate accounting is published, not implied: a rule that starts eating good
    // reqs has to be visible on the page that applied it.
    jd: {
      read: readCount,
      gated: rows.filter(r => r.gate).length,
      gates,
    },
    funnel,
    channelSeries,
    who: {
      name: profileName,
      label: profile.candidate?.full_name || profileName || 'this profile',
      primary: profile.target_roles?.primary || [],
      archetypes: (profile.target_roles?.archetypes || []).map(a => ({
        name: a.name, level: a.level || '', fit: a.fit || '',
      })),
      floor: profile.compensation?.minimum ?? null,
      target: profile.compensation?.target_range || '',
      location: profile.candidate?.location || '',
      currency: profile.compensation?.currency || '',
      companies: (portals.tracked_companies || []).filter(c => c.enabled !== false).length,
      boards: (portals.job_boards || []).filter(b => b.enabled !== false).length,
    },
    // Published rather than implied: a projection that drops most of the corpus
    // is a misconfigured profile, and the reader has to be able to see that.
    projection: profileRoot ? { kept: rows.length, dropped } : null,
    // Ingestion trust, computed from the same scan history the rows came out of.
    // It stays on `root` even under a projection: the channels are a property of
    // the corpus, not of whoever is looking at it.
    channels: buildChannelTrust({ root }),
    signals: SIGNALS,
    cbBands: BANDS.map(b => ({ id: b.id, label: b.label, min: b.min === -Infinity ? 0 : b.min })),
    calibration: calibrate(rows),
    runStats: computeRunStats(readIf(join(root, 'data/scan-runs.tsv'))),
    alerts: loadAlerts(root),
    velocity: loadVelocity(root, now),
    companyCards: companyData.cards,
    reposts: { clusters: companyData.reposts, scanned: companyData.scanned },
    salary: loadSalary(root, apps.list, profile),
    upskill: loadUpskill(root),
    patterns: loadPatterns(root),
  };
}

function keywordCount(kw, rows) {
  return rows.some(r => r.all.includes(kw));
}

const esc = s => String(s ?? '').replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c])).replace(/�/g, '&#xFFFD;');

// ---- server-rendered charts -----------------------------------------------
// The geometry lives in web/src/lib/chart-geometry.mjs (shared with the web
// app); this side only turns numbers into markup at build time. Every chart is
// an addition — the tables stay, the counts stay printed as text — and every
// fill or stroke is a var(--token) from the page's existing set, so the charts
// follow the theme the same way the .cbbar/.agebar/.pct bars always have.

// Mirrors the client-side bandColor(): freshness band index → token.
const FRESH_COLORS = ['var(--fresh)', 'var(--recent)', 'var(--aging)', 'var(--stale)'];
const freshColor = i => FRESH_COLORS[i] || 'var(--stale)';

/** One labeled row of the graduated .pct bar pattern: label | bar | count. */
const hbarRows = (items, widths) => items.map((s, i) =>
  `<span class="hl">${esc(s.label)}</span><span class="hb"><i style="width:${widths[i]}%"></i></span><span class="hn">${s.n}</span>`).join('');

/** (a) Progress funnel — left-aligned bars on one baseline, never tapered. */
function chartFunnel(m) {
  const widths = barWidths(m.funnel.map(s => s.n), 100);
  const applied = m.funnel.find(s => s.label === 'Applied')?.n ?? 0;
  const aria = `Of ${m.funnel[0].n} scanner-added postings, ${m.funnel[1].n} are pending, `
    + `${m.funnel[2].n} have their description read, ${m.funnel[3].n} match at 42 or better, `
    + `${applied} applied, ${m.funnel[5].n} reached interview and ${m.funnel[6].n} hold an offer.`;
  const caveat = applied < 25
    ? `<p class="chartnote">With only ${applied} application${applied === 1 ? '' : 's'} recorded, the lower stages are
       too small to read as rates — treat them as a tally, not a conversion funnel.</p>` : '';
  return `<h3>Progress funnel — scanner to offer</h3>
<div class="hbars" role="img" aria-label="${esc(aria)}">${hbarRows(m.funnel, widths)}</div>${caveat}`;
}

/** (f) Company concentration — top companies by pending rows, same pattern. */
function chartCompanies(m) {
  if (!m.rows.length) return '';
  const byCo = new Map();
  for (const r of m.rows) byCo.set(r.c, (byCo.get(r.c) || 0) + 1);
  const top = [...byCo].sort((a, b) => b[1] - a[1]).slice(0, 12)
    .map(([label, n]) => ({ label, n }));
  const held = top.reduce((a, s) => a + s.n, 0);
  const aria = `The top ${top.length} of ${byCo.size} companies hold ${held} of `
    + `${m.rows.length} pending postings (${Math.round(held / m.rows.length * 100)}%).`;
  return `<h3>Company concentration — top ${top.length} of ${byCo.size} companies</h3>
<div class="hbars" role="img" aria-label="${esc(aria)}">${hbarRows(top, barWidths(top.map(s => s.n), 100))}</div>`;
}

/** (b) Score histogram with band boundaries; the band regions are clickable
 * and forward to the existing Match chips (see the #cbhist listener). */
function chartHistogram(m) {
  if (!m.rows.length) return '';
  const W = 440, H = 92; // plot box; labels sit below at y 96..118
  const bins = histogramBins(m.rows.map(r => r.cb), 5, 100);
  const maxN = Math.max(0, ...bins.map(b => b.n));
  const sy = scaleLinear(maxN, 76);
  const sx = scaleLinear(100, W);
  const modal = bins.find(b => b.n === maxN);
  const aria = `Most of the ${m.rows.length} pending rows score between ${modal.x0} and ${modal.x1}; `
    + `${m.jd.gated} are gated to 0.`;
  // Bands ascending by floor, each region ending where the better one starts.
  // A sliver band (blocked spans scores 0..1, ~4 units of the 440 viewBox)
  // still needs a click target a pointer can hit and a label that stays inside
  // the viewBox: widen narrow rects to a minimum, clamp the label x, and paint
  // narrow regions last so their widened targets sit on top of wide neighbours.
  const asc = [...m.cbBands].reverse();
  const regionParts = asc.map((b, i) => {
    const lo = b.min, hi = i + 1 < asc.length ? asc[i + 1].min : 100;
    const x = sx(lo), w = sx(hi) - x;
    const tx = Math.min(Math.max(sx((lo + hi) / 2), 20), W - 20);
    const html = `<rect data-cbband="${b.id}" x="${x}" y="0" width="${Math.max(w, 14)}" height="${H}" fill="transparent"><title>${esc(b.label)} — click to filter the pipeline</title></rect>`
      + `<text x="${tx}" y="${H + 14}" text-anchor="middle" font-size="9" fill="var(--text-3)">${b.id}</text>`
      + (lo > 0 ? `<line x1="${x}" y1="0" x2="${x}" y2="${H}" stroke="var(--line)" stroke-dasharray="3 3"/>` : '');
    return { w, html };
  });
  const regions = regionParts.sort((a, b) => b.w - a.w).map(p => p.html).join('');
  const bars = bins.map(b => {
    if (!b.n) return '';
    const h = sy(b.n), x = sx(b.x0);
    return `<rect x="${x + 1}" y="${H - h}" width="${sx(b.x1) - x - 2}" height="${h}" fill="var(--accent)"/>`
      + `<text x="${sx((b.x0 + b.x1) / 2)}" y="${H - h - 3}" text-anchor="middle" font-size="8" fill="var(--text-2)">${b.n}</text>`;
  }).join('');
  return `<h3>Score distribution — ${m.rows.length} pending rows</h3>
<svg id="cbhist" viewBox="0 0 ${W} ${H + 20}" role="img" aria-label="${esc(aria)}">
<line x1="0" y1="${H}" x2="${W}" y2="${H}" stroke="var(--line)"/>${bars}${regions}</svg>
<p class="chartnote">Click a band to filter the pipeline table to it — same filter as the Match chips.</p>`;
}

/** (c) Age mix per match band — stacked strips, unknown age its own segment. */
function chartAgeStrips(m) {
  if (!m.rows.length) return '';
  const segs = [...m.bands.map(b => b.id), 'unknown'];
  const color = i => i < m.bands.length ? freshColor(i) : 'var(--none)';
  const fresh = r => r.age !== null && r.age <= 14;
  const pct = (a, b) => (b ? Math.round(a / b * 100) : 0);
  const top = m.rows.filter(r => r.cbBand === 'premier' || r.cbBand === 'strong');
  const unknownN = m.rows.filter(r => r.age === null).length;
  const aria = `${pct(top.filter(fresh).length, top.length)}% of rows matching at 42 or better are 14 days `
    + `old or fresher, against ${pct(m.rows.filter(fresh).length, m.rows.length)}% of all pending rows; `
    + `${unknownN} rows have no posted date.`;
  const legend = `<div class="legend">${segs.map((id, i) => `<span><i style="background:${color(i)}"></i>${esc(id)}</span>`).join('')}</div>`;
  const strips = m.cbBands.map(b => {
    const inBand = m.rows.filter(r => r.cbBand === b.id);
    const counts = segs.map(id => inBand.filter(r => r.band === id).length);
    const tiled = stackedSegments(counts, 100);
    const printed = counts.map((n, i) => (n ? `${esc(segs[i])} ${n}` : '')).filter(Boolean).join(' · ') || 'none';
    return `<span class="hl">${esc(b.label)}</span>`
      + `<span class="strip">${tiled.map((s, i) => (s.w ? `<i style="width:${s.w}%;background:${color(i)}"></i>` : '')).join('')}</span>`
      + `<span class="hn">${inBand.length}</span>`
      + `<span class="sc">${printed}</span>`;
  }).join('');
  return `<h3>Age mix by match band</h3>${legend}
<div class="strips" role="img" aria-label="${esc(aria)}">${strips}</div>`;
}

/** (d) Channel sparklines — every row on ONE shared y-scale. */
function chartSparklines(m) {
  if (!m.channelSeries.length) return '';
  const yMax = Math.max(...m.channelSeries.map(c => Math.max(...c.weeks)));
  const rowsHtml = m.channelSeries.map(c =>
    `<span class="hl mono">${esc(c.portal)}</span>`
    + `<svg class="spark" viewBox="0 0 120 24" preserveAspectRatio="none"><path d="${sparklinePath(c.weeks, 120, 20, yMax)}" transform="translate(0,2)"/></svg>`
    + `<span class="hn">${c.total}</span>`).join('');
  const top = m.channelSeries[0];
  const aria = `Weekly scanner additions over the last 12 weeks, every channel on one shared scale; `
    + `${top.portal} leads with ${top.total} row${top.total === 1 ? '' : 's'} added.`;
  return `<h3>Additions per channel — last 12 weeks</h3>
<div class="hbars sparks" role="img" aria-label="${esc(aria)}">${rowsHtml}</div>
<p class="chartnote">One shared y-scale across every row — a flat line is genuinely quiet, not rescaled.</p>`;
}

/** (e) Channel-by-freshness heatmap — a shaded .mini table, every count printed. */
function chartHeatmap(m) {
  if (!m.rows.length) return '';
  const cols = [...m.bands.map(b => b.id), 'unknown'];
  const byPortal = new Map();
  for (const r of m.rows) {
    const key = r.portal || 'unknown';
    if (!byPortal.has(key)) byPortal.set(key, Object.fromEntries(cols.map(c => [c, 0])));
    byPortal.get(key)[r.band]++;
  }
  const rowsOut = [...byPortal].map(([portal, counts]) => ({ portal, counts, total: cols.reduce((a, c) => a + counts[c], 0) }))
    .sort((a, b) => b.total - a.total);
  let peak = { portal: '', band: '', n: 0 };
  for (const r of rowsOut) for (const c of cols) if (r.counts[c] > peak.n) peak = { portal: r.portal, band: c, n: r.counts[c] };
  const aria = `Pending rows by channel and age band; the densest cell is ${peak.portal} at ${peak.band} `
    + `with ${peak.n} of ${m.rows.length} rows.`;
  const cell = n => `<td class="num" style="background:color-mix(in srgb, var(--accent) ${shadePct(n, peak.n)}%, transparent)${n ? '' : ';color:var(--text-3)'}">${n}</td>`;
  return `<h3>Pending rows by channel and age</h3>
<table class="mini heat" role="img" aria-label="${esc(aria)}"><thead><tr><th>Channel</th>${cols.map(c => `<th class="num">${esc(c)}</th>`).join('')}<th class="num">Total</th></tr></thead><tbody>
${rowsOut.map(r => `<tr><td class="mono">${esc(r.portal)}</td>${cols.map(c => cell(r.counts[c])).join('')}<td class="num">${r.total}</td></tr>`).join('')}
</tbody></table>`;
}

/**
 * Which hydration the reader is looking at, decided when the page opens.
 *
 * The artifact is a static file rebuilt by the scheduled task at 07:00 and
 * 19:00 (`schtasks /ri 720 /du 24:00`), so the build stamp is the only
 * evidence a reader has that the numbers in front of them are current:
 *
 *   'live'    the build falls inside the window the reader is standing in —
 *             the data was hydrated for this view
 *   'missed'  the most recent window opened and no build came out of it, so
 *             the hydration did not fire
 *   'stale'   the build predates that window too — an older hydration is
 *             still being served
 *
 * Exported so the branch is testable, and injected into the page by source so
 * the page and the test can never disagree about it.
 */
export function hydrationState(builtIso, now) {
  if (!builtIso) return 'missed';
  var built = new Date(builtIso).getTime();
  if (!isFinite(built)) return 'missed';
  var last = new Date(now.getTime());
  last.setMinutes(0, 0, 0);
  var h = last.getHours();
  // Before 07:00 the current window is yesterday evening's; setHours(-5)
  // rolls the date back for us.
  last.setHours(h >= 19 ? 19 : h >= 7 ? 7 : -5);
  if (built >= last.getTime()) return 'live';
  if (built >= last.getTime() - 12 * 3600 * 1000) return 'missed';
  return 'stale';
}

/** (g) Scanner runs — new postings per run, from data/scan-runs.tsv. */
function chartRuns(m) {
  const s = m.runStats;
  if (!s || !s.runs || !s.runs.length) return '';
  const runs = s.runs.slice(-20);
  const items = runs.map(r => ({ label: r.date + (r.status !== 'completed' ? ` (${r.status})` : ''), n: r.newAdded }));
  const widths = barWidths(items.map(i => i.n), 100);
  const aria = `${s.totalRuns} scanner runs recorded; the last ${runs.length} added `
    + `${runs.reduce((a, r) => a + r.newAdded, 0)} new postings; a completed run averages `
    + `${s.avgFoundPerRun} found and ${s.avgNewPerRun} added.`;
  const failed = s.failedRuns ? ` ${s.failedRuns} failed run${s.failedRuns === 1 ? '' : 's'} excluded from the averages.` : '';
  const drifted = s.driftedRows ? ` ${s.driftedRows} row${s.driftedRows === 1 ? '' : 's'} no longer match the file header and were excluded.` : '';
  return `<h3>Scanner runs — new postings per run</h3>
<div class="hbars" role="img" aria-label="${esc(aria)}">${hbarRows(items, widths)}</div>
<p class="chartnote">${s.totalRuns} runs in <span class="mono">data/scan-runs.tsv</span> — a completed run averages
${s.avgFoundPerRun} found and ${s.avgNewPerRun} added; filters remove ${s.filterRemovalPct}% of what is found.${failed}${drifted}</p>`;
}

/** (h) Hydration reliability — one cell per pipeline stage result in data/alert-log.tsv. */
function chartAlerts(m) {
  if (!m.alerts.length) return '';
  const fails = m.alerts.filter(a => !a.ok);
  const cells = m.alerts.slice(-60).map(a =>
    `<i class="${a.ok ? '' : 'bad'}" title="${esc(`${a.when} ${a.stage}: ${a.result}`)}"></i>`).join('');
  const aria = `${m.alerts.length} hydration pipeline stage results recorded; ${fails.length} failed.`;
  const failRows = fails.slice(-5).map(f =>
    `<tr><td class="mono">${esc(f.when)}</td><td>${esc(f.stage)}</td><td>${esc(f.result)}</td></tr>`).join('');
  return `<h3>Hydration reliability — alert log</h3>
<div class="alertstrip" role="img" aria-label="${esc(aria)}">${cells}</div>
<p class="chartnote">Each cell is one pipeline stage result from <span class="mono">data/alert-log.tsv</span>, oldest to
newest — ${fails.length ? `${fails.length} of ${m.alerts.length} failed.` : `all ${m.alerts.length} passed.`}</p>
${fails.length ? `<table class="mini"><thead><tr><th>When</th><th>Stage</th><th>Result</th></tr></thead><tbody>${failRows}</tbody></table>` : ''}`;
}

/** Repost patterns from scan history — evidence, not a verdict. */
function sectionReposts(m) {
  if (!m.reposts || !m.reposts.scanned || !m.reposts.clusters.length) return '';
  const rows = m.reposts.clusters.slice(0, 15).map(c =>
    `<tr><td>${esc(c.company)}</td><td>${esc(c.role)}</td><td>${c.n}&times;</td><td>${c.span}d</td><td class="mono">${esc(c.last)}</td></tr>`).join('');
  return `<h3>Repost patterns</h3>
<table class="mini"><thead><tr><th>Company</th><th>Role</th><th>Seen</th><th>Span</th><th>Last seen</th></tr></thead><tbody>${rows}</tbody></table>
<p class="chartnote">A posting that keeps reappearing can mean an unfilled req, a rolling pipeline, or ghost
hiring — the count is evidence, not a verdict. Aggregator boards are excluded from detection.</p>`;
}

/** Stage velocity + waiting list, with the right-censoring caveat rendered, not laundered away. */
function sectionVelocity(m) {
  if (!m.velocity) return '';
  const { hops, waiting } = m.velocity;
  const measured = hops.filter(h => !h.insufficientData);
  const censoredTotal = hops.reduce((a, h) => a + h.censored, 0);
  const hopRows = hops.map(h => `<tr><td>${esc(h.from)} &rarr; ${esc(h.to)}</td>
<td>${h.median !== null ? h.median + 'd' : '—'}</td><td>${h.p75 !== null ? h.p75 + 'd' : '—'}</td>
<td>${h.n}</td><td>${h.censored}</td></tr>`).join('');
  const waitRows = waiting.items.slice(0, 10).map(w =>
    `<tr><td>#${esc(String(w.num))}</td><td>${esc(w.company)}</td><td class="mono">${esc(w.appliedDate || 'unknown')}</td>
<td>${w.elapsedDays ?? '—'}</td><td>${w.beyondTypicalWindow ? 'beyond the typical reply window' : ''}</td></tr>`).join('');
  return `<h3>Stage velocity</h3>
${measured.length
    ? `<table class="mini"><thead><tr><th>Hop</th><th>Median</th><th>p75</th><th>n</th><th>Still waiting</th></tr></thead><tbody>${hopRows}</tbody></table>`
    : '<p class="chartnote">No hop has the 3 completed transitions a median needs yet.</p>'}
<p class="chartnote">Medians cover only hops that completed. The ${censoredTotal} application${censoredTotal === 1 ? '' : 's'} still
sitting in a from-state are right-censored — excluded, not resolved — so a fast-looking median can simply mean
the slow cases have not answered yet. Same-day hops are excluded as data-entry artifacts.</p>
<h3>Waiting on a reply</h3>
${waiting.inFlight
    ? `<table class="mini"><thead><tr><th>#</th><th>Company</th><th>Applied</th><th>Days</th><th></th></tr></thead><tbody>${waitRows}</tbody></table>
<p class="chartnote">${waiting.inFlight} in flight; the typical first-response window is ${waiting.windowDays[0]}–${waiting.windowDays[1]} days${waiting.unknownDates ? `; ${waiting.unknownDates} row${waiting.unknownDates === 1 ? '' : 's'} carry no applied date` : ''}.</p>`
    : '<p class="chartnote">Nothing is currently waiting on a reply.</p>'}`;
}

/** Salary trail — advertised vs confirmed, per application and per currency. */
function sectionSalary(m) {
  if (!m.salary) return '';
  const rows = m.salary.applications.map(a =>
    `<tr><td>#${esc(String(a.num))}</td><td>${esc(a.company || '')}</td><td>${esc(a.role || '')}</td>
<td>${a.advertised ? esc(a.advertised.amount) : '—'}</td><td>${a.actual ? esc(a.actual.amount) : '—'}</td>
<td>${a.advToActPct !== null ? (a.advToActPct > 0 ? '+' : '') + a.advToActPct + '%' : '—'}</td></tr>`).join('');
  const cur = Object.entries(m.salary.byCurrency).map(([c, agg]) =>
    `${agg.confirmed} confirmed in ${esc(c)}${agg.medianAdvToActPct !== null ? `, median advertised→actual ${agg.medianAdvToActPct > 0 ? '+' : ''}${Math.round(agg.medianAdvToActPct)}%` : ''}`).join('; ');
  return `<h3>Salary — advertised vs actual</h3>
<table class="mini"><thead><tr><th>#</th><th>Company</th><th>Role</th><th>Advertised</th><th>Actual</th><th>Gap</th></tr></thead><tbody>${rows}</tbody></table>
<p class="chartnote">${cur || 'No confirmed comp yet — the trail fills in as observations land in'}
<span class="mono">data/salary-observations.tsv</span>${m.salary.quality.withoutActual ? ` · ${m.salary.quality.withoutActual} without a confirmed number` : ''}.</p>`;
}

/** Skill gaps the evaluation reports keep naming, minus what the CV already covers. */
function sectionUpskill(m) {
  if (!m.upskill) return '';
  const rows = m.upskill.gaps.map(g =>
    `<tr><td>${esc(g.skill)}</td><td>${esc(g.tier)}</td><td>${g.reports}</td><td>${g.lowFitReports}</td><td>${g.weightedScore}</td></tr>`).join('');
  return `<h3>Skill gaps named by evaluation reports</h3>
<table class="mini"><thead><tr><th>Skill</th><th>Tier</th><th>Reports</th><th>Low-fit</th><th>Weight</th></tr></thead><tbody>${rows}</tbody></table>
<p class="chartnote">Aggregated from the ${m.upskill.reports} evaluation report${m.upskill.reports === 1 ? '' : 's'} the tracker
links; skills already on the CV or profile are excluded. ${m.upskill.totalLowFit} report${m.upskill.totalLowFit === 1 ? '' : 's'} scored below the low-fit line.</p>`;
}

/** Outcome patterns from analyze-patterns.mjs — including its own not-enough-data verdict. */
function sectionPatterns(m) {
  if (!m.patterns) return '';
  if (m.patterns.error) return `<h3>Outcome patterns</h3><p class="chartnote">${esc(m.patterns.error)}</p>`;
  const funnelRows = Object.entries(m.patterns.funnel).map(([st, n]) => `<tr><td>${esc(st)}</td><td>${n}</td></tr>`).join('');
  const recs = m.patterns.recommendations.map(r => `<li><b>${esc(r.impact || '')}</b> ${esc(r.action)}</li>`).join('');
  return `<h3>Outcome patterns</h3>
<table class="mini"><thead><tr><th>Status</th><th>n</th></tr></thead><tbody>${funnelRows}</tbody></table>
${recs ? `<ul class="chartnote">${recs}</ul>` : ''}
<p class="chartnote">From ${m.patterns.total} tracker rows via <span class="mono">analyze-patterns.mjs</span>.</p>`;
}

export function renderHtml(model) {
  // Scraped titles sometimes carry U+FFFD from a lossy decode upstream, and the
  // artifact host refuses a raw one in page source; keep it as an escape.
  const data = JSON.stringify(model).replace(/</g, '\\u003c').replace(/�/g, '\\ufffd');
  // The artifact host supplies its own document skeleton, but the same file is
  // also opened straight off disk, where a browser with no charset declaration
  // guesses windows-1252 and turns every em dash and middot into mojibake.
  return `<meta charset="utf-8">
<title>${model.who.name ? esc(model.who.name[0].toUpperCase() + model.who.name.slice(1)) + ' ' : ''}Corridor Pipeline</title>
<style>
:root{
  --ground:#e9edee; --surface:#f7f9f9; --surface-2:#dfe6e7;
  --line:#c2cdcf; --line-soft:#d6dedf;
  --text:#12242c; --text-2:#4a6068; --text-3:#74898f;
  --accent:#0f6f6b; --accent-soft:#0f6f6b1a;
  --devrel:#7a4fb0; --tcsm:#0f6f6b; --gtm:#a06a1f; --core:#4a6068;
  --fresh:#2c7a51; --recent:#3f7f6d; --aging:#9a7420; --stale:#a04f2a; --none:#8b8b8b;
  --tier-a:#2c7a51; --tier-s:#9a7420; --tier-i:#a04f2a;
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
    --tier-a:#54c98a; --tier-s:#d3a63f; --tier-i:#e0824f;
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
  --tier-a:#54c98a; --tier-s:#d3a63f; --tier-i:#e0824f;
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
.hyd{margin-left:18px;display:inline-flex;align-items:center;gap:6px;letter-spacing:.1em}
.hyd:empty{display:none}
.hyd::before{content:"";width:7px;height:7px;border-radius:50%;background:currentColor;
  box-shadow:0 0 0 3px color-mix(in srgb,currentColor 20%,transparent)}
.hyd.live{color:var(--fresh)} .hyd.missed{color:var(--stale)} .hyd.stale{color:var(--none)}
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
.scrim{position:fixed;inset:0;background:#12242c66;z-index:20}
.drawer{position:fixed;top:0;right:0;bottom:0;width:min(430px,92vw);z-index:21;overflow-y:auto;
  background:var(--surface);border-left:1px solid var(--line);box-shadow:var(--shadow);padding:22px 24px 40px;
  animation:slidein .16s ease-out}
@keyframes slidein{from{transform:translateX(18px);opacity:.4}to{transform:none;opacity:1}}
@media (prefers-reduced-motion:reduce){.drawer{animation:none}}
.dwclose{position:absolute;top:14px;right:16px;background:none;border:1px solid var(--line);color:var(--text-2);
  border-radius:6px;width:28px;height:28px;cursor:pointer;font-size:13px;line-height:1}
.dwclose:hover{border-color:var(--accent);color:var(--text)}
.drawer h2{font-size:15px;margin:0 6px 2px 0;padding-right:34px;line-height:1.35}
.drawer .dwco{font-size:12.5px;color:var(--text-2);margin-bottom:14px}
.drawer h3{font-size:11px;text-transform:uppercase;letter-spacing:.09em;color:var(--text-3);
  margin:22px 0 9px;font-weight:600}
.dwtot{font-family:ui-monospace,monospace;font-size:22px;color:var(--text)}
.dwtot .b{font-size:12px;color:var(--text-2);margin-left:8px;font-family:"Segoe UI",sans-serif}
.dwgate{margin:12px 0 0;padding:9px 11px;border-left:3px solid var(--stale);background:var(--surface-2);
  font-size:12.5px;color:var(--text)}
.lad{display:grid;grid-template-columns:auto 1fr auto;gap:3px 10px;align-items:center;font-size:12px}
.lad .lm{font-family:ui-monospace,monospace;color:var(--text-2);white-space:nowrap}
.lad .lb{height:6px;background:var(--surface-2);border-radius:3px;overflow:hidden}
.lad .lb i{display:block;height:100%;background:var(--accent)}
.lad .lp{font-family:ui-monospace,monospace;color:var(--text-3);font-size:11px;white-space:nowrap}
.lad .lw{grid-column:1/-1;color:var(--text-2);font-size:11.5px;margin:0 0 8px;line-height:1.45}
.lad .lw b{font-weight:600;color:var(--text)}
.dwf{display:grid;grid-template-columns:auto 1fr;gap:5px 14px;font-size:12.5px;margin:0}
.dwf dt{color:var(--text-3)}
.dwf dd{margin:0;color:var(--text)}
.dwlink{display:inline-block;margin-top:20px;font-size:12.5px;color:var(--accent)}
/* The artifact shell intercepts cross-origin clicks and asks its parent for a
   new tab; some viewers (phone / remote control) drop that request, so the
   drawer also prints the URL as selectable text you can long-press and copy. */
.dwurl{margin-top:8px;font-size:11px;line-height:1.5;color:var(--text-3);word-break:break-all;user-select:all;-webkit-user-select:all}
.chip{font-family:"Segoe UI",sans-serif;font-size:12.5px;padding:5px 11px;border:1px solid var(--line);
  border-radius:2px;background:var(--surface);color:var(--text-2);cursor:pointer;
  transition:background .13s,color .13s,border-color .13s}
.chip:hover{border-color:var(--accent);color:var(--text)}
.matchcell{display:block;width:100%;text-align:left;background:none;border:0;padding:0;cursor:pointer;
  font:inherit;color:inherit;border-radius:4px}
.matchcell:hover .cb{color:var(--accent)}
.matchcell:focus-visible{outline:2px solid var(--accent);outline-offset:2px}
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
tr[data-cb=premier]{--bc:var(--fresh)} tr[data-cb=strong]{--bc:var(--recent)}
tr[data-cb=ordinary]{--bc:var(--aging)} tr[data-cb=low]{--bc:var(--none)}
tr[data-cb=blocked]{--bc:var(--stale)} tr[data-cb=blocked] .cb{opacity:.55}
tr[data-cb=blocked] .role a{text-decoration-color:var(--line)}
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

/* ---- mega menu ------------------------------------------------------
   The spine of the page. Every label carries the count of what is behind
   it, so the strip reads as a summary before anything is clicked, and the
   drop panel names the sub-sections with their own counts so a reader knows
   what a tab holds before committing to it. Below 860px the drop panel is
   suppressed and the strip becomes a scrolling tab bar — the counts survive,
   which is the part that carries information. */
.nav{position:sticky;top:0;z-index:10;margin:22px 0 24px;background:var(--ground);
  border-top:1px solid var(--line);border-bottom:1px solid var(--line)}
.tabs{display:flex;gap:0;overflow-x:auto;scrollbar-width:thin}
.tab{position:relative;flex:0 0 auto;display:flex;align-items:baseline;gap:8px;
  font-family:"Segoe UI",sans-serif;font-size:13.5px;font-weight:600;letter-spacing:.01em;
  padding:13px 18px;border:0;border-bottom:2px solid transparent;background:none;
  color:var(--text-2);cursor:pointer;white-space:nowrap;transition:color .13s,border-color .13s}
.tab:hover{color:var(--text)}
.tab[aria-selected="true"]{color:var(--text);border-bottom-color:var(--accent)}
.tab .tn{font-family:"Cascadia Mono",Consolas,ui-monospace,monospace;font-size:11px;
  font-variant-numeric:tabular-nums;color:var(--text-3);font-weight:500}
.tab[aria-selected="true"] .tn{color:var(--accent)}
.mega{position:absolute;left:0;right:0;top:100%;z-index:11;display:none;
  background:var(--surface);border:1px solid var(--line);border-top:0;box-shadow:var(--shadow);
  padding:16px 18px;grid-template-columns:repeat(auto-fit,minmax(190px,1fr));gap:12px 22px}
.navitem{position:static}
.navitem:hover .mega,.navitem:focus-within .mega{display:grid}
.megaitem{display:flex;flex-direction:column;gap:2px;font-family:"Segoe UI",sans-serif}
.megaitem .mk{font-size:12.5px;font-weight:620;color:var(--text)}
.megaitem .mv{font-family:"Cascadia Mono",Consolas,ui-monospace,monospace;font-size:11px;
  font-variant-numeric:tabular-nums;color:var(--text-3)}
.megaitem .md{font-size:11.5px;color:var(--text-2);line-height:1.45}
@media (max-width:860px){.mega{display:none!important}}
.panel[hidden]{display:none}
.panel h2{font-size:17px;margin:0 0 4px;letter-spacing:-.01em}
.panel .lede{color:var(--text-2);max-width:74ch;margin:0 0 18px;font-size:13.5px}
.tier{display:inline-block;font-family:"Segoe UI",sans-serif;font-size:10px;font-weight:680;
  letter-spacing:.09em;text-transform:uppercase;padding:3px 7px;border-radius:2px;
  border:1px solid currentColor;white-space:nowrap}
.tier.authoritative{color:var(--tier-a)} .tier.structural{color:var(--tier-s)}
.tier.indexed{color:var(--tier-i)} .tier.unclassified{color:var(--none)}
.pct{display:block;height:3px;border-radius:2px;background:var(--line);margin-top:5px;width:60px;overflow:hidden}
.pct i{display:block;height:100%;background:var(--accent)}
.card{border:1px solid var(--line);border-radius:3px;background:var(--surface);padding:14px 16px}
.cards{display:grid;grid-template-columns:repeat(auto-fit,minmax(230px,1fr));gap:12px;margin-bottom:20px}
.card h3{margin:0 0 6px;font-family:"Segoe UI",sans-serif;font-size:11px;letter-spacing:.11em;
  text-transform:uppercase;color:var(--text-3);font-weight:650}
.card p{margin:0;font-size:13px;color:var(--text-2);line-height:1.5}
.miniwrap{overflow-x:auto;border:1px solid var(--line);border-radius:3px;background:var(--surface);margin-bottom:22px}
.miniwrap .mini{min-width:640px}
.miniwrap .mini th{background:var(--surface-2);padding:9px 10px}
/* ---- charts ---------------------------------------------------------
   Server-rendered additions to the tables, never replacements. The bar
   rows graduate the one-bar .cbbar/.pct pattern; every fill is a token. */
.chart{margin:0 0 20px}
.chart h3{font-family:"Segoe UI",sans-serif;font-size:12px;letter-spacing:.1em;text-transform:uppercase;
  color:var(--text-3);margin:18px 0 8px;font-weight:650}
.chartnote{color:var(--text-3);font-size:12px;max-width:70ch;margin:6px 0 0}
ul.chartnote{padding-left:18px}
.alertstrip{display:flex;gap:3px;flex-wrap:wrap;margin:8px 0}
.alertstrip i{width:10px;height:14px;border-radius:2px;background:var(--fresh)}
.alertstrip i.bad{background:var(--stale)}
.hbars,.strips{display:grid;grid-template-columns:auto 1fr auto;gap:5px 10px;align-items:center;max-width:640px}
.hbars .hl,.strips .hl{font-family:"Segoe UI",sans-serif;font-size:12px;color:var(--text-2);white-space:nowrap}
.hbars .hb{display:block;height:10px;border-radius:2px;background:var(--line);overflow:hidden}
.hbars .hb i{display:block;height:100%;background:var(--accent)}
.hbars .hn,.strips .hn{font-family:"Cascadia Mono",Consolas,ui-monospace,monospace;font-size:11px;
  font-variant-numeric:tabular-nums;color:var(--text-2);text-align:right}
.strips .strip{display:flex;height:12px;border-radius:2px;overflow:hidden;background:var(--line)}
.strips .strip i{display:block;height:100%}
.strips .sc{grid-column:2/4;font-size:11px;color:var(--text-3);margin:-3px 0 3px}
.legend{display:flex;flex-wrap:wrap;gap:4px 14px;font-size:11px;color:var(--text-2);margin:0 0 8px}
.legend i{display:inline-block;width:9px;height:9px;border-radius:2px;margin-right:5px}
#cbhist{width:100%;max-width:640px;height:auto;display:block}
#cbhist [data-cbband]{cursor:pointer}
#cbhist text{font-family:"Segoe UI",sans-serif}
.spark{width:100%;max-width:220px;height:24px;display:block}
.spark path{fill:none;stroke:var(--accent);stroke-width:1.5;vector-effect:non-scaling-stroke}
@media (prefers-reduced-motion:reduce){*{transition:none!important}}
</style>

<div class="wrap">
<header>
  <div class="eyebrow"><span id="eyebrow"></span><span class="hyd" id="hyd"></span></div>
  <h1>Corridor Pipeline</h1>
  <p class="sub">Every pending posting the scanner has surfaced, classified into role families by the same
  keyword mechanism that admitted it. Generated from <span class="mono">data/pipeline.md</span> — rebuild with
  <span class="mono">node build-artifact.mjs</span>, never by hand.</p>
</header>

<div class="stats" id="stats"></div>

<nav class="nav" aria-label="Sections">
  <div class="tabs" role="tablist" id="tabs"></div>
</nav>

<section class="panel" id="panel-pipeline" role="tabpanel" aria-labelledby="tab-pipeline" tabindex="0">
<div class="bar">
  <div class="group"><div class="glab">Role family</div><div class="chips" id="lanes"></div></div>
  <div class="group"><div class="glab">Match</div><div class="chips" id="cbbands"></div></div>
  <div class="group"><div class="glab">Corridor segment</div><div class="chips" id="segs"></div></div>
  <div class="group"><div class="glab">Coverage</div><div class="chips" id="cov"></div></div>
  <div class="group"><div class="glab">Posting age</div><select id="fsel"></select></div>
  <div class="group"><div class="glab">Company</div>
    <input list="colist" id="co" placeholder="Any company" aria-label="Filter by company"><datalist id="colist"></datalist></div>
  <div class="group"><div class="glab">Search</div>
    <input type="search" id="q" placeholder="Company, role, keyword" aria-label="Search postings"></div>
</div>

<div class="tablewrap">
<table>
  <thead><tr>
    <th class="sortable" data-k="cb" style="padding-left:15px">Match<span class="car">▼</span></th>
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
</section>

<section class="panel" id="panel-channels" role="tabpanel" aria-labelledby="tab-channels" tabindex="0" hidden>
  <h2>Ingestion channels</h2>
  <p class="lede">How much each channel that feeds this pipeline can be believed. The tier is not a ranking of
  how good the board is — it records what the channel's own API can prove when a posting disappears. Every
  number here is folded from <span class="mono">data/scan-history.tsv</span>,
  <span class="mono">data/portal-health.tsv</span> and <span class="mono">portals.yml</span> at build time; none
  of it is typed in.</p>
  <div class="chart">${chartSparklines(model)}${chartHeatmap(model)}</div>
  <div id="chanbody"></div>
  ${chartRuns(model)}${chartAlerts(model)}
</section>

<section class="panel" id="panel-scoring" role="tabpanel" aria-labelledby="tab-scoring" tabindex="0" hidden>
  <h2>Scoring model</h2>
  <p class="lede">What the match number is made of, which rules can zero a row, and whether any of it has been
  checked against a real reply yet.</p>
  <div class="chart">${chartHistogram(model)}${chartAgeStrips(model)}</div>
  <div id="scoringbody"></div>
  <footer>
    <p><b>What the match number is.</b> <span class="mono">100 × eligibility × fit × timing</span>, out of 100.
    <b>Eligibility</b> is 0 or 1 — a TS/SCI or polygraph requirement, a years-of-experience floor above 8, a
    required doctorate, or an advertised ceiling under the walk-away makes the row a 0. <b>Fit</b> is how many
    of the three hats the description demands — designer, developer, AI advocate — modulated by named
    frameworks, clearance advantage, degree demand, seniority and title family. <b>Timing</b> only discounts:
    freshness, applicant pool, employer volume, repost pattern. Hover any score to see every multiplier.</p>
    <p><b>A 0 is not a hidden row.</b> Gated postings stay in place, stay linked, and name the rule that killed
    them, so a rule that starts eating good reqs is visible on the page that applied it. Fit in the A–G sense is
    still scored separately and downstream; this number decides what is worth reading, not what is worth doing.</p>
    <p><b>Facts come from the description.</b> <span class="mono">node enrich-jd.mjs</span> fetches each posting
    once, caches it, and reduces it to <span class="mono">data/jd-facts.tsv</span>. A posting whose description
    could not be read is scored on its title family alone, capped below any confirmed two-hat match, and says so
    in its own tooltip — a guess never outranks a fact.</p>
    <p><b>It is a prior, not a prediction.</b> The weights are hand-set, not trained on outcomes. They stay
    honest only once <span class="mono">data/applications.md</span> carries replies — the panel below reports
    the observed reply rate per band as soon as there is one.</p>
    <p><b>No protected characteristic is an input</b>, and none is inferable from one. The score reads the
    posting's own text and the profile's own stated targets, clearances and comp floor. Location is used as a
    proxy for how many people are competing for the req, never as a statement about any applicant.</p>
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
</section>

<section class="panel" id="panel-coverage" role="tabpanel" aria-labelledby="tab-coverage" tabindex="0" hidden>
  <h2>Coverage</h2>
  <p class="lede">What the scanner caught, what it dropped, and what it has since confirmed gone. A keyword
  with no unique hits can be deleted without losing a posting.</p>
  <div class="chart">${chartFunnel(model)}${chartCompanies(model)}</div>
  <div id="covbody"></div>
  ${sectionReposts(model)}
</section>

<section class="panel" id="panel-outcomes" role="tabpanel" aria-labelledby="tab-outcomes" tabindex="0" hidden>
  <h2>Outcomes</h2>
  <p class="lede">What happened after applying — how fast stages move, what comp the trail confirms, and which
  gaps the evaluation reports keep naming. Everything here is folded from the tracker and its side files at
  build time; a section with nothing to say is absent, not zeroed.</p>
  ${sectionVelocity(model)}${sectionSalary(model)}${sectionUpskill(model)}${sectionPatterns(model)}
  ${!model.velocity && !model.salary && !model.upskill && !model.patterns ? '<p class="chartnote">Nothing to report yet — this panel fills in as applications and evaluations land.</p>' : ''}
</section>

<section class="panel" id="panel-profile" role="tabpanel" aria-labelledby="tab-profile" tabindex="0" hidden>
  <h2>Whose search this is</h2>
  <p class="lede">The targeting that scored every row on this page. A posting is here because it matched one of
  these archetypes or one of these lanes; a posting that matched neither belongs to someone else's page.</p>
  <div id="profbody"></div>
</section>

<div class="scrim" id="scrim" hidden></div>
<aside class="drawer" id="drawer" hidden role="dialog" aria-modal="true" aria-labelledby="dwtitle" tabindex="-1">
  <button class="dwclose" id="dwclose" aria-label="Close details">&#10005;</button>
  <div id="dwbody"></div>
</aside>



</div>

<script>
const M = ${data};
const LC = {devrel:'var(--devrel)',tcsm:'var(--tcsm)',gtm:'var(--gtm)',core:'var(--core)'};
// lanes.yml is user layer and holds ten lanes today, but only the original four
// have a named token. Anything else got var(--core) — six lanes rendering as the
// same grey, which is the column declining to say anything. Give every unnamed
// lane a hue spaced around the wheel and emit its row-stripe rules here: the
// stylesheet cannot know the lane ids in advance. The dark tone is lighter
// because a 42% lightness disappears against the dark ground exactly as the grey did.
{
  const extra = M.lanes.map(l => l.id).filter(id => !LC[id]);
  const hue = i => Math.round((i * 360) / Math.max(extra.length, 1) + 18) % 360;
  extra.forEach((id, i) => { LC[id] = \`hsl(\${hue(i)} 46% 42%)\`; });
  const rules = (sel, light) => extra
    .map((id, i) => \`\${sel}tr[data-lane=\${id}]{--lc:hsl(\${hue(i)} \${light ? '46% 42%' : '52% 66%'})}\`)
    .join('\\n');
  const s = document.createElement('style');
  s.textContent = [
    rules('', true),
    \`@media (prefers-color-scheme: dark){\${rules(':root:not([data-theme="light"]) ', false)}}\`,
    rules(':root[data-theme="dark"] ', false),
  ].join('\\n');
  document.head.appendChild(s);
}
${hydrationState.toString()}
const PAGE = 200;
const el = id => document.getElementById(id);
const esc = s => String(s ?? '').replace(/[&<>"]/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c]));
const rows = M.rows;

el('eyebrow').textContent =
  \`Generated \${M.generated} · \${rows.length} pending · \${new Set(rows.map(r=>r.c)).size} companies · scan window \${M.maxAge}d\`;

const HYD_LABEL = { live: 'hydrated for this view', missed: 'hydration did not fire', stale: 'stale hydration' };
const hyd = hydrationState(M.built, new Date());
el('hyd').className = 'hyd ' + hyd;
el('hyd').textContent = HYD_LABEL[hyd];
el('hyd').title = M.built
  ? 'Last build ' + new Date(M.built).toLocaleString() + '. Hydration runs 07:00 and 19:00.'
  : 'This page carries no build stamp.';

const dated = rows.filter(r => r.age !== null).map(r => r.age).sort((a,b)=>a-b);
el('stats').innerHTML = [
  [rows.length, 'Pending'],
  [rows.filter(r=>r.cbBand==='premier'||r.cbBand==='strong').length, 'Match ≥42'],
  [M.jd.gated, 'Gated to 0'],
  [M.jd.read, 'Descriptions read'],
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
const mults = m => (m === 0 ? 'BLOCKED' : '×' + (Math.round(m*100)/100).toFixed(2));
rows.forEach((r,i) => { r.i = i; });

function whyText(r){
  return 'Match ' + r.cb + '/100 — ' + bandLabel(r.cbBand) + '\\n'
    + (r.why||[]).map(w=>\`\${mults(w.mult).padEnd(8)}\${SIGLAB[w.id]||w.id}: \${w.why}\`).join('\\n')
    + (r.gate ? '\\n\\nGated to 0 and left visible on purpose — check the rule if this looks wrong.'
              : '\\n\\nPrior, not a verdict. Every posting stays applicable.');
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
    (!state.unread || !r.f) &&
    (state.showBlocked || state.cbband === 'blocked' || r.cbBand !== 'blocked') &&
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
    <td class="stripe" style="padding-left:12px">
      <button class="matchcell" data-i="\${r.i}" aria-label="\${esc(whyText(r))}" aria-haspopup="dialog">
      <span class="cb">\${r.cb}</span>
      <div class="cbbar"><i style="width:\${r.cb}%"></i></div>
      <span class="cbband">\${esc(bandLabel(r.cbBand))}</span></button></td>
    <td>\${r.score!==null?\`<span class="score">\${r.score.toFixed(1)}</span><br>\`:''}<span class="st">\${esc(r.status)}</span></td>
    <td class="role"><a href="\${esc(r.u)}" rel="noopener"><span class="co">\${esc(r.c)}</span> — \${esc(r.t)}</a>
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
el('cov').innerHTML = [
  ['unread', 'Description unread', rows.filter(r=>!r.f).length, 'title-only scoring: the posting could not be fetched'],
  ['blocked', 'Blocked rows', rows.filter(r=>r.cbBand==='blocked').length,
    'hidden by default — ' + M.jd.gates.map(g=>g.n+' '+g.reason).join(' · ')],
].filter(c=>c[2]).map(([id,label,n,tip]) =>
  \`<button class="chip" data-cov="\${id}" aria-pressed="false" title="\${esc(tip)}">\${label}<span class="n">\${n}</span></button>\`
).join('');
el('cov').addEventListener('click', e => {
  const b = e.target.closest('[data-cov]');
  if (!b) return;
  const k = b.getAttribute('data-cov') === 'unread' ? 'unread' : 'showBlocked';
  state[k] = !state[k];
  b.setAttribute('aria-pressed', String(state[k]));
  limit = PAGE; render();
});

toggler('lanes','lane','data-lane');
toggler('segs','seg','data-seg');
toggler('cbbands','cbband','data-cbband');
// One drawer, reused. The row link still opens the posting; only the Match
// cell opens this, so a click on the role never gets hijacked.
const FACTLAB = {
  yoe: 'Years demanded', degree: 'Degree', clearance: 'Clearance',
  comp_low: 'Comp floor', comp_high: 'Comp ceiling', remote: 'Onsite policy',
  hats: 'Hats demanded', frameworks: 'Frameworks named',
};
const money = v => '$' + Math.round(Number(v)/1000) + 'K';
let lastTrigger = null;

function openDrawer(r){
  let run = 1;
  const lad = (r.why||[]).map(w => {
    run *= w.mult;
    const pct = Math.min(100, Math.round(Math.min(w.mult,1.1)/1.1*100));
    return \`<span class="lm">\${mults(w.mult)}</span>
      <span class="lb"><i style="width:\${w.mult===0?100:pct}%;background:\${w.mult===0?'var(--stale)':w.mult>1?'var(--fresh)':'var(--accent)'}"></i></span>
      <span class="lp">\${w.mult===0?'0':Math.round(run*100)}</span>
      <span class="lw"><b>\${esc(SIGLAB[w.id]||w.id)}</b> — \${esc(w.why)}</span>\`;
  }).join('');
  const f = r.f || {};
  const facts = Object.keys(f).length
    ? Object.entries(f).map(([k,v]) => \`<dt>\${esc(FACTLAB[k]||k)}</dt><dd>\${esc(
        k === 'comp_low' || k === 'comp_high' ? money(v) : String(v).replace(/,/g,', '))}</dd>\`).join('')
    : '<dt>—</dt><dd>No description was read; this row is scored on its title alone.</dd>';
  // Company history card (build-time company-history.mjs join); absent = no block.
  const ch = (M.companyCards || {})[r.c];
  const CHLAB = { 'silent-on-you': 'Silent on you', 'responded-before': 'Responded before', 'mixed': 'Mixed replies', 'no-history': 'No history' };
  const CHURNLAB = { 'reposts-detected': 'Reposts detected', 'none-detected': 'None detected', 'no-scan-data': 'No scan data', 'aggregator-not-evaluated': 'Aggregator — not evaluated' };
  let chBlock = '';
  if (ch) {
    const cl = (ch.clusters || []).map(c => '<br>' + esc(c.role) + ' — seen ' + c.repostCount + '&times; over ' + c.daysSpan + ' days').join('');
    chBlock = '<h3>Company history</h3><dl class="dwf">'
      + '<dt>Responsiveness</dt><dd>' + esc(CHLAB[ch.resp] || ch.resp) + (ch.respDays != null ? ' · median reply ' + ch.respDays + 'd' : '') + '</dd>'
      + '<dt>Posting churn</dt><dd>' + esc(CHURNLAB[ch.churn] || ch.churn) + cl + '</dd></dl>'
      + (ch.notes || []).map(n => '<p class="chartnote">' + esc(n) + '</p>').join('');
  }
  el('dwbody').innerHTML = \`
    <h2 id="dwtitle">\${esc(r.t)}</h2>
    <div class="dwco">\${esc(r.c)} · \${esc(r.l) || 'no location published'} · \${r.age===null?'age unknown':r.age+' days old'}</div>
    <div class="dwtot">\${r.cb}<span class="b">/ 100 · \${esc(bandLabel(r.cbBand))}</span></div>
    \${r.gate ? \`<p class="dwgate"><b>Gated to 0:</b> \${esc(r.gate)}. The row stays visible and stays applicable — check the rule if this looks wrong.</p>\` : ''}
    <h3>How the number was reached</h3>
    <div class="lad">\${lad}</div>
    <h3>Classification</h3>
    <dl class="dwf">
      <dt>Title family</dt><dd>\${esc(r.family || '—')}</dd>
      <dt>Lane keywords</dt><dd>\${(r.kw||[]).length ? r.kw.map(k=>'<span class="kw">'+esc(k)+'</span>').join(' ') : '—'}</dd>
      <dt>Ingestion portal</dt><dd>\${esc(r.portal) || '—'}</dd>
    </dl>
    \${chBlock}
    <h3>What the description said</h3>
    <dl class="dwf">\${facts}</dl>
    <a class="dwlink" href="\${esc(r.u)}" rel="noopener">Open the posting ↗</a>
    <div class="dwurl" title="Tap and hold to copy">\${esc(r.u)}</div>\`;
  el('scrim').hidden = false;
  el('drawer').hidden = false;
  el('drawer').focus();
}
function closeDrawer(){
  el('drawer').hidden = true;
  el('scrim').hidden = true;
  if (lastTrigger && document.contains(lastTrigger)) lastTrigger.focus();
  lastTrigger = null;
}
el('rows').addEventListener('click', e => {
  const b = e.target.closest('.matchcell');
  if (!b) return;
  lastTrigger = b;
  openDrawer(rows[Number(b.getAttribute('data-i'))]);
});
el('scrim').addEventListener('click', closeDrawer);
el('dwclose').addEventListener('click', closeDrawer);
document.addEventListener('keydown', e => {
  if (e.key === 'Escape' && !el('drawer').hidden) closeDrawer();
});

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
el('scoringbody').innerHTML = \`
<h3>Match rubric — 100 × eligibility × fit × timing</h3>
<p style="color:var(--text-2);font-size:13px;margin:0 0 10px">
  Every signal is a multiplier, so the score is a product and not a sum. <b>Eligibility</b> is the only
  one that can be zero. <b>Fit</b> is what the description demands of you; <b>timing</b> only ever
  discounts, so no amount of freshness or geography can manufacture a match that the description does
  not support.</p>
<table class="mini"><thead><tr><th>Signal</th><th class="num">Range</th><th>What it reads</th></tr></thead><tbody>
\${M.signals.map(s=>\`<tr><td>\${esc(s.label)}</td><td class="num mono">\${esc(s.range||'')}</td><td style="color:var(--text-3);font-size:12px">\${esc(s.reads||'')}</td></tr>\`).join('')}
</tbody></table>
<h3>Gate accounting — \${M.jd.gated} of \${M.rows.length} rows scored 0</h3>
<p style="color:var(--text-2);font-size:13px;margin:0 0 10px">
  A gate is a rule, and a rule that starts eating good reqs should be visible on the page that applied
  it. Descriptions read: <b>\${M.jd.read}</b> of \${M.rows.length}. The rest are scored on their title
  family alone and say so in their own tooltip.</p>
<table class="mini"><thead><tr><th>Rule that fired</th><th class="num">Rows</th></tr></thead><tbody>
\${M.jd.gates.map(g=>\`<tr><td>\${esc(g.reason)}<span class="pct" role="img" aria-label="\${g.n} of \${M.jd.gated} gated rows fell to this rule"><i style="width:\${g.w||0}%"></i></span></td><td class="num">\${g.n}</td></tr>\`).join('') || '<tr><td colspan="2">none</td></tr>'}
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
\`;

// ---- coverage panel -------------------------------------------------
el('covbody').innerHTML = \`
<p style="color:var(--text-2);font-size:13px;margin:0 0 10px"><b>\${M.processed}</b> rows already processed — checked off in data/pipeline.md and out of the pending table.</p>
<h3>Keyword yield — \${y.length} positives against \${M.historyAdded} scanner-added postings</h3>
<p style="color:var(--text-2);font-size:13px;margin:0 0 10px">
  <b>Unique</b> is the count only that keyword caught. A keyword with zero unique hits can be deleted
  without losing a posting; a keyword whose unique sample reads like an unrelated job is matching as a
  substring. Sorted lowest yield first.</p>
<table class="mini"><thead><tr><th>Keyword</th><th class="num">Added</th><th class="num">Unique</th><th class="num">Pending</th><th>Only this keyword caught</th></tr></thead><tbody>
\${y.map(k=>\`<tr class="\${k.added===0?'zero':''}"><td class="mono">\${esc(k.keyword)}</td><td class="num">\${k.added}</td><td class="num">\${k.unique}</td><td class="num">\${k.pending}</td><td style="color:var(--text-3);font-size:12px">\${esc(k.sample)}</td></tr>\`).join('')}
</tbody></table>
\${M.dead.length ? '<p style="color:var(--text-2);font-size:13px;margin:10px 0 0"><b>' + M.dead.length + ' dead keyword' + (M.dead.length === 1 ? '' : 's') + '</b> — matching no pending row this build: ' + M.dead.map(k => '<span class="kw">' + esc(k) + '</span>').join(' ') + '</p>' : ''}
<h3>Pruned from the pipeline — \${M.discards.length} postings</h3>
<table class="mini"><thead><tr><th>When</th><th>Posting</th><th>Reason</th></tr></thead><tbody>
\${M.discards.slice(-15).reverse().map(d=>\`<tr><td class="mono" style="white-space:nowrap">\${esc((d.ts||'').slice(0,10))}</td><td class="mono" style="font-size:11px;word-break:break-all"><a href="\${esc(d.url)}" rel="noopener" style="color:var(--accent)">\${esc(d.url)}</a></td><td style="font-size:12px">\${esc(d.reason)}</td></tr>\`).join('') || '<tr><td colspan="3">none</td></tr>'}
</tbody></table>
<h3>Retired postings — \${M.expired.count} confirmed gone</h3>
<table class="mini"><thead><tr><th>Removed (est.)</th><th>Evidence</th><th>Company</th><th>Title</th></tr></thead><tbody>
\${M.expired.rows.slice(0,10).map(r=>\`<tr><td class="mono" style="white-space:nowrap">\${esc(r.removed)}</td><td class="mono" style="font-size:12px">\${esc(r.evidence)}</td><td>\${esc(r.company)}</td><td style="font-size:12px">\${esc(r.title)}</td></tr>\`).join('') || '<tr><td colspan="4">none</td></tr>'}
</tbody></table>\`;

// ---- channels panel -------------------------------------------------
// Ingestion trust, rendered from the same evidence check-liveness reasons over.
const CH = M.channels;
const TIERLAB = {
  authoritative: 'Authoritative', structural: 'Structural',
  indexed: 'Indexed', unclassified: 'Unclassified',
};
const pctbar = n => \`<span class="pct"><i style="width:\${n}%"></i></span>\`;
el('chanbody').innerHTML = \`
<div class="cards">\${CH.tiers.map(t => \`<div class="card">
  <h3><span class="tier \${t.tier}">\${TIERLAB[t.tier] || t.tier}</span></h3>
  <p><b>\${t.rows}</b> of \${CH.total} rows (\${t.pct}%) across \${t.channels} channel\${t.channels === 1 ? '' : 's'}.
  \${t.dated} carry a posted date; \${t.flagged} carry a trust flag.</p>
  <p style="margin-top:8px;color:var(--text-3);font-size:12px">\${esc(t.note)}</p>
</div>\`).join('')}</div>
<h3>Every channel that has produced a row</h3>
<p style="color:var(--text-2);font-size:13px;margin:0 0 10px">
  <b>Dated</b> is the honest reliability signal: a channel that publishes no posted date bypasses
  <span class="mono">max_posting_age_days</span> entirely, so nothing it contributes can ever be aged out.
  <b>Rung 1</b> is the share whose URL a free ATS API can settle without a browser. <b>Reachable</b> counts
  this channel's companies that answered at the last health probe — a channel whose companies were never
  probed reports 0 / 0 rather than a reassuring zero.</p>
<table class="mini"><thead><tr>
  <th>Channel</th><th>Tier</th><th class="num">Rows</th><th class="num">Cos.</th>
  <th class="num">Dated</th><th class="num">Rung 1</th><th class="num">Flagged</th>
  <th class="num">Reachable</th><th>Config</th></tr></thead><tbody>
\${CH.channels.map(c => \`<tr>
  <td class="mono">\${esc(c.portal)}</td>
  <td><span class="tier \${c.tier}">\${TIERLAB[c.tier] || c.tier}</span></td>
  <td class="num">\${c.rows}</td>
  <td class="num">\${c.companies}</td>
  <td class="num">\${c.datedPct}%\${pctbar(c.datedPct)}</td>
  <td class="num">\${c.rung1Pct}%\${pctbar(c.rung1Pct)}</td>
  <td class="num">\${c.flagged || '—'}</td>
  <td class="num">\${c.probed ? c.reachable + ' / ' + c.probed : '—'}</td>
  <td style="font-size:12px;color:var(--text-3)">\${c.configured ? c.configured + ' entr' + (c.configured === 1 ? 'y' : 'ies') : 'company list'}\${c.aggregator ? ' · aggregator' : ''}</td>
</tr>\`).join('')}
</tbody></table>
<h3>Trust flags — \${CH.flags.reduce((a, f) => a + f.n, 0)} raised across \${CH.total} rows</h3>
<p style="color:var(--text-2);font-size:13px;margin:0 0 10px">
  A flag is a penalty, not a rejection: <span class="mono">providers/_trust-validator.mjs</span> never drops a
  posting for one. <span class="mono">company_domain_mismatch</span> costs 15 points, taking an otherwise clean
  row to 85 and the <b>medium</b> band — which is what an indexed channel republishing someone else's posting
  should score, and why the count tracks the indexed row count so closely.</p>
<table class="mini"><thead><tr><th>Flag</th><th class="num">Rows</th></tr></thead><tbody>
\${CH.flags.map(f => \`<tr><td class="mono">\${esc(f.flag)}</td><td class="num">\${f.n}</td></tr>\`).join('') || '<tr><td colspan="2">none</td></tr>'}
</tbody></table>\`;

// ---- profile panel --------------------------------------------------
const W = M.who;
el('profbody').innerHTML = \`
<div class="cards">
  <div class="card"><h3>Candidate</h3><p><b>\${esc(W.label)}</b>\${W.location ? '<br>' + esc(W.location) : ''}</p></div>
  <div class="card"><h3>Primary targets</h3><p>\${W.primary.length ? W.primary.map(p => esc(p)).join(' · ') : 'none declared'}</p>
    <p style="margin-top:8px;color:var(--text-3);font-size:12px">A title containing one of these scores as a primary-family match.</p></div>
  <div class="card"><h3>Compensation floor</h3><p>\${W.floor ? '<b>' + esc(W.floor) + (W.currency ? ' ' + esc(W.currency) : '') + '</b>' : 'not set'}\${W.target ? '<br>target ' + esc(W.target) : ''}</p>
    <p style="margin-top:8px;color:var(--text-3);font-size:12px">An advertised ceiling under this floor gates the row to 0.</p></div>
  <div class="card"><h3>Sources scanned</h3><p><b>\${W.companies}</b> companies · <b>\${W.boards}</b> job boards</p></div>
  \${M.projection ? \`<div class="card"><h3>Projection</h3><p><b>\${M.projection.kept}</b> kept · <b>\${M.projection.dropped}</b> dropped</p>
    <p style="margin-top:8px;color:var(--text-3);font-size:12px">Dropped rows matched none of the archetypes or lanes below. They belong to another profile's page, not to this one.</p></div>\` : ''}
</div>
<h3>Target roles</h3>
<p style="color:var(--text-2);font-size:13px;margin:0 0 10px">
  The title decides the family and the lane is only the fallback. A posting whose title matches one of these
  archetypes carries that archetype's family; one that matches none of them, in none of the lanes below, is
  not this profile's row at all.</p>
<table class="mini"><thead><tr><th>Archetype</th><th>Level</th><th>Fit</th></tr></thead><tbody>
\${W.archetypes.map(a => \`<tr><td>\${esc(a.name)}</td><td style="color:var(--text-3);font-size:12px">\${esc(a.level)}</td><td style="color:var(--text-3);font-size:12px">\${esc(a.fit)}</td></tr>\`).join('') || '<tr><td colspan="3">none declared</td></tr>'}
</tbody></table>
<h3>Lanes</h3>
<table class="mini"><thead><tr><th>Lane</th><th>What it collects</th><th class="num">Pending</th><th class="num">Eval cap</th></tr></thead><tbody>
\${M.lanes.map(l => \`<tr><td><span class="lanetag" style="--lc:\${LC[l.id] || 'var(--core)'}">\${l.id}</span></td><td>\${esc(l.label)}</td><td class="num">\${rows.filter(r => r.lane === l.id).length}</td><td class="num">\${l.max ?? '—'}</td></tr>\`).join('')}
</tbody></table>\`;

// ---- the mega menu --------------------------------------------------
// Panels are already in the DOM and merely hidden, so a tab switch costs no
// render and the browser's own find-in-page still reaches every panel that is
// open. The count on each label is the point of the menu: the strip states
// magnitudes before anything is clicked.
const unknownAge = rows.filter(r => r.age === null).length;
const TABS = [
  { id: 'pipeline', label: 'Pipeline', n: rows.length + ' pending', mega: [
    ...M.lanes.map(l => ({ k: l.id, v: rows.filter(r => r.lane === l.id).length + ' pending', d: l.label })),
    { k: 'Unread descriptions', v: rows.filter(r => !r.f).length + ' rows', d: 'scored on the title alone' },
    { k: 'Unknown age', v: unknownAge + ' rows', d: 'the board published no posted date' },
  ] },
  { id: 'channels', label: 'Channels', n: CH.channels.length + ' live', mega:
    CH.tiers.map(t => ({ k: TIERLAB[t.tier] || t.tier, v: t.channels + ' channels · ' + t.rows + ' rows', d: t.note })) },
  { id: 'scoring', label: 'Scoring', n: M.signals.length + ' signals', mega: [
    { k: 'Match rubric', v: M.signals.length + ' multipliers', d: '100 × eligibility × fit × timing' },
    { k: 'Gate accounting', v: M.jd.gated + ' rows at 0', d: 'the rules that zeroed a row, named' },
    { k: 'Descriptions read', v: M.jd.read + ' of ' + M.rows.length, d: 'the rest score on their title family' },
    { k: 'Calibration', v: M.calibration.length ? M.calibration.length + ' bands' : 'none yet', d: 'observed reply rate per band' },
  ] },
  { id: 'coverage', label: 'Coverage', n: M.discards.length + ' pruned', mega: [
    { k: 'Keyword yield', v: M.yields.length + ' positives', d: 'against ' + M.historyAdded + ' scanner-added postings' },
    { k: 'Zero-yield keywords', v: M.yields.filter(k => k.added === 0).length + ' deletable', d: 'caught nothing the others did not' },
    { k: 'Pruned', v: M.discards.length + ' postings', d: 'dropped from the pipeline, with the reason' },
    { k: 'Retired', v: M.expired.count + ' confirmed gone', d: 'liveness proved the posting was removed' },
  ] },
  { id: 'outcomes', label: 'Outcomes', n: (M.velocity ? M.velocity.waiting.inFlight : 0) + ' in flight', mega: [
    { k: 'Stage velocity', v: (M.velocity ? M.velocity.hops.filter(h => !h.insufficientData).length : 0) + ' hops measured', d: 'median days per stage transition' },
    { k: 'Waiting on replies', v: (M.velocity ? M.velocity.waiting.inFlight : 0) + ' applications', d: 'in flight, longest silence first' },
    { k: 'Salary trail', v: M.salary ? M.salary.applications.length + ' tracked' : 'none yet', d: 'advertised vs confirmed comp' },
    { k: 'Skill gaps', v: M.upskill ? M.upskill.gaps.length + ' named' : 'none yet', d: 'aggregated from evaluation reports' },
  ] },
  { id: 'profile', label: 'Profile', n: W.archetypes.length + ' archetypes', mega: [
    { k: esc(W.label), v: W.location || 'location not set', d: 'whose targeting scored this page' },
    { k: 'Comp floor', v: W.floor ? String(W.floor) : 'not set', d: 'an advertised ceiling below it gates the row' },
    { k: 'Sources', v: W.companies + ' companies · ' + W.boards + ' boards', d: 'what the scanner is pointed at' },
    ...(M.projection ? [{ k: 'Projection', v: M.projection.dropped + ' dropped', d: 'rows matching no archetype or lane here' }] : []),
  ] },
];

el('tabs').innerHTML = TABS.map(t => \`<div class="navitem">
  <button class="tab" role="tab" id="tab-\${t.id}" aria-controls="panel-\${t.id}" aria-selected="false" tabindex="-1">
    \${esc(t.label)}<span class="tn">\${esc(t.n)}</span></button>
  <div class="mega">\${t.mega.map(m => \`<div class="megaitem">
    <span class="mk">\${m.k}</span><span class="mv">\${esc(m.v)}</span><span class="md">\${esc(m.d)}</span></div>\`).join('')}</div>
</div>\`).join('');

function selectTab(id, focus) {
  const t = TABS.find(x => x.id === id) ? id : TABS[0].id;
  for (const x of TABS) {
    const btn = el('tab-' + x.id), panel = el('panel-' + x.id), on = x.id === t;
    btn.setAttribute('aria-selected', String(on));
    btn.tabIndex = on ? 0 : -1;
    panel.hidden = !on;
    if (on && focus) btn.focus();
  }
  if (location.hash.slice(1) !== t) history.replaceState(null, '', '#' + t);
}
el('tabs').addEventListener('click', e => {
  const b = e.target.closest('.tab');
  if (b) selectTab(b.id.slice(4), false);
});
el('tabs').addEventListener('keydown', e => {
  const i = TABS.findIndex(x => x.id === document.activeElement.id.slice(4));
  if (i < 0) return;
  const step = e.key === 'ArrowRight' ? 1 : e.key === 'ArrowLeft' ? -1 : 0;
  if (step) { e.preventDefault(); selectTab(TABS[(i + step + TABS.length) % TABS.length].id, true); }
  else if (e.key === 'Home') { e.preventDefault(); selectTab(TABS[0].id, true); }
  else if (e.key === 'End') { e.preventDefault(); selectTab(TABS[TABS.length - 1].id, true); }
});
addEventListener('hashchange', () => selectTab(location.hash.slice(1), false));
selectTab(location.hash.slice(1), false);

// The histogram's band regions drive the SAME filter as the Match chips:
// forward the click to the chip so state.cbband, aria-pressed and the render
// all go through the one existing code path, then show the filtered table.
const hist = document.getElementById('cbhist');
if (hist) hist.addEventListener('click', e => {
  const band = e.target.closest('[data-cbband]');
  if (!band) return;
  const chip = document.querySelector('#cbbands [data-cbband="' + band.getAttribute('data-cbband') + '"]');
  if (chip) { chip.click(); selectTab('pipeline', false); }
});

// Every generated table gets its own horizontal scroll container, so a wide
// table scrolls inside itself and the page body never scrolls sideways.
for (const t of document.querySelectorAll('.panel .mini')) {
  if (t.parentElement.classList.contains('miniwrap')) continue;
  const w = document.createElement('div');
  w.className = 'miniwrap';
  t.replaceWith(w);
  w.appendChild(t);
}

render();
</script>
`;
}

async function main(argv) {
  // --root points the whole build at another user layer (see profiles.mjs). It is
  // the only argument buildModel already understood; main just never exposed it.
  const rootIdx = argv.indexOf('--root');
  const root = rootIdx >= 0 ? resolve(argv[rootIdx + 1]) : ROOT;
  // --as-profile is the other half of that split: the data still comes from
  // `root`, but the targeting that scores it comes from the named profile, and
  // rows matching none of that profile's roles are dropped. One scan, N views.
  const asIdx = argv.indexOf('--as-profile');
  const profileName = asIdx >= 0 ? argv[asIdx + 1] : null;
  const profileRoot = profileName ? profileDir(profileName) : null;
  const outIdx = argv.indexOf('--out');
  const defaultOut = profileName ? `pipeline-${profileName}.html` : 'pipeline-artifact.html';
  const out = outIdx >= 0 ? argv[outIdx + 1] : join(root, 'output', defaultOut);
  // company-history's status-log source is async; buildModel must stay sync
  // (build-hub.mjs imports it), so the CLI pre-loads the source and passes it in.
  const statusLog = await loadStatusLogSource();
  const model = buildModel({ root, profileRoot, profileName, statusLog });
  const html = renderHtml(model);
  writeFileSync(resolve(out), html);
  const laneCounts = model.lanes.map(l => `${l.id}=${model.rows.filter(r => r.lane === l.id).length}`).join(' ');
  console.log(`${out} — ${model.rows.length} pending (${laneCounts}), ${Math.round(html.length / 1024)}KB`);
}

if (isMainModule(import.meta.url)) main(process.argv.slice(2));
