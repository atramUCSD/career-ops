#!/usr/bin/env node
/**
 * callback-score.mjs — deterministic response-likelihood prior for a pending posting.
 *
 * WHAT THIS IS
 * A 0-100 estimate of how likely THIS posting is to produce a recruiter reply
 * or interview email, given the profile in config/profile.yml. It runs at build
 * time over every pending row, costs nothing, and calls no model.
 *
 * WHAT THIS IS NOT
 *  - Not a fit score. modes/_shared.md owns fit (1-5, holistic, model-judged).
 *    This answers a different question: "if I apply, does anyone write back?"
 *  - Not a rejection verdict and not a filter. Every row keeps rendering, keeps
 *    its link, and stays applicable. A low number means thin evidence, not
 *    "don't bother" — the strongest reason for a low score in this repo today
 *    is that the board published no date.
 *  - Not a keyword count. Keyword evidence is one of eight signals and is
 *    capped, precisely so the column cannot be gamed by stuffing portals.yml
 *    with broad positives.
 *  - Not trained. These are hand-set priors from published matching behaviour
 *    (freshness dominates; applicant pool scales with geography; high-volume
 *    posters convert worse per application). Calibration against real outcomes
 *    is possible the moment data/applications.md carries replies — see
 *    `calibrate()` at the bottom.
 *
 * INPUTS DELIBERATELY EXCLUDED
 * No protected characteristic is an input, and none is inferable from one:
 * the model reads title, matched keywords, role family, posting age, location
 * bucket, company posting volume, repost pattern, and provider trust. Nothing
 * about a person other than the target roles the user wrote down themselves.
 */
import { SENIORITY_TOKENS, SUB_BASELINE_SENIORITY } from './role-matcher.mjs';

/** Where a posting sits relative to the profile's target level. */
const OVER_LEVEL = new Set(['staff', 'principal', 'lead', 'head', 'chief']);

/**
 * Every signal is declared here so the column can explain itself. `max` is the
 * absolute cap the signal can move the score by; the render uses it to show
 * how much of the estimate any one input is responsible for.
 */
export const SIGNALS = [
  { id: 'fit', label: 'Role-family fit', max: 14 },
  { id: 'level', label: 'Seniority alignment', max: 16 },
  { id: 'evidence', label: 'Keyword evidence', max: 8 },
  { id: 'fresh', label: 'Posting freshness', max: 18 },
  { id: 'pool', label: 'Applicant-pool proxy', max: 12 },
  { id: 'volume', label: 'Employer posting volume', max: 6 },
  { id: 'repost', label: 'Repost pattern', max: 8 },
  { id: 'trust', label: 'Provider trust', max: 10 },
];

const BASE = 50;

export const BANDS = [
  { id: 'strong', label: 'Strong signal', min: 72 },
  { id: 'likely', label: 'Likely reply', min: 58 },
  { id: 'even', label: 'Even odds', min: 42 },
  { id: 'low', label: 'Low signal', min: -Infinity },
];

export function bandOf(score) {
  return BANDS.find(b => score >= b.min).id;
}

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
  const found = levelsIn(title);
  if (!found.length) return { delta: 0, why: 'no seniority in title' };
  const target = String(targetLevel || '').toLowerCase();
  const wantsSenior = target.includes('senior') || target.includes('staff');
  const wantsMid = target.includes('mid') || target.includes('senior');
  if (found.some(f => SUB_BASELINE_SENIORITY.has(f))) {
    return { delta: -16, why: `${found[0]} — below target level` };
  }
  if (found.some(f => OVER_LEVEL.has(f))) {
    return { delta: wantsSenior ? -6 : -10, why: `${found.find(f => OVER_LEVEL.has(f))} — above target level` };
  }
  if (found.includes('senior')) return { delta: wantsSenior ? 8 : 2, why: 'senior — on target' };
  if (found.some(f => f === 'mid' || f === 'middle')) return { delta: wantsMid ? 8 : 2, why: 'mid — on target' };
  return { delta: 0, why: found[0] };
}

/**
 * Applicant-pool proxy. This is the geography term: a remote req draws a
 * national pool and converts worse per application than a local one, and an
 * out-of-market req carries a relocation objection the recruiter has to spend
 * effort on. It is about competition and logistics, never about the candidate.
 */
const POOL = {
  'San Diego': { delta: 10, why: 'home metro — small local pool, no relocation question' },
  'OC / LA': { delta: 5, why: 'drivable — regional pool' },
  'Central Coast': { delta: 5, why: 'drivable — regional pool' },
  'Bay Area': { delta: -4, why: 'deep local supply, relocation implied' },
  Remote: { delta: -12, why: 'remote — national applicant pool' },
  'Other / unknown': { delta: -6, why: 'out of corridor — relocation objection' },
};

function freshScore(age) {
  if (age === null || age === undefined) return { delta: -3, why: 'no posted date published' };
  if (age <= 3) return { delta: 18, why: `${age}d — first wave` };
  if (age <= 7) return { delta: 14, why: `${age}d — still early` };
  if (age <= 14) return { delta: 7, why: `${age}d` };
  if (age <= 30) return { delta: 0, why: `${age}d` };
  if (age <= 45) return { delta: -8, why: `${age}d — pile is deep` };
  return { delta: -16, why: `${age}d — past the scan window` };
}

function volumeScore(openReqs) {
  if (openReqs >= 16) return { delta: -5, why: `${openReqs} open reqs — high-volume poster` };
  if (openReqs >= 4) return { delta: 0, why: `${openReqs} open reqs` };
  return { delta: 3, why: `${openReqs} open req${openReqs === 1 ? '' : 's'} — focused hiring` };
}

/**
 * Build the scorer. Context that is the same for every row — the profile, how
 * many reqs each company has open, which company+title pairs the scanner has
 * seen more than once — is computed here, not per row.
 */
export function buildScorer({ profile = {}, lanes = [], rows = [], history = [] } = {}) {
  const fitByArchetype = new Map(
    (profile.target_roles?.archetypes || []).map(a => [a.name, a.fit || 'secondary']),
  );
  const targetLevel = (profile.target_roles?.archetypes || [])[0]?.level || 'Mid-Senior';
  const fitByLane = new Map(lanes.map(l => [l.id, fitByArchetype.get(l.archetype) || 'secondary']));

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
    const add = (id, delta, why) => { if (delta || why) signals.push({ id, delta, why }); };

    // Core targeting keywords ARE the North Star roles, so a core row is
    // treated as primary; a registered lane inherits the fit the profile
    // assigned to its archetype.
    const fit = row.lane === 'core' ? 'primary' : (fitByLane.get(row.lane) || 'secondary');
    const fitPts = { primary: 14, secondary: 6, adjacent: -4 }[fit] ?? 0;
    add('fit', fitPts, `${fit} family (${row.lane})`);

    const lvl = levelScore(row.t, targetLevel);
    add('level', lvl.delta, lvl.why);

    // Capped at 8 on purpose: converging keywords are weak corroboration, not
    // the point of the score. Two distinct positives matching is worth more
    // than one, and a long positive is more specific than a short one, but no
    // amount of keyword matching can carry a row on its own.
    const kws = row.all || [];
    const specific = kws.some(k => k.length >= 12);
    const evidence = Math.min(8, (kws.length >= 2 ? 5 : 0) + (specific ? 3 : 0));
    add('evidence', evidence, kws.length ? `${kws.length} keyword${kws.length === 1 ? '' : 's'}${specific ? ', specific' : ''}` : 'no keyword recorded');

    const fr = freshScore(row.age);
    add('fresh', fr.delta, fr.why);

    const pool = POOL[row.seg] || POOL['Other / unknown'];
    add('pool', pool.delta, pool.why);

    const vol = volumeScore(openReqs.get(row.c) || 1);
    add('volume', vol.delta, vol.why);

    const dupes = seen.get(`${(row.c || '').toLowerCase()}|${(row.t || '').toLowerCase()}`);
    if (dupes && dupes.size >= 2) add('repost', -8, `posted ${dupes.size}× — possible evergreen req`);

    if (row.trust !== null && row.trust !== undefined) {
      const d = Math.max(-10, Math.min(10, Math.round((row.trust - 50) / 5)));
      add('trust', d, `provider trust ${row.trust}`);
    }

    const raw = BASE + signals.reduce((n, s) => n + s.delta, 0);
    const score = Math.max(0, Math.min(100, raw));
    return { score, band: bandOf(score), signals: signals.filter(s => s.delta !== 0) };
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
