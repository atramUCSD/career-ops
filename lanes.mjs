/**
 * lanes.mjs — role families as a checked contract.
 *
 * THE PROBLEM
 * A role family has to be registered in two unrelated halves of the repo. The
 * scan half is `portals.yml` → `title_filter.positive`: match the title, the
 * posting enters the pipeline. The evaluation half is a set of markdown and
 * YAML files that tell the evaluator which archetype it is looking at
 * (`modes/_profile.md`, `modes/_shared.md`, `batch/batch-prompt.md`,
 * `config/profile.yml`). Nothing connected the two, so a family could be added
 * to the scanner and then be scored as a completely different archetype —
 * which is exactly what happened to Developer Relations, Technical Customer
 * Success and GTM Engineer when their title keywords landed on 2026-08-21.
 *
 * WHAT THIS DOES
 * `config/lanes.yml` names each family once. `checkLaneRegistration()` reports
 * where that name is missing. It never edits anything: `portals.yml`,
 * `modes/_profile.md` and `config/profile.yml` are the user's own gitignored
 * files, and a generator writing into them would fight their edits.
 *
 * `laneForTitle()` classifies a posting title into a lane using
 * `compileKeyword()` from scan.mjs — the same matcher the scanner itself uses,
 * so "GTM" keeps its word-boundary semantics here and a lane can never match a
 * title the scanner would not have accepted for the same keyword.
 */

import { existsSync, readFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import yaml from 'js-yaml';
import { compileKeyword, buildTitleFilter, matchedTitleKeywords } from './scan.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)));

export const LANES_PATH = process.env.CAREER_OPS_LANES || join(ROOT, 'config', 'lanes.yml');

/**
 * Read and validate config/lanes.yml.
 *
 * Validation is deliberately strict: a lane with a duplicate id would make
 * per-lane caps ambiguous, and a lane with no archetype cannot be checked
 * against the evaluation-side files at all, which is the whole point of the
 * file.
 *
 * @param {string} [path=LANES_PATH]
 * @returns {Array<object>} the `lanes:` array, validated
 */
export function loadLanes(path = LANES_PATH) {
  if (!existsSync(path)) return [];
  const doc = yaml.load(readFileSync(path, 'utf-8')) || {};
  const lanes = Array.isArray(doc.lanes) ? doc.lanes : [];
  const seen = new Set();
  for (const lane of lanes) {
    if (!lane || typeof lane.id !== 'string' || !lane.id.trim()) {
      throw new Error(`lanes.yml: every lane needs a non-empty string id (got ${JSON.stringify(lane)})`);
    }
    if (seen.has(lane.id)) throw new Error(`lanes.yml: duplicate lane id "${lane.id}"`);
    seen.add(lane.id);
    if (typeof lane.archetype !== 'string' || !lane.archetype.trim()) {
      throw new Error(`lanes.yml: lane "${lane.id}" needs a non-empty archetype`);
    }
    if (!Array.isArray(lane.title_keywords) || lane.title_keywords.length === 0) {
      throw new Error(`lanes.yml: lane "${lane.id}" needs at least one title keyword`);
    }
    if (lane.max_evaluations != null && !(Number(lane.max_evaluations) > 0)) {
      throw new Error(`lanes.yml: lane "${lane.id}" max_evaluations must be > 0`);
    }
  }
  return lanes;
}

/**
 * Classify a posting title into a lane.
 *
 * A title can legitimately hit more than one lane ("Developer Experience
 * Engineer, Growth"); the lane with the most matching keywords wins, and a tie
 * goes to the lane declared first in lanes.yml — so ordering in the file is the
 * priority knob, with no second mechanism to learn.
 *
 * @param {string} title
 * @param {Array<object>} lanes
 * @returns {{id: string, lane: object, keywords: string[]}|null} null when no lane claims the title
 */
export function laneForTitle(title, lanes) {
  let best = null;
  for (const lane of lanes) {
    const keywords = matchedTitleKeywords(title, { positive: lane.title_keywords });
    if (keywords.length === 0) continue;
    if (!best || keywords.length > best.keywords.length) best = { id: lane.id, lane, keywords };
  }
  return best;
}

/**
 * Does the lane's JD gate accept this description?
 *
 * Runs at pre-screen, not at scan time: only 7 of 83 providers ship a
 * description in their list payload, so a scan-time content gate is vacuous for
 * the other 76. Here the JD is actually in hand.
 *
 * @param {string} text - the job description
 * @param {object} lane
 * @returns {{pass: boolean, reason: string}}
 */
export function laneGate(text, lane) {
  const lower = (text || '').toLowerCase();
  const gate = lane?.jd_gate || {};
  const neg = (gate.negative || []).map(k => String(k).toLowerCase()).filter(k => k && lower.includes(k));
  if (neg.length) return { pass: false, reason: `${lane.id} gate: negative ${neg.join(',')}` };
  const pos = (gate.positive || []).map(k => String(k).toLowerCase()).filter(Boolean);
  if (pos.length === 0) return { pass: true, reason: `${lane.id} gate: no positive terms configured` };
  const hit = pos.filter(k => lower.includes(k));
  return hit.length
    ? { pass: true, reason: `${lane.id} gate: ${hit.slice(0, 3).join(',')}` }
    : { pass: false, reason: `${lane.id} gate: none of ${pos.slice(0, 5).join(',')}` };
}

/** Where a lane's archetype name must appear for the evaluator to know about it. */
const ARCHETYPE_SITES = [
  ['modes/_profile.md', 'the candidate archetype table'],
  ['modes/_shared.md', 'the shared archetype table (injected into gemini-eval/openai-eval)'],
  ['batch/batch-prompt.md', 'the batch worker archetype list'],
];

function readIfPresent(root, rel) {
  const p = join(root, rel);
  return existsSync(p) ? readFileSync(p, 'utf-8') : null;
}

/**
 * Report where each lane is not registered. Never edits a file.
 *
 * Missing files produce a `warning`, not an `error`: `portals.yml`,
 * `modes/_profile.md` and `config/profile.yml` are gitignored user data and are
 * legitimately absent in a fresh clone.
 *
 * @param {Array<object>} lanes
 * @param {{root?: string}} [opts]
 * @returns {Array<{lane: string, severity: 'error'|'warning', site: string, message: string}>}
 */
export function checkLaneRegistration(lanes, { root = ROOT } = {}) {
  const findings = [];
  const add = (lane, severity, site, message) => findings.push({ lane, severity, site, message });

  const portalsText = readIfPresent(root, 'portals.yml');
  let titleFilter = null;
  if (portalsText === null) {
    add('-', 'warning', 'portals.yml', 'not found — scan-side registration unchecked');
  } else {
    titleFilter = (yaml.load(portalsText) || {}).title_filter || {};
  }

  const files = new Map(ARCHETYPE_SITES.map(([rel]) => [rel, readIfPresent(root, rel)]));
  const profileYmlText = readIfPresent(root, 'config/profile.yml');

  for (const lane of lanes) {
    if (titleFilter) {
      const positives = Array.isArray(titleFilter.positive) ? titleFilter.positive : [];
      const accepts = buildTitleFilter(titleFilter);
      for (const kw of lane.title_keywords) {
        if (!positives.includes(kw)) {
          add(lane.id, 'error', 'portals.yml', `title keyword "${kw}" is not in title_filter.positive — the scanner will never surface this lane`);
        }
        // A negative is absolute in buildTitleFilter (hasPositive && !hasNegative),
        // so one stray negative silently nullifies a whole lane. This is the
        // "Account Manager" trap, pinned.
        if (!accepts(kw)) {
          add(lane.id, 'error', 'portals.yml', `title keyword "${kw}" is blocked by a title_filter.negative entry`);
        }
      }
    }

    for (const [rel, what] of ARCHETYPE_SITES) {
      const text = files.get(rel);
      if (text === null) { add(lane.id, 'warning', rel, 'not found — archetype registration unchecked'); continue; }
      if (!text.includes(lane.archetype)) {
        add(lane.id, 'error', rel, `archetype "${lane.archetype}" is missing from ${what} — postings in this lane will be scored as a different archetype`);
      }
    }

    if (profileYmlText === null) {
      add(lane.id, 'warning', 'config/profile.yml', 'not found — archetype registration unchecked');
    } else if (!profileYmlText.includes(lane.archetype)) {
      add(lane.id, 'error', 'config/profile.yml', `archetype "${lane.archetype}" is missing from target_roles.archetypes`);
    }

    if (lane.golden_case && !existsSync(join(root, lane.golden_case))) {
      add(lane.id, 'warning', lane.golden_case, 'golden case file does not exist yet');
    }
  }
  return findings;
}

// Re-exported so consumers get the scanner's matcher without importing scan.mjs
// (which is large and has side-effect-free but heavy module init).
export { compileKeyword };
