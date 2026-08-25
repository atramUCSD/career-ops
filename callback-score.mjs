#!/usr/bin/env node
/**
 * callback-score.mjs — deterministic 0-100 rank for a pending posting.
 *
 * WHAT THIS IS
 * How much of THIS job is the job the profile is looking for, discounted by
 * whether applying is still worth the keystrokes. It runs at build time over
 * every pending row, costs nothing, and calls no model.
 *
 *     score = 100 x eligibility x fit x timing
 *
 *   eligibility  0 or 1. A hard stop — a clearance that cannot be obtained, a
 *                years-of-experience floor far above the profile, a doctorate,
 *                comp under the walk-away — makes the row a zero. It still
 *                renders, still links, and names the gate that killed it, so a
 *                bad rule is visible instead of silently eating good reqs.
 *   fit          How much of the target this actually is. Driven by which of
 *                the three hats the description demands (designer / developer /
 *                AI advocate), then modulated by named frameworks, clearance
 *                advantage, degree demand, seniority, and title family.
 *   timing       [0.55, 1]. Freshness, applicant pool, employer volume, repost
 *                pattern. These can discount a good match; they can no longer
 *                manufacture one.
 *
 * WHY IT WAS REBUILT (2026-08-23)
 * The previous version was `50 + sum(eight signals)`, and six of those eight
 * described the posting rather than the match. The two that described the match
 * read the TITLE only — no stage of this pipeline had ever fetched a job
 * description — so years of experience, required skills, clearance, and comp
 * could not lower a score even in principle, and BASE = 50 meant an
 * unrecognised title started at even odds. A fresh home-metro req with a title
 * matching nothing scored 74. Facts now come from data/jd-facts.tsv
 * (enrich-jd.mjs); a row with no description read falls back to title-family
 * scoring and says so.
 *
 * WHAT THIS IS NOT
 *  - Not the fit score. modes/_shared.md owns fit (1-5, holistic, model-judged).
 *  - Not a filter. Nothing is hidden; a gated row shows as 0 with its reason.
 *  - Not trained. Hand-set priors. Calibration against real outcomes is
 *    possible the moment data/applications.md carries replies — see
 *    `calibrate()` at the bottom.
 *
 * INPUTS DELIBERATELY EXCLUDED
 * No protected characteristic is an input, and none is inferable from one. The
 * model reads the posting's own text and the profile's own stated targets,
 * clearances, and comp floor. Nothing about a person other than what the user
 * wrote down themselves.
 *
 * UNTRUSTED CONTENT: description text is pattern-matched for facts, never
 * followed as instruction.
 */
import { SENIORITY_TOKENS, SUB_BASELINE_SENIORITY } from './role-matcher.mjs';
import { clearanceIn } from './enrich-jd.mjs';

/** Where a posting sits relative to the profile's target level. */
const OVER_LEVEL = new Set(['staff', 'principal', 'lead', 'head', 'chief']);

/**
 * Every signal is declared here so the column can explain itself. Each one is a
 * MULTIPLIER now, not a point delta: `floor` is the worst it can do to a row.
 * A signal with floor 0 is a hard stop.
 */
export const SIGNALS = [
  { id: 'gate', label: 'Hard stop', floor: 0, range: '0', reads: 'clearance, years, degree and comp floor read from the description' },
  { id: 'hats', label: 'Role hats demanded', floor: 0.15, range: '×0.15 – ×1.00', reads: 'how many of designer / developer / AI advocate the description demands' },
  { id: 'title', label: 'Title family', floor: 0.75, range: '×0.75 – ×1.00', reads: 'the title against target_roles in config/profile.yml' },
  { id: 'framework', label: 'Named framework', floor: 1, range: '×1.10', reads: 'Foundry, Salesforce, ServiceNow or Power Platform named in the title or role summary' },
  { id: 'clearance', label: 'Clearance advantage', floor: 1, range: '×1.12', reads: 'a Secret or Public Trust requirement — held, and it thins the pool' },
  { id: 'degree', label: 'Degree demand', floor: 0.85, range: '×0.85', reads: "a master's required with no bachelor's branch" },
  { id: 'level', label: 'Seniority alignment', floor: 0.55, range: '×0.55 – ×1.00', reads: 'seniority and people-management words in the title vs the target level' },
  { id: 'fresh', label: 'Posting freshness', floor: 0.6, range: '×0.60 – ×1.00', reads: 'days since the board published it' },
  { id: 'pool', label: 'Applicant-pool proxy', floor: 0.8, range: '×0.80 – ×1.00', reads: 'corridor segment as a proxy for how many people are applying' },
  { id: 'volume', label: 'Employer posting volume', floor: 0.95, range: '×0.95', reads: 'how many reqs this employer has open in the pipeline' },
  { id: 'repost', label: 'Repost pattern', floor: 0.92, range: '×0.92', reads: 'same company and title surfaced under more than one URL' },
  { id: 'nojd', label: 'No description read', floor: 1, range: '×0.15 – ×0.62', reads: 'the fallback when the posting could not be fetched — title family only, capped below any confirmed two-hat match' },
];

export const BANDS = [
  { id: 'premier', label: 'Premier match', min: 55 },
  { id: 'strong', label: 'Strong match', min: 42 },
  { id: 'ordinary', label: 'Ordinary', min: 28 },
  { id: 'low', label: 'Low signal', min: 1 },
  { id: 'blocked', label: 'Blocked', min: -Infinity },
];

export function bandOf(score) {
  return BANDS.find(b => score >= b.min).id;
}

/** The three hats. All three in one description is the premier role. */
const HAT_LABEL = { designer: 'designer', developer: 'developer', ai_advocate: 'AI advocate' };
const HAT_FIT = { 3: 1, 2: 0.72, 1: 0.45, 0: 0.15 };

/**
 * Title-family multiplier. `lane` is the weaker middle case: the title itself
 * named no target role, but a title_filter keyword put the row in a lane — real
 * evidence, one step softer than the title saying it outright.
 */
const TITLE_FIT = { primary: 1, secondary: 0.95, adjacent: 0.85, lane: 0.85, unmatched: 0.75 };
/** Fallback fit when no description could be read — title family is all there is. */
const TITLE_ONLY_FIT = { primary: 0.62, secondary: 0.45, adjacent: 0.25, lane: 0.25, unmatched: 0.15 };

/** Seniority words present in a title, lowercased. */
function levelsIn(title) {
  return String(title || '').toLowerCase().split(/[^a-z]+/).filter(w => SENIORITY_TOKENS.has(w));
}

/**
 * Profile level ("Mid-Senior") -> the rungs a reply is plausible at. Anything
 * the profile does not name is treated as unstated rather than wrong: most
 * titles carry no seniority word at all, and penalising that would push half
 * the pipeline down for a reason that is about the vendor's title convention.
 */
function levelScore(title, targetLevel) {
  // People-management titles carry no seniority TOKEN, so levelsIn never sees
  // them and a Sr. Director of UX Research scored as an unqualified IC req.
  const mgmt = String(title || '').match(/\b(director|vice president|vp|president|manager|supervisor)\b/i);
  if (mgmt) return { mult: 0.55, why: `${mgmt[1].toLowerCase()} — people-management req` };
  const found = levelsIn(title);
  if (!found.length) return { mult: 1, why: 'no seniority in title' };
  const target = String(targetLevel || '').toLowerCase();
  const wantsSenior = target.includes('senior') || target.includes('staff');
  if (found.some(f => SUB_BASELINE_SENIORITY.has(f))) {
    return { mult: 0.6, why: `${found[0]} — below target level` };
  }
  const over = found.find(f => OVER_LEVEL.has(f));
  if (over) return { mult: wantsSenior ? 0.85 : 0.75, why: `${over} — above target level` };
  if (found.includes('senior')) return { mult: 1, why: 'senior — on target' };
  if (found.some(f => f === 'mid' || f === 'middle')) return { mult: 1, why: 'mid — on target' };
  return { mult: 1, why: found[0] };
}

/**
 * Applicant-pool proxy. This is the geography term: a remote req draws a
 * national pool and converts worse per application than a local one, and an
 * out-of-market req carries a relocation objection the recruiter has to spend
 * effort on. It is about competition and logistics, never about the candidate.
 * Demoted to a multiplier in the 2026-08-23 rebuild — as an additive term it
 * was large enough to carry an unrecognised local title into the top band.
 */
const POOL = {
  'San Diego': { mult: 1, why: 'home metro — thin local pool, no relocation question' },
  'Bay Area': { mult: 1, why: 'in corridor — deepest market for these families' },
  'OC / LA': { mult: 0.96, why: 'drivable — regional pool' },
  'Central Coast': { mult: 0.96, why: 'drivable — regional pool' },
  Remote: { mult: 0.88, why: 'remote — national applicant pool' },
  'Other / unknown': { mult: 0.8, why: 'out of corridor — relocation objection' },
};

function freshScore(age) {
  if (age === null || age === undefined) return { mult: 0.85, why: 'no posted date published' };
  if (age <= 3) return { mult: 1, why: `${age}d — first wave` };
  if (age <= 7) return { mult: 0.96, why: `${age}d — still early` };
  if (age <= 14) return { mult: 0.9, why: `${age}d` };
  if (age <= 30) return { mult: 0.82, why: `${age}d` };
  if (age <= 45) return { mult: 0.7, why: `${age}d — pile is deep` };
  return { mult: 0.6, why: `${age}d — past the scan window` };
}

/** "$130K" / "130000" / "$130,000" -> 130000. */
export function parseMoney(s) {
  const m = String(s || '').replace(/,/g, '').match(/(\d+(?:\.\d+)?)\s*([kK])?/);
  if (!m) return null;
  const n = Number(m[1]) * (m[2] ? 1000 : 1);
  return Number.isFinite(n) && n > 0 ? n : null;
}

/**
 * The four hard stops, in the order they are reported. Facts absent from the
 * description never gate — an unread JD is missing evidence, not a reason to
 * bury a posting.
 */
export const YOE_CEILING = 8;

/**
 * Relocation is acceptable anywhere in California, so geography gates only when
 * the description says onsite AND the location resolves to somewhere that is not
 * California. A location string that names no state at all never gates: the same
 * rule as an unreadable description, since a guess must not kill a row.
 */
const CA_PLACES = /\b(?:ca|calif|california)\b|san diego|san francisco|bay area|silicon valley|san jose|sunnyvale|palo alto|mountain view|santa clara|santa monica|santa barbara|santa cruz|oakland|berkeley|emeryville|alameda|fremont|cupertino|san mateo|foster city|redwood city|menlo park|los angeles|el segundo|culver city|burbank|pasadena|long beach|anaheim|irvine|costa mesa|newport beach|carlsbad|san luis obispo|ventura|sacramento|pleasanton|san ramon|walnut creek|playa vista|west hollywood/i;
const US_STATE = /,\s*(?:al|ak|az|ar|co|ct|de|fl|ga|hi|id|il|in|ia|ks|ky|la|me|md|ma|mi|mn|ms|mo|mt|ne|nv|nh|nj|nm|ny|nc|nd|oh|ok|or|pa|ri|sc|sd|tn|tx|ut|vt|va|wa|wv|wi|wy|dc)\b/i;

export function inCalifornia(loc) {
  const t = String(loc || '').trim();
  if (!t) return null;                     // nothing published — unknown, never gates
  if (CA_PLACES.test(t)) return true;
  if (US_STATE.test(t)) return false;      // named another state outright
  if (/united states|usa|remote|anywhere|multiple locations/i.test(t)) return null;
  return /,/.test(t) ? false : null;       // 'Austin, Texas' resolves; a bare word does not
}
function gateOf(f, walkAway, loc, title = '') {
  // A title that names its own clearance is evidence, and the only evidence
  // there is when the description could not be read. 'Front-End Engineer,
  // TS/SCI with Poly' gates for the same reason the description would.
  if (!f) return clearanceIn(title) === 'ts_sci' ? 'title requires TS/SCI, polygraph, or program access' : null;
  if (f.clearance === 'ts_sci') return 'requires TS/SCI, polygraph, or program access';
  if (f.yoe !== null && f.yoe > YOE_CEILING) return `${f.yoe}+ years required — above the ${YOE_CEILING}-year ceiling`;
  if (f.degree === 'phd') return 'doctorate required with no bachelor’s or master’s branch';
  if (f.remote === 'onsite' && inCalifornia(loc) === false)
    return `onsite in ${String(loc).trim()} — outside California`;
  if (f.comp_high !== null && walkAway && f.comp_high < walkAway)
    return `advertised ceiling $${Math.round(f.comp_high / 1000)}K is under the $${Math.round(walkAway / 1000)}K walk-away`;
  return null;
}

/**
 * Build the scorer. Context that is the same for every row — the profile, how
 * many reqs each company has open, which company+title pairs the scanner has
 * seen more than once — is computed here, not per row.
 *
 * `facts` is a Map(url -> row from data/jd-facts.tsv), or empty when
 * enrich-jd.mjs has not run. Empty is a supported state: every row then scores
 * on its title family and says "no description read" in its own tooltip.
 */
export function buildScorer({ profile = {}, lanes = [], rows = [], history = [], facts = new Map() } = {}) {
  const fitByArchetype = new Map(
    (profile.target_roles?.archetypes || []).map(a => [a.name, a.fit || 'secondary']),
  );
  const targetLevel = (profile.target_roles?.archetypes || [])[0]?.level || 'Mid-Senior';
  const fitByLane = new Map(lanes.map(l => [l.id, fitByArchetype.get(l.archetype) || 'secondary']));
  const walkAway = parseMoney(profile.compensation?.minimum);

  // Title matching. Built from the profile's own words — the North Star titles
  // in target_roles.primary and the archetype names — so adding a target role
  // there is the only place a family is declared. Deliberately substring, not
  // fuzzy: "Senior Front End Engineer" must match "Front End Engineer", while
  // "Cloud Solutions Architect" must not match anything.
  const norm = s => String(s || '').toLowerCase().replace(/[^a-z]+/g, ' ').trim();
  const primaryTitles = (profile.target_roles?.primary || []).map(norm).filter(Boolean);
  const archetypeTitles = [...fitByArchetype.entries()]
    .map(([name, fit]) => ({ needle: norm(name.split('(')[0]), fit }))
    .filter(a => a.needle);

  // Compared with spaces stripped as well as with them: the profile says
  // "Front End Engineer" and postings say "Frontend Engineer".
  const squash = s => s.replace(/ /g, '');
  function coreFit(title) {
    const t = norm(title);
    if (!t) return 'unmatched';
    const ts = squash(t);
    const hits = p => t.includes(p) || ts.includes(squash(p));
    if (primaryTitles.some(hits)) return 'primary';
    const hit = archetypeTitles.find(a => hits(a.needle));
    return hit ? hit.fit : 'unmatched';
  }

  const openReqs = new Map();
  for (const r of rows) openReqs.set(r.c, (openReqs.get(r.c) || 0) + 1);

  // Same company + same title surfaced under more than one URL: the Block G
  // reposting signal, computed from the scanner's own history.
  const seen = new Map();
  for (const h of history) {
    const key = `${(h.company || '').toLowerCase()}|${(h.title || '').toLowerCase()}`;
    if (!seen.has(key)) seen.set(key, new Set());
    seen.get(key).add(h.url);
  }

  return function scoreRow(row) {
    const signals = [];
    const add = (id, mult, why) => { if (mult !== 1 || id === 'nojd') signals.push({ id, mult, why }); };
    const f = factsFor(facts, row.u);

    const gate = gateOf(f, walkAway, row.l, row.t);
    if (gate) {
      signals.push({ id: 'gate', mult: 0, why: gate });
      return { score: 0, band: 'blocked', gate, signals };
    }

    // The TITLE decides the family, and the lane is only the fallback. A lane is
    // assigned by one broad title_filter keyword — "AI Engineer" put a Finance &
    // Strategy req in the forward-deployed lane and handed it a primary family
    // it had no claim to. The title is the same evidence, read more strictly, so
    // when it matches nothing the row is unmatched no matter what claimed it.
    const titleFamily = coreFit(row.t);
    const family = titleFamily !== 'unmatched' ? titleFamily
      : row.lane !== 'core' ? 'lane' : 'unmatched';

    let fit;
    if (f && f.hats !== null) {
      // The description was read: the hats decide, the title only modulates.
      const hats = f.hats;
      fit = HAT_FIT[Math.min(3, hats.length)];
      signals.push({
        id: 'hats',
        mult: fit,
        why: hats.length
          ? `${hats.length} of 3 — ${hats.map(h => HAT_LABEL[h] || h).join(', ')}`
          : 'none of designer / developer / AI advocate',
      });
      const tf = TITLE_FIT[family];
      add('title', tf, family === 'unmatched' ? 'title matches no target role'
        : family === 'lane' ? `no target role in the title — ${row.lane} lane keyword only`
        : `${family} family`);
      fit *= tf;
    } else {
      // No description: the title family is the whole of the evidence, and it
      // is capped below a confirmed two-hat match so a guess never outranks a
      // fact. This is the largest source of low scores today.
      fit = TITLE_ONLY_FIT[family];
      signals.push({ id: 'nojd', mult: fit, why: `no description read — ${family === 'lane' ? row.lane + ' lane keyword' : family + ' title family'} only` });
      // A title can still state a clearance — 'UI/UX Developer / Active Secret'
      // — and it thins the applicant pool exactly as the description would.
      // Hats are not read here: a hat needs two corroborating terms and a title
      // never carries two, so reading one would only ever return nothing.
      if (clearanceIn(row.t) === 'secret') {
        add('clearance', 1.12, 'Secret named in the title — held, and it thins the applicant pool');
        fit *= 1.12;
      }
    }

    if (f) {
      if (f.frameworks.length) {
        add('framework', 1.1, `${f.frameworks.join(', ')} — stated strength`);
        fit *= 1.1;
      }
      if (f.clearance === 'secret') {
        add('clearance', 1.12, 'Secret / Public Trust — held, and it thins the applicant pool');
        fit *= 1.12;
      }
      if (f.degree === 'master') {
        add('degree', 0.85, 'master’s required — in reach, not held');
        fit *= 0.85;
      }
    }

    const lvl = levelScore(row.t, targetLevel);
    add('level', lvl.mult, lvl.why);
    fit = Math.min(1, fit * lvl.mult);

    const fr = freshScore(row.age);
    add('fresh', fr.mult, fr.why);
    const pool = POOL[row.seg] || POOL['Other / unknown'];
    add('pool', pool.mult, pool.why);
    let timing = fr.mult * pool.mult;

    const reqs = openReqs.get(row.c) || 1;
    if (reqs >= 16) { add('volume', 0.95, `${reqs} open reqs — high-volume poster`); timing *= 0.95; }

    const dupes = seen.get(`${(row.c || '').toLowerCase()}|${(row.t || '').toLowerCase()}`);
    if (dupes && dupes.size >= 2) {
      add('repost', 0.92, `posted ${dupes.size}x — possible evergreen req`);
      timing *= 0.92;
    }

    const score = Math.max(1, Math.round(100 * fit * Math.max(0.55, timing)));
    return { score, band: bandOf(score), gate: null, signals };
  };
}

/** Parse one data/jd-facts.tsv row into typed facts. Unfetched rows read null. */
function factsFor(facts, url) {
  const r = facts.get(url);
  if (!r || r.ok !== '1') return null;
  const num = v => (v === '' || v === undefined ? null : Number(v));
  const list = v => String(v || '').split(',').filter(Boolean);
  return {
    yoe: num(r.yoe),
    degree: r.degree || 'open',
    clearance: r.clearance || 'none',
    comp_low: num(r.comp_low),
    comp_high: num(r.comp_high),
    remote: r.remote || '',
    hats: list(r.hats),
    frameworks: list(r.frameworks),
  };
}

/**
 * Observed reply rate per band, for when the tracker starts carrying outcomes.
 * Today applications.md has no replied/interview rows, so this returns empty
 * and the page says the prior is uncalibrated rather than implying it is not.
 */
export function calibrate(scoredRows) {
  const REPLIED = /replied|interview|screen|callback|onsite|offer/i;
  const buckets = new Map(BANDS.map(b => [b.id, { band: b.id, applied: 0, replied: 0 }]));
  for (const r of scoredRows) {
    if (r.status === 'pending' || !r.status) continue;
    const b = buckets.get(r.band);
    if (!b) continue;
    b.applied++;
    if (REPLIED.test(r.status)) b.replied++;
  }
  return [...buckets.values()].filter(b => b.applied > 0);
}
