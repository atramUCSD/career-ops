/**
 * prepare-fanout.mjs — the bulk-prepare backend: resolve shortlist URLs to
 * report numbers, run one headless tailor worker per application, render each
 * PDF, and stamp the tracker row `prepared: awaiting review` via set-status.mjs.
 *
 * NOTHING here submits anything anywhere. This produces artifacts (tailored
 * HTML + PDF + drafted form answers) and a Notes-cell marker behind the
 * per-application human review gate — the tracker's Status cell stays a
 * canonical states.yml value at all times (the row's own current status is
 * passed back to set-status, `Evaluated` for fresh backfills), per the
 * bulk-prepare contract: no new lifecycle state exists, only the marker.
 *
 * Plain .mjs (same pattern as pdf-render.mjs) so tests/lib/prepare-fanout.test.mjs
 * can import it directly under Node. Everything process- or TS-shaped is
 * injected: `spawnFn` (plain Node children), `spawnWorker` (the headless agent
 * CLI — the route passes spawnHeadlessCli so stdin-EOF #1973 holds),
 * `findReportFile` and `inbox` (career-ops.ts), `atomicWrite` (safe-write.ts).
 * The argv for the worker comes ONLY from claudeCliArgs — no tool flag is
 * spelled here or in the routes (test-all §55.6).
 */
import fs from "node:fs";
import path from "node:path";
import { claudeCliArgs } from "./claude-invocation.mjs";
import { resolvePdfPaths } from "./pdf-paths.mjs";
import { renderAndMarkPdf } from "./pdf-render.mjs";
import { parseClaudeEvent, isFatalClaudeStderr, accumulateTokens } from "./run-cli-support.mjs";
import { isReservedReportFile } from "./report-files.mjs";
import { parseCliJson } from "./status-cli.mjs";

/** Batch cap: maxDuration 800s is shared across SEQUENTIAL tailor workers. */
export const MAX_PREPARE_BATCH = 10;

/** The Notes-cell marker set-status appends when a row is prepared. */
export const PREPARED_NOTE = "prepared: awaiting review";

/** Per-child timeout for the short core-script children (set-status etc.). */
export const CORE_SCRIPT_TIMEOUT_MS = 30_000;

/**
 * Graceful per-worker budget: the whole batch shares the run budget one
 * /api/run worker gets (780s, killMsForKind's default), so each of n
 * sequential workers gets its slice. Count only the items that will actually
 * run — a resumed batch's completed rows are skipped, and dividing by them
 * would starve the one worker the rerun exists to recover.
 *
 * ponytail: no headroom is reserved for the per-item render/stamp children
 * (a Chromium PDF render plus up to three 30s-capped core scripts each), so a
 * full batch can run past the route's maxDuration 800. Local self-hosted Next
 * does not enforce maxDuration; subtract per-item headroom here (mirroring
 * run-cli-support's pdf reasoning) before deploying anywhere that does.
 * @param {number} count
 * @returns {number}
 */
export function perWorkerKillMs(count) {
  return Math.floor(780_000 / Math.max(1, count));
}

/**
 * Bound the tracker-lock wait below CORE_SCRIPT_TIMEOUT_MS so a busy tracker
 * surfaces as set-status's own exit-4 (503/retry) instead of our kill timer —
 * same reasoning and same ceiling as /api/status's boundedLockWait.
 * @param {Record<string, string|undefined>} [env]
 * @returns {Record<string, string>}
 */
export function boundedLockWaitEnv(env = process.env) {
  const raw = Number(env.CAREER_OPS_TRACKER_LOCK_TIMEOUT_MS);
  const requested = Number.isFinite(raw) && raw > 0 ? raw : 10_000;
  return { CAREER_OPS_TRACKER_LOCK_TIMEOUT_MS: String(Math.min(requested, CORE_SCRIPT_TIMEOUT_MS - 5_000)) };
}

/**
 * Normalize a posting URL for matching a shortlist entry against a report's
 * `**URL:**` header — both usually originate from the same scanner, so this
 * only has to absorb cosmetic drift (fragment, trailing slash, host case),
 * mirroring merge-tracker's key without re-implementing its tracking-param
 * strip (the scanner never adds those to its own rows).
 * @param {string} url
 * @returns {string}
 */
export function normalizePostingUrl(url) {
  const s = String(url ?? "").trim();
  try {
    const u = new URL(s);
    u.hash = "";
    let out = u.toString();
    if (out.endsWith("/")) out = out.slice(0, -1);
    return out;
  } catch {
    return s.replace(/#.*$/, "").replace(/\/+$/, "");
  }
}

/**
 * Scan reports/ for each report's `**URL:**` header → Map<normalizedUrl,
 * {num, file}>. The HIGHEST report number wins for a re-evaluated URL (the
 * latest evaluation is what the tailor should read). RESERVED sentinels are
 * skipped. Missing directory → empty map.
 * @param {string} root - careerOpsRoot().
 * @returns {Map<string, {num: number, file: string}>}
 */
export function indexReportsByUrl(root) {
  const dir = path.join(root, "reports");
  const index = new Map();
  let files;
  try {
    files = fs.readdirSync(dir);
  } catch {
    return index;
  }
  for (const f of files) {
    if (!f.endsWith(".md") || isReservedReportFile(f)) continue;
    const num = parseInt(f, 10);
    if (Number.isNaN(num)) continue;
    let content;
    try {
      content = fs.readFileSync(path.join(dir, f), "utf8");
    } catch {
      continue;
    }
    const m = content.match(/^\*\*URL:\*\*\s*(\S+)/m);
    if (!m) continue;
    const key = normalizePostingUrl(m[1]);
    const existing = index.get(key);
    if (!existing || num > existing.num) index.set(key, { num, file: path.join(dir, f) });
  }
  return index;
}

/**
 * @typedef {Object} PrepareItem
 * @property {string} url
 * @property {number|null} reportNum - Existing report to tailor against, or null.
 * @property {string|null} reportFile - Absolute path of that report, or null.
 * @property {string} company - Best-known company (inbox row / report slug / "").
 * @property {string} role
 * @property {boolean} needsBackfill - No report exists; reserve + backfill TSV.
 * @property {string|null} error - Unresolvable: no report AND no inbox row.
 */

/**
 * Resolve each shortlist URL to a prepare work item. Resolution order:
 * (1) a prior prepare-state row for this URL (keeps re-runs of a backfilled
 * batch from reserving a second number), (2) the reports index (the common
 * all-evaluated case), (3) the inbox row (company/role for the reserve +
 * backfill path). A URL matching none of the three fails at dispatch — the
 * server-side twin of the client estimate's "blocked" bucket.
 * @param {{urls: string[], reportIndex: Map<string, {num: number, file: string}>, inbox: {url: string, company: string, role: string}[], state?: Map<string, object>}} args
 * @returns {PrepareItem[]}
 */
export function resolvePrepareItems({ urls, reportIndex, inbox, state = new Map() }) {
  const inboxByUrl = new Map(inbox.map((j) => [normalizePostingUrl(j.url), j]));
  return urls.map((url) => {
    const key = normalizePostingUrl(url);
    const hit = reportIndex.get(key);
    const row = inboxByUrl.get(key);
    const prior = state.get(key);
    const priorNum = prior && /^\d+$/.test(String(prior.report ?? "")) ? parseInt(prior.report, 10) : null;
    if (!hit && priorNum !== null) {
      // Backfilled on an earlier run: the number exists in the tracker but no
      // report file does, so the reports index can't see it. Reuse it.
      return { url, reportNum: priorNum, reportFile: null, company: row?.company ?? "", role: row?.role ?? "", needsBackfill: false, error: null };
    }
    if (hit) {
      const slugMatch = path.basename(hit.file).match(/^\d+-(.+)-\d{4}-\d{2}-\d{2}\.md$/);
      return { url, reportNum: hit.num, reportFile: hit.file, company: row?.company ?? slugMatch?.[1] ?? "", role: row?.role ?? "", needsBackfill: false, error: null };
    }
    if (row) {
      return { url, reportNum: null, reportFile: null, company: row.company, role: row.role, needsBackfill: true, error: null };
    }
    return {
      url, reportNum: null, reportFile: null, company: "", role: "", needsBackfill: false,
      error: "No evaluation report or inbox entry matches this URL — evaluate it first.",
    };
  });
}

/** Strip characters that would break a markdown table cell / TSV field. */
function cell(s) {
  return String(s ?? "").replace(/[|\t\r\n]+/g, " ").trim();
}

/** Lowercase slug, same convention as pdf-paths.mjs. */
function slug(s) {
  return String(s).toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "") || "company";
}

/**
 * The 10-column backfill TSV row for an item with no evaluation yet — score
 * sentinel `N/A` (#1799), root-relative report link, trailing posting URL (the
 * deterministic dedup key). Status `Evaluated` per the bulk-prepare contract:
 * the prepared lifecycle position reuses that canonical state + the Notes
 * marker; no novel state may reach the tracker.
 * @param {{num: number, date: string, company: string, role: string, url: string}} args
 * @returns {{line: string, fileName: string}}
 */
export function backfillTsvRow({ num, date, company, role, url }) {
  const n = String(num).padStart(3, "0");
  const s = slug(company);
  const line = [
    n, date, cell(company), cell(role), "Evaluated", "N/A", "❌",
    `[${n}](reports/${n}-${s}-${date}.md)`,
    "prepared from web; no evaluation yet", cell(url),
  ].join("\t") + "\n";
  return { line, fileName: `${n}-${s}.tsv` };
}

/**
 * The headless tailor-worker prompt — the pdf arm's CONTENT rules (modeled on
 * run-prompts.mjs's pdf prompt + batch-tailor's worker prompt), except this
 * worker Writes its output to the two precomputed scratch paths instead of
 * emitting an envelope: the backend renders and stamps, the worker only
 * tailors and drafts. Paths are root-relative (the worker's cwd is the
 * checkout root) and precomputed by the backend — the agent never chooses its
 * own filenames.
 * @param {{reportNum: number, reportFile: string|null, url: string, htmlRel: string, answersRel: string}} args
 * @returns {string}
 */
export function buildTailorPrompt({ reportNum, reportFile, url, htmlRel, answersRel }) {
  const n = String(reportNum).padStart(3, "0");
  const source = reportFile
    ? `and the evaluation report at reports/${path.basename(reportFile)} (for the JD keywords + analysis)`
    : `then read the job posting itself with WebFetch (no evaluation report exists yet): ${url}`;
  return `You are bulk-preparing ONE application, headless, on the user's machine: tailoring their ATS-optimized CV for report #${n}. Run the REAL career-ops "pdf" mode's CONTENT step: follow modes/pdf.md's TAILORING rules exactly (do not improvise your own scoring or format). Its build/save/render steps are NOT performed here; the platform renders and updates the tracker itself.
1. Read modes/pdf.md, cv.md, config/profile.yml, ${source}.
2. Tailor the CV per modes/pdf.md: inject the JD's keywords into the summary + first bullets, reorder experience by relevance, build the competency grid, pick the top 3-4 projects. NEVER invent skills — only reword REAL experience using the JD's vocabulary.
3. Fill templates/cv-template.html's {{...}} placeholders with the tailored content and Write the COMPLETE resulting HTML to ${htmlRel} — EXACTLY that path, overwriting it if present. The platform precomputed it and renders the PDF from it.
4. Draft the application's likely form answers from the posting/report (short motivation text, availability, work authorization — only facts backed by cv.md/config/profile.yml, never invented) and Write them as JSON to ${answersRel} with keys freeText, selections, fieldValues (empty objects are fine when nothing applies).
5. Render nothing, submit nothing, contact no one, fill no live forms. Do not run generate-pdf.mjs, do not edit data/applications.md — the platform renders the PDF and stamps the tracker only after a confirmed render.

After both files are written, end with EXACTLY one final line: VERDICT: {5 if both files were written, else 1}/5 — {summary, <=12 words}`;
}

// ── prepare-state.tsv — resumable per-item progress ─────────────────────────
//
// A SEPARATE file from batch/batch-state.tsv on purpose: merge-tracker.mjs
// cross-checks batch-state's failed column against tracker merges, so sharing
// that file would let prepare rows veto unrelated evaluation merges. Same
// 9-column schema (batch-runner.sh's writer).

const STATE_HEADER = "id\turl\tstatus\tstarted\tcompleted\treport\tscore\terror\tretries";

/** @param {string} root @returns {string} */
export function prepareStateFile(root) {
  return path.join(root, "batch", "prepare-state.tsv");
}

/**
 * Read prepare-state.tsv → Map<normalizedUrl, row>. Missing file → empty map.
 * @param {string} file
 * @returns {Map<string, {id: string, url: string, status: string, started: string, completed: string, report: string, score: string, error: string, retries: string}>}
 */
export function readPrepareState(file) {
  const map = new Map();
  let text;
  try {
    text = fs.readFileSync(file, "utf8");
  } catch {
    return map;
  }
  for (const line of text.split("\n")) {
    if (!line.trim() || line.startsWith("id\t")) continue;
    const [id, url, status, started, completed, report, score, error, retries] = line.split("\t");
    if (!url) continue;
    map.set(normalizePostingUrl(url), { id: id ?? "", url, status: status ?? "", started: started ?? "", completed: completed ?? "", report: report ?? "", score: score ?? "", error: error ?? "", retries: retries ?? "0" });
  }
  return map;
}

/**
 * Upsert one row (keyed by normalized URL) and atomically rewrite the file.
 * @param {{file: string, row: {id: string, url: string, status: string, started?: string, completed?: string, report?: string, score?: string, error?: string, retries?: string}, atomicWrite: (file: string, content: string) => void}} args
 */
export function upsertPrepareState({ file, row, atomicWrite }) {
  const map = readPrepareState(file);
  map.set(normalizePostingUrl(row.url), {
    started: "", completed: "", report: "", score: "", error: "", retries: "0",
    ...map.get(normalizePostingUrl(row.url)), ...row,
  });
  const lines = [STATE_HEADER];
  for (const r of map.values()) {
    lines.push([r.id, r.url, r.status, r.started, r.completed, r.report, r.score, cell(r.error), r.retries].join("\t"));
  }
  atomicWrite(file, lines.join("\n") + "\n");
}

/**
 * Parse reserve-report-num.mjs stdout (`NNN` or `NNN-MMM`) into numbers.
 * @param {string} stdout
 * @returns {number[]|null}
 */
export function parseReservedRange(stdout) {
  const line = String(stdout ?? "").trim().split("\n").filter(Boolean).pop() ?? "";
  const m = line.match(/^(\d+)(?:-(\d+))?$/);
  if (!m) return null;
  const start = parseInt(m[1], 10);
  const end = m[2] ? parseInt(m[2], 10) : start;
  if (end < start) return null;
  return Array.from({ length: end - start + 1 }, (_, i) => start + i);
}

/**
 * Run one Node child (a core script) to completion.
 * @param {{spawnFn: Function, execPath: string, args: string[], cwd: string, env?: object, timeoutMs?: number}} args
 * @returns {Promise<{code: number|null, stdout: string, stderr: string, timedOut: boolean}>}
 */
export function runNodeScript({ spawnFn, execPath, args, cwd, env, timeoutMs = CORE_SCRIPT_TIMEOUT_MS }) {
  return new Promise((resolve) => {
    const child = spawnFn(execPath, args, { cwd, env });
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    const killer = setTimeout(() => {
      timedOut = true;
      try { child.kill("SIGTERM"); } catch { /* ignore */ }
    }, timeoutMs);
    child.stdout?.on("data", (d) => { stdout += d.toString(); });
    child.stderr?.on("data", (d) => { stderr += d.toString(); });
    child.on("close", (code) => { clearTimeout(killer); resolve({ code, stdout, stderr, timedOut }); });
    child.on("error", (e) => { clearTimeout(killer); resolve({ code: null, stdout, stderr: stderr || e.message, timedOut }); });
  });
}

/**
 * Run one headless tailor worker (Claude only — the tailor tool grant is
 * enforced by claude-invocation.mjs scopes, which no other CLI honors) and
 * fold its stream-json output into events + a verdict on the run.
 * @param {{spawnWorker: Function, binPath: string, prompt: string, cwd: string, env: object, killMs: number, signal: {aborted: boolean, kill: Function|null}, emit: (obj: object) => void}} args
 * @returns {Promise<{cleanExit: boolean, sawError: boolean, timedOut: boolean, tokens: number, costUsd: number|null, errorMsg: string}>}
 */
export function runTailorWorker({ spawnWorker, binPath, prompt, cwd, env, killMs, signal, emit }) {
  return new Promise((resolve) => {
    const child = spawnWorker(binPath, claudeCliArgs({ kind: "tailor", prompt }), { cwd, env });
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    let buf = "";
    let stderrBuf = "";
    let sawError = false;
    let errorMsg = "";
    let tokens = 0;
    let costUsd = null;
    let timedOut = false;
    signal.kill = () => { try { child.kill("SIGTERM"); } catch { /* ignore */ } };
    const killer = setTimeout(() => { timedOut = true; signal.kill?.(); }, killMs);
    const processLine = (line) => {
      const ev = parseClaudeEvent(line);
      if (!ev) return;
      if (ev.text) emit({ type: "text", text: ev.text });
      if (ev.tool) emit({ type: "tool", name: ev.tool });
      tokens = accumulateTokens(tokens, ev);
      if (typeof ev.costUsd === "number") costUsd = (costUsd ?? 0) + ev.costUsd;
      if (ev.error) { sawError = true; errorMsg = errorMsg || ev.error.slice(0, 200); }
    };
    const flagStderr = (line) => {
      if (line.trim() && isFatalClaudeStderr(line)) { sawError = true; errorMsg = errorMsg || line.trim().slice(0, 200); }
    };
    child.stdout.on("data", (chunk) => {
      buf += chunk;
      let nl;
      while ((nl = buf.indexOf("\n")) !== -1) {
        const line = buf.slice(0, nl).trim();
        buf = buf.slice(nl + 1);
        if (line) processLine(line);
      }
    });
    child.stderr.on("data", (chunk) => {
      stderrBuf += chunk;
      let nl;
      while ((nl = stderrBuf.indexOf("\n")) !== -1) {
        flagStderr(stderrBuf.slice(0, nl));
        stderrBuf = stderrBuf.slice(nl + 1);
      }
    });
    child.on("error", (e) => {
      clearTimeout(killer);
      signal.kill = null;
      resolve({ cleanExit: false, sawError: true, timedOut, tokens, costUsd, errorMsg: e.message });
    });
    child.on("close", (code) => {
      clearTimeout(killer);
      signal.kill = null;
      if (stderrBuf) flagStderr(stderrBuf);
      const trailing = buf.trim();
      if (trailing) processLine(trailing);
      resolve({ cleanExit: code === 0, sawError, timedOut, tokens, costUsd, errorMsg });
    });
  });
}

/**
 * @typedef {Object} PrepareDeps
 * @property {string} root - careerOpsRoot(): scripts and the workers' cwd.
 * @property {string} [userRoot] - userRoot(): reports, output, prepare state. Defaults to root.
 * @property {string} [preamble] - profilePreamble(), prefixed to each tailor prompt.
 * @property {string} execPath - process.execPath.
 * @property {string} binPath - The agent CLI binary (Claude).
 * @property {string} today - YYYY-MM-DD.
 * @property {string[]} urls
 * @property {(obj: object) => void} emit - One NDJSON event.
 * @property {{aborted: boolean, kill: Function|null}} signal - Client-disconnect flag; the route flips `aborted` and calls `kill`.
 * @property {Function} spawnFn - node:child_process.spawn (plain children).
 * @property {Function} spawnWorker - spawnHeadlessCli (agent CLI, stdin closed).
 * @property {(file: string, content: string) => void} atomicWrite - safe-write.ts's.
 * @property {{url: string, company: string, role: string}[]} inbox - readInbox().
 * @property {(name: string) => string} rootScript - career-ops.ts's (no literal ".mjs" here — bundler rule).
 * @property {(report: string) => string|null} [currentStatus] - The tracker row's
 *   CURRENT canonical status by padded report number (the approve route's
 *   resolution); null when no row matches or its status isn't canonical.
 * @property {object} [env] - Base env for children.
 */

/**
 * Run the whole prepare batch SEQUENTIALLY, emitting the NDJSON event
 * vocabulary /api/run's client parser already understands, plus per-item
 * {type:"item"} outcomes. Honesty gate per item: "prepared" ONLY after clean
 * worker exit + scratch HTML exists + render-ok + set-status exit 0; anything
 * else is item:failed and the batch continues.
 * @param {PrepareDeps} deps
 */
export async function runPrepareBatch(deps) {
  const { root, execPath, binPath, today, urls, emit, signal, spawnFn, spawnWorker, atomicWrite, inbox, rootScript, currentStatus } = deps;
  const baseEnv = deps.env ?? process.env;
  const userRoot = deps.userRoot ?? root;
  const stateFile = prepareStateFile(userRoot);
  const now = () => new Date().toISOString();
  let prepared = 0;
  let failed = 0;
  let tokens = 0;
  let costUsd = null;

  const saveState = (row) => upsertPrepareState({ file: stateFile, row, atomicWrite });
  const failItem = (item, error) => {
    failed++;
    const report = item.reportNum !== null ? String(item.reportNum).padStart(3, "0") : "";
    emit({ type: "item", url: item.url, report, status: "failed", error });
    const prior = readPrepareState(stateFile).get(normalizePostingUrl(item.url));
    saveState({ id: report || slug(item.url), url: item.url, status: "failed", completed: now(), report, error, retries: String((parseInt(prior?.retries ?? "0", 10) || 0) + 1) });
  };

  emit({ type: "status", label: "Resolving shortlist…" });
  const items = resolvePrepareItems({ urls, reportIndex: indexReportsByUrl(userRoot), inbox, state: readPrepareState(stateFile) });
  for (const item of items.filter((i) => i.error)) failItem(item, item.error);

  // ── reserve + backfill (only items with no report at all) ────────────────
  const toBackfill = items.filter((i) => i.needsBackfill && !i.error);
  if (toBackfill.length > 0) {
    emit({ type: "status", label: `Reserving ${toBackfill.length} report number${toBackfill.length > 1 ? "s" : ""}…` });
    const res = await runNodeScript({ spawnFn, execPath, args: [rootScript("reserve-report-num"), "--count", String(toBackfill.length)], cwd: root, env: baseEnv });
    const nums = res.code === 0 ? parseReservedRange(res.stdout) : null;
    if (!nums || nums.length !== toBackfill.length) {
      for (const item of toBackfill) failItem(item, "Could not reserve a report number for this application.");
    } else {
      toBackfill.forEach((item, i) => { item.reportNum = nums[i]; });
      // Backfill rows land through the ONLY row-adding path: TSV + merge-tracker.
      // merge-tracker reads CAREER_OPS_ADDITIONS when a profile sets it.
      const dir = baseEnv.CAREER_OPS_ADDITIONS || path.join(root, "batch", "tracker-additions");
      for (const item of toBackfill) {
        const { line, fileName } = backfillTsvRow({ num: item.reportNum, date: today, company: item.company, role: item.role, url: item.url });
        atomicWrite(path.join(dir, fileName), line);
      }
      const merge = await runNodeScript({ spawnFn, execPath, args: [rootScript("merge-tracker")], cwd: root, env: baseEnv });
      if (merge.code !== 0) {
        const range = nums.length === 1 ? String(nums[0]) : `${nums[0]}-${nums[nums.length - 1]}`;
        await runNodeScript({ spawnFn, execPath, args: [rootScript("reserve-report-num"), "--release", range], cwd: root, env: baseEnv });
        for (const item of toBackfill) { item.reportNum = null; failItem(item, "Backfilling the tracker row failed (merge-tracker error)."); }
      }
    }
  }

  // ── sequential tailor → render → answers → stamp per item ────────────────
  const work = items.filter((i) => i.reportNum !== null);
  const priorState = readPrepareState(stateFile);
  const alreadyDone = (item) => {
    const prior = priorState.get(normalizePostingUrl(item.url));
    return prior?.status === "completed" && prior.report === String(item.reportNum).padStart(3, "0");
  };
  // Budget only the items that will actually run — see perWorkerKillMs.
  const killMs = perWorkerKillMs(work.filter((i) => !alreadyDone(i)).length);
  for (let i = 0; i < work.length; i++) {
    if (signal.aborted) break;
    const item = work[i];
    const n3 = String(item.reportNum).padStart(3, "0");
    if (alreadyDone(item)) {
      // Resumable batch: this row already prepared on an earlier run.
      prepared++;
      emit({ type: "item", url: item.url, report: n3, status: "prepared" });
      continue;
    }
    const label = item.company || item.url;
    emit({ type: "status", label: `Tailoring ${i + 1}/${work.length} — ${label}` });
    saveState({ id: n3, url: item.url, status: "pending", started: now(), report: n3 });

    // Scratch paths come from resolvePdfPaths, called with the PADDED number so
    // every artifact agrees on one basename (cv-web-012.html — what the review
    // queue looks up and what renderAndMarkPdf's cleanup prefix matches). The
    // finder answer is the item's own report file — NOT career-ops.ts's
    // findReportFile, which resolves tracker ROW numbers, a different number
    // space — with a synthetic basename for backfilled items so the company
    // slug still resolves (resolvePdfPaths only reads the basename off it).
    const synthetic = path.join(userRoot, "reports", `${n3}-${slug(item.company)}-${today}.md`);
    const paths = resolvePdfPaths(n3, today, userRoot, () => item.reportFile ?? synthetic);
    if (!paths.ok) { failItem(item, paths.error); continue; }
    const htmlPath = paths.paths.html;
    const answersPath = path.join(path.dirname(htmlPath), `answers-web-${n3}.json`);
    // A stale file from an earlier failed run must not fake a fresh success.
    for (const f of [htmlPath, answersPath]) { try { fs.rmSync(f, { force: true }); } catch { /* ignore */ } }

    const prompt = (deps.preamble ?? "") + buildTailorPrompt({
      reportNum: item.reportNum, reportFile: item.reportFile, url: item.url,
      htmlRel: path.relative(root, htmlPath).split(path.sep).join("/"),
      answersRel: path.relative(root, answersPath).split(path.sep).join("/"),
    });
    const run = await runTailorWorker({ spawnWorker, binPath, prompt, cwd: root, env: baseEnv, killMs, signal, emit });
    tokens += run.tokens;
    if (typeof run.costUsd === "number") costUsd = (costUsd ?? 0) + run.costUsd;
    if (signal.aborted) break;
    if (run.timedOut) { failItem(item, `The tailor worker passed its ${Math.round(killMs / 1000)}s slice of the batch budget and was stopped.`); continue; }
    if (!run.cleanExit || run.sawError) { failItem(item, run.errorMsg || "The tailor worker hit an error before finishing."); continue; }
    if (!fs.existsSync(htmlPath)) { failItem(item, "The worker finished but didn't write the tailored CV."); continue; }

    emit({ type: "status", label: `Rendering PDF — ${label}` });
    // renderAndMarkPdf sweeps the scratch dir after rendering, but the review
    // queue diffs against this exact HTML — hold it and restore it after.
    let htmlContent = null;
    try { htmlContent = fs.readFileSync(htmlPath, "utf8"); } catch { /* gate above saw it; race is theoretical */ }
    const render = await renderAndMarkPdf({ spawnFn, execPath, root, env: deps.env, pdfPaths: paths.paths, format: "letter", reportNum: n3 });
    if (render.kind === "render-failed") { failItem(item, render.error.slice(0, 200)); continue; }
    for (const w of render.warnings) emit({ type: "text", text: `⚠️ ${w}\n` });
    if (htmlContent !== null) atomicWrite(htmlPath, htmlContent);

    // Drafted form answers → the report's "## Application Answers" section.
    // Non-fatal: the CV + PDF are the deliverable; a missing answers file or a
    // backfilled item (no report file to upsert into) only loses the draft.
    if (item.reportFile && fs.existsSync(answersPath)) {
      const ans = await runNodeScript({ spawnFn, execPath, args: [rootScript("application-answers"), "--report", item.reportFile, "--input", answersPath, "--state", "filled", "--date", today], cwd: root, env: baseEnv });
      if (ans.code !== 0) emit({ type: "text", text: `⚠️ Drafted answers weren't saved into report #${n3}.\n` });
    }

    emit({ type: "status", label: `Stamping — ${label}` });
    // Pass the row's CURRENT canonical status back (same guard as the approve
    // route) so the status write is a guaranteed no-op and only the --note
    // marker lands — re-preparing a row the user already advanced (Applied,
    // Responded…) must not downgrade it. Rows this batch just backfilled
    // resolve to their freshly merged "Evaluated"; the fallback covers a row
    // set-status will reject on its own anyway (missing, or non-canonical).
    const stampStatus = currentStatus?.(n3) ?? "Evaluated";
    const stamp = await runNodeScript({
      spawnFn, execPath,
      args: [rootScript("set-status"), "--report", n3, stampStatus, "--note", PREPARED_NOTE, "--source", "web", "--json"],
      cwd: root, env: { ...baseEnv, ...boundedLockWaitEnv(baseEnv) },
    });
    if (stamp.code !== 0 || stamp.timedOut) {
      const parsed = parseCliJson(stamp.stdout);
      failItem(item, `Artifacts are ready but the tracker wasn't stamped: ${typeof parsed?.error === "string" ? parsed.error : "set-status failed"}`);
      continue;
    }
    prepared++;
    saveState({ id: n3, url: item.url, status: "completed", completed: now(), report: n3, error: "" });
    emit({ type: "item", url: item.url, report: n3, status: "prepared" });
  }

  emit({ type: "done", prepared, failed, tokens, costUsd });
}
