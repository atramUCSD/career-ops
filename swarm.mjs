#!/usr/bin/env node
/**
 * swarm.mjs — the conductor: discovery → liveness → prune → lane classification
 * → (later phases) pre-screen → evaluation → staged application package.
 *
 * WHY THIS EXISTS
 * `scan.mjs` fills `data/pipeline.md`. `batch/batch-runner.sh` evaluates offers
 * listed in `batch/batch-input.tsv`. Nothing ever built the second file from the
 * first, so a 400-entry pending list only ever converted into applications by a
 * human running four scripts in the right order and hand-writing the TSV.
 *
 * WHAT THIS IS NOT
 * It is not a replacement for `batch/batch-runner.sh`. That script already owns
 * worker dispatch, the PID pool, the state lock, report-number reservation,
 * retry and rate-limit pause, and post-run reconciliation. This conductor owns
 * only the stages that never existed, and shells out to the runner for
 * evaluation (phase 2).
 *
 * THE PLAYWRIGHT BOUNDARY
 * The conductor is the only process in a swarm run that may touch a browser.
 * Stage 2 uses `check-liveness.mjs --api-only`, which never opens one; any JD
 * that needs rendering is fetched serially here (phase 2) and handed to workers
 * as a file. Workers stay browserless and therefore parallel-safe — the rule in
 * `modes/_shared.md` ("never 2+ agents with Playwright in parallel") is
 * satisfied by construction, not by convention.
 *
 * Nothing here submits an application, ever. The pipeline stops at a package
 * staged for human review.
 *
 * Run: node swarm.mjs [--dry-run] [--scan [--since N]] [--stale N] [--max-evals N]
 */

import { existsSync, readFileSync, writeFileSync, mkdtempSync } from 'fs';
import { spawnSync } from 'child_process';
import { join, dirname } from 'path';
import { tmpdir } from 'os';
import { fileURLToPath, pathToFileURL } from 'url';
import { flagValue, hasFlag } from './lib/cli-flags.mjs';
import { loadLanes, laneForTitle, checkLaneRegistration } from './lanes.mjs';

const ROOT = dirname(fileURLToPath(import.meta.url));
const PIPELINE_PATH = process.env.CAREER_OPS_PIPELINE || join(ROOT, 'data', 'pipeline.md');

const PENDING_ITEM_RE = /^-\s\[ \]\s+(https?:\/\/\S+)(.*)$/;
const PROCESSED_RE = /^##\s+(Procesadas|Processed)\s*$/i;
const LABELED_RE = /^(posted|trust|note):\s*(.*)$/i;

/**
 * Parse the pending entries out of a pipeline.md.
 *
 * Rows are variable-width (`modes/pipeline.md` → "Format of pipeline.md"): a
 * bare URL, or url + company + title + optional location + optional
 * compensation, with optional labeled `posted:` / `trust:` / `note:` segments
 * riding on any shape. Positional cells are read in order, labeled ones by name,
 * so a row carrying only `posted:` does not shift company into title.
 *
 * @param {string} text
 * @returns {Array<{url: string, company: string, title: string, location: string, posted: string|null, line: string}>}
 */
export function parsePendingRows(text) {
  const rows = [];
  let inProcessed = false;
  for (const line of String(text || '').split('\n')) {
    if (/^##\s/.test(line.trim())) inProcessed = PROCESSED_RE.test(line.trim());
    if (inProcessed) continue;
    const m = PENDING_ITEM_RE.exec(line.trim());
    if (!m) continue;
    const [, url, rest] = m;
    const cells = rest.split('|').map(c => c.trim()).filter(Boolean);
    const positional = [];
    const labeled = {};
    for (const cell of cells) {
      const lm = LABELED_RE.exec(cell);
      if (lm) labeled[lm[1].toLowerCase()] = lm[2].trim();
      else positional.push(cell);
    }
    rows.push({
      url,
      company: positional[0] || '',
      title: positional[1] || '',
      location: positional[2] || '',
      posted: labeled.posted || null,
      line: line.trim(),
    });
  }
  return rows;
}

/**
 * Attach a lane to each pending row. Deterministic — no model call.
 *
 * A row no lane claims is not dropped: the original AI/front-end targeting has
 * no lane of its own and is carried in the `core` bucket, uncapped except by
 * the global budget.
 *
 * @param {Array<object>} rows
 * @param {Array<object>} lanes
 * @returns {Array<object>} rows with `lane` and `laneKeywords`
 */
export function classifyRows(rows, lanes) {
  return rows.map((row) => {
    const hit = row.title ? laneForTitle(row.title, lanes) : null;
    return { ...row, lane: hit ? hit.id : 'core', laneKeywords: hit ? hit.keywords : [] };
  });
}

/**
 * Choose which rows get a full evaluation this run.
 *
 * Two budgets, both enforced: each lane's own `max_evaluations`, and the global
 * `--max-evals`. Lanes are interleaved round-robin so a lane with 200 fresh
 * postings cannot starve one with 3 — the point of lanes is that every family
 * makes progress every run.
 *
 * Pure and stable: same input, same output, so a resumed run dispatches exactly
 * the same set.
 *
 * @param {Array<object>} rows - classified rows
 * @param {{maxEvals: number, lanes: Array<object>}} opts
 * @returns {Array<object>}
 */
export function selectForEvaluation(rows, { maxEvals, lanes = [] }) {
  const capById = new Map(lanes.map(l => [l.id, l.max_evaluations == null ? Infinity : Number(l.max_evaluations)]));
  const buckets = new Map();
  for (const row of rows) {
    if (!buckets.has(row.lane)) buckets.set(row.lane, []);
    buckets.get(row.lane).push(row);
  }
  // Freshest first, then URL — a total order, so the selection never depends on
  // the order rows happened to appear in the file.
  for (const list of buckets.values()) {
    list.sort((a, b) => (b.posted || '').localeCompare(a.posted || '') || a.url.localeCompare(b.url));
  }
  // Lane order follows lanes.yml, with `core` last: a declared family is the
  // reason this machinery exists, so it gets first pick of a tight budget.
  const order = [...lanes.map(l => l.id).filter(id => buckets.has(id)),
                 ...[...buckets.keys()].filter(id => !capById.has(id))];

  const picked = [];
  const taken = new Map();
  let progress = true;
  while (picked.length < maxEvals && progress) {
    progress = false;
    for (const id of order) {
      if (picked.length >= maxEvals) break;
      const list = buckets.get(id) || [];
      const n = taken.get(id) || 0;
      if (n >= list.length) continue;
      if (n >= (capById.get(id) ?? Infinity)) continue;
      picked.push(list[n]);
      taken.set(id, n + 1);
      progress = true;
    }
  }
  return picked;
}

// ── Stages ───────────────────────────────────────────────────────────────────

function runNode(script, args, { dryRun, label }) {
  if (dryRun) { console.log(`   [dry-run] would run: node ${script} ${args.join(' ')}`); return 0; }
  console.log(`   node ${script} ${args.join(' ')}`);
  const res = spawnSync(process.execPath, [join(ROOT, script), ...args], { cwd: ROOT, stdio: 'inherit' });
  // check-liveness.mjs exits 1 when anything is expired or uncertain — that is
  // its normal reporting channel, not a failure of the stage.
  if (res.error) throw new Error(`${label}: ${res.error.message}`);
  return res.status ?? 0;
}

function readPipeline() {
  if (!existsSync(PIPELINE_PATH)) {
    console.error(`No pipeline at ${PIPELINE_PATH} — nothing to conduct.`);
    process.exit(1);
  }
  return readFileSync(PIPELINE_PATH, 'utf-8');
}

async function main() {
  const args = process.argv.slice(2);
  if (hasFlag(args, '--help') || hasFlag(args, '-h')) {
    console.log(`swarm.mjs — end-to-end conductor (phase 1: triage + lane plan)

  --dry-run          print the plan; run nothing that writes
  --scan             run a discovery scan first (off by default — it is the slow stage)
  --since <days>     scan window; use a wide one the first time a new lane runs,
                     because max_posting_age_days also truncates pagination
  --stale <days>     retire pending entries older than this (prune-pipeline.mjs)
  --max-evals <n>    global cap on evaluations this run (default 10)
  --check-lanes      report lane registration drift and exit
`);
    return;
  }

  const dryRun = hasFlag(args, '--dry-run');
  const maxEvals = Number(flagValue(args, '--max-evals') || 10);
  const staleDays = flagValue(args, '--stale');
  const since = flagValue(args, '--since');

  // ── Stage 0: preflight ────────────────────────────────────────────────────
  console.log('\n▸ stage 0 — preflight');
  const lanes = loadLanes();
  console.log(`   lanes: ${lanes.map(l => l.id).join(', ') || '(none configured)'}`);
  const findings = checkLaneRegistration(lanes);
  for (const f of findings) console.log(`   ${f.severity === 'error' ? '❌' : '⚠️ '} [${f.lane}] ${f.site}: ${f.message}`);
  const errors = findings.filter(f => f.severity === 'error');
  if (hasFlag(args, '--check-lanes')) process.exit(errors.length ? 1 : 0);
  if (errors.length) {
    // A lane registered on the scan side but not the evaluation side is worse
    // than an unregistered one: the postings arrive and are scored as some
    // other archetype, and the report looks perfectly plausible.
    console.error(`\n${errors.length} lane registration error(s) — fix these before spending a full evaluation.`);
    process.exit(1);
  }
  runNode('cv-sync-check.mjs', [], { dryRun, label: 'cv-sync-check' });

  // ── Stage 1: discover ─────────────────────────────────────────────────────
  if (hasFlag(args, '--scan')) {
    console.log('\n▸ stage 1 — discover');
    runNode('scan.mjs', since ? ['--since', String(since)] : [], { dryRun, label: 'scan' });
  }

  // ── Stage 2: liveness (zero tokens, no browser) ───────────────────────────
  console.log('\n▸ stage 2 — liveness');
  const pendingBefore = parsePendingRows(readPipeline());
  console.log(`   ${pendingBefore.length} pending URL(s)`);
  if (pendingBefore.length) {
    const dir = mkdtempSync(join(tmpdir(), 'swarm-'));
    const urlFile = join(dir, 'pending.txt');
    writeFileSync(urlFile, pendingBefore.map(r => r.url).join('\n') + '\n');
    runNode('check-liveness.mjs', ['--api-only', '--file', urlFile], { dryRun, label: 'check-liveness' });
  }

  // ── Stage 3: prune ────────────────────────────────────────────────────────
  console.log('\n▸ stage 3 — prune');
  runNode('prune-pipeline.mjs', [
    ...(dryRun ? ['--dry-run'] : []),
    ...(staleDays ? ['--stale', String(staleDays)] : []),
  ], { dryRun: false, label: 'prune-pipeline' });

  // ── Stage 4a: lane classification ─────────────────────────────────────────
  console.log('\n▸ stage 4a — lane classification');
  const rows = classifyRows(parsePendingRows(readPipeline()), lanes);
  const counts = new Map();
  for (const r of rows) counts.set(r.lane, (counts.get(r.lane) || 0) + 1);
  for (const [id, n] of counts) console.log(`   ${id.padEnd(8)} ${n}`);
  const untitled = rows.filter(r => !r.title).length;
  if (untitled) console.log(`   (${untitled} row(s) carry no title — they can only land in "core" until a scan fills one in)`);

  const selected = selectForEvaluation(rows, { maxEvals, lanes });
  console.log(`\n▸ plan — ${selected.length} of ${rows.length} pending row(s) selected (cap ${maxEvals})`);
  for (const r of selected) {
    console.log(`   [${r.lane}] ${r.posted || '          '}  ${(r.title || '(no title)').slice(0, 48).padEnd(48)} ${r.url}`);
  }
  console.log('\nPhase 1 stops here: nothing is evaluated, nothing is submitted.');
}

if (import.meta.url === pathToFileURL(process.argv[1] || '').href) {
  main().catch((err) => { console.error('Fatal:', err.message); process.exit(1); });
}
