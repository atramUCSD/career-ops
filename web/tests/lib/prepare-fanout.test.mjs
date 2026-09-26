// Tests for prepare-fanout.mjs — the bulk-prepare fan-out — using Node's
// built-in test runner. Everything process-shaped is injected, so no real
// agent CLI or core script is ever spawned: spawnFn/spawnWorker are fake
// EventEmitter children, and the batch runs against a throwaway tmp root.
//
// Run:  node --test tests/lib/prepare-fanout.test.mjs

import { test } from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { claudeCliArgs, argValue, toolNames } from "../../src/lib/claude-invocation.mjs";
import {
  MAX_PREPARE_BATCH,
  PREPARED_NOTE,
  perWorkerKillMs,
  boundedLockWaitEnv,
  normalizePostingUrl,
  indexReportsByUrl,
  resolvePrepareItems,
  backfillTsvRow,
  buildTailorPrompt,
  prepareStateFile,
  readPrepareState,
  upsertPrepareState,
  parseReservedRange,
  runNodeScript,
  runTailorWorker,
  runPrepareBatch,
} from "../../src/lib/prepare-fanout.mjs";

const atomicWrite = (file, content) => {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, content);
};

/** A fake child_process result; body(child) runs before "close" fires. */
function fakeChild({ stdoutLines = [], stderr = "", exitCode = 0, spawnError = null, body = null } = {}) {
  const child = new EventEmitter();
  child.stdout = new EventEmitter();
  child.stdout.setEncoding = () => {};
  child.stderr = new EventEmitter();
  child.stderr.setEncoding = () => {};
  child.kill = () => {};
  queueMicrotask(() => {
    if (spawnError) {
      child.emit("error", spawnError);
      return;
    }
    body?.(child);
    for (const line of stdoutLines) child.stdout.emit("data", line + "\n");
    if (stderr) child.stderr.emit("data", stderr);
    child.emit("close", exitCode);
  });
  return child;
}

function tmpRoot() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "prep-fanout-"));
}

function writeReport(root, name, url) {
  const dir = path.join(root, "reports");
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, name), `# Report\n\n**URL:** ${url}\n\nbody\n`);
}

// ── small pure helpers ──────────────────────────────────────────────────────

test("normalizePostingUrl strips fragments and trailing slashes", () => {
  assert.equal(normalizePostingUrl("https://x.test/jobs/1/#apply"), "https://x.test/jobs/1");
  assert.equal(normalizePostingUrl("https://X.test/jobs/1"), "https://x.test/jobs/1");
  assert.equal(normalizePostingUrl("not a url/#frag"), "not a url");
  assert.equal(normalizePostingUrl("  https://x.test/a  "), "https://x.test/a");
});

test("perWorkerKillMs splits the run budget across the batch", () => {
  assert.equal(perWorkerKillMs(1), 780_000);
  assert.equal(perWorkerKillMs(10), 78_000);
  assert.equal(perWorkerKillMs(0), 780_000);
  assert.ok(MAX_PREPARE_BATCH <= 10);
});

test("boundedLockWaitEnv defaults and caps below the child kill timeout", () => {
  assert.deepEqual(boundedLockWaitEnv({}), { CAREER_OPS_TRACKER_LOCK_TIMEOUT_MS: "10000" });
  assert.deepEqual(
    boundedLockWaitEnv({ CAREER_OPS_TRACKER_LOCK_TIMEOUT_MS: "60000" }),
    { CAREER_OPS_TRACKER_LOCK_TIMEOUT_MS: "25000" },
  );
  assert.deepEqual(
    boundedLockWaitEnv({ CAREER_OPS_TRACKER_LOCK_TIMEOUT_MS: "3000" }),
    { CAREER_OPS_TRACKER_LOCK_TIMEOUT_MS: "3000" },
  );
});

test("parseReservedRange reads NNN and NNN-MMM, rejects junk", () => {
  assert.deepEqual(parseReservedRange("042\n"), [42]);
  assert.deepEqual(parseReservedRange("noise\n042-044\n"), [42, 43, 44]);
  assert.equal(parseReservedRange("044-042"), null);
  assert.equal(parseReservedRange("nope"), null);
  assert.equal(parseReservedRange(""), null);
});

test("indexReportsByUrl indexes by **URL:** header, highest number wins, skips RESERVED", () => {
  const root = tmpRoot();
  try {
    writeReport(root, "001-acme-2026-08-01.md", "https://x.test/jobs/1#src");
    writeReport(root, "005-acme-2026-08-10.md", "https://x.test/jobs/1");
    writeReport(root, "003-beta-2026-08-05.md", "https://x.test/jobs/2/");
    fs.writeFileSync(path.join(root, "reports", "009-RESERVED.md"), "");
    const idx = indexReportsByUrl(root);
    assert.equal(idx.get("https://x.test/jobs/1").num, 5);
    assert.equal(idx.get("https://x.test/jobs/2").num, 3);
    assert.equal(idx.size, 2);
    assert.equal(indexReportsByUrl(path.join(root, "missing")).size, 0);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("resolvePrepareItems: report hit / inbox backfill / prior-state reuse / unresolvable", () => {
  const reportIndex = new Map([["https://x.test/jobs/1", { num: 5, file: "/r/005-acme-2026-08-10.md" }]]);
  const inbox = [{ url: "https://x.test/jobs/2", company: "Beta", role: "Dev" }];
  const state = new Map([["https://x.test/jobs/3", { report: "007", status: "failed" }]]);
  const items = resolvePrepareItems({
    urls: ["https://x.test/jobs/1", "https://x.test/jobs/2", "https://x.test/jobs/3", "https://x.test/jobs/4"],
    reportIndex,
    inbox,
    state,
  });
  assert.deepEqual(
    items.map((i) => [i.reportNum, i.needsBackfill, i.error !== null]),
    [[5, false, false], [null, true, false], [7, false, false], [null, false, true]],
  );
  assert.equal(items[0].company, "acme"); // from the report slug
  assert.equal(items[1].company, "Beta"); // from the inbox row
});

test("backfillTsvRow is a 10-column Evaluated row with an N/A score sentinel", () => {
  const { line, fileName } = backfillTsvRow({ num: 7, date: "2026-08-28", company: "Acme|Co", role: "Dev\tOps", url: "https://x.test/1" });
  assert.equal(fileName, "007-acme-co.tsv");
  const cols = line.trimEnd().split("\t");
  assert.equal(cols.length, 10);
  assert.deepEqual(cols.slice(0, 7), ["007", "2026-08-28", "Acme Co", "Dev Ops", "Evaluated", "N/A", "❌"]);
  assert.equal(cols[7], "[007](reports/007-acme-co-2026-08-28.md)");
  assert.equal(cols[9], "https://x.test/1");
});

test("buildTailorPrompt targets the precomputed paths and forbids rendering/submitting", () => {
  const withReport = buildTailorPrompt({
    reportNum: 5,
    reportFile: "/r/005-acme-2026-08-10.md",
    url: "https://x.test/1",
    htmlRel: ".career-ops-web/pdf-tmp/cv-web-005.html",
    answersRel: ".career-ops-web/pdf-tmp/answers-web-005.json",
  });
  assert.match(withReport, /reports\/005-acme-2026-08-10\.md/);
  assert.match(withReport, /cv-web-005\.html/);
  assert.match(withReport, /answers-web-005\.json/);
  assert.match(withReport, /submit nothing/);
  assert.match(withReport, /do not edit data\/applications\.md/);
  const withoutReport = buildTailorPrompt({
    reportNum: 7,
    reportFile: null,
    url: "https://x.test/2",
    htmlRel: "h.html",
    answersRel: "a.json",
  });
  assert.match(withoutReport, /WebFetch.*https:\/\/x\.test\/2/);
});

test("prepare-state roundtrip: upsert updates in place, keyed by normalized URL", () => {
  const root = tmpRoot();
  try {
    const file = prepareStateFile(root);
    assert.equal(readPrepareState(file).size, 0);
    upsertPrepareState({ file, row: { id: "005", url: "https://x.test/1", status: "pending", started: "t0" }, atomicWrite });
    upsertPrepareState({ file, row: { id: "005", url: "https://x.test/1/", status: "completed", completed: "t1", report: "005" }, atomicWrite });
    upsertPrepareState({ file, row: { id: "006", url: "https://x.test/2", status: "failed", error: "boom\twith tabs" }, atomicWrite });
    const map = readPrepareState(file);
    assert.equal(map.size, 2);
    const row = map.get("https://x.test/1");
    assert.equal(row.status, "completed");
    assert.equal(row.started, "t0"); // preserved from the first upsert
    assert.equal(row.report, "005");
    assert.equal(map.get("https://x.test/2").error, "boom with tabs"); // TSV-safe
    assert.match(fs.readFileSync(file, "utf8"), /^id\turl\tstatus\tstarted\tcompleted\treport\tscore\terror\tretries\n/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

// ── the worker child ────────────────────────────────────────────────────────

test("runTailorWorker spawns EXACTLY claudeCliArgs for the tailor kind and folds the stream", async () => {
  let seen = null;
  const spawnWorker = (bin, args) => {
    seen = { bin, args };
    return fakeChild({
      stdoutLines: [
        JSON.stringify({ type: "stream_event", event: { type: "content_block_delta", delta: { text: "hi" } } }),
        JSON.stringify({ type: "stream_event", event: { type: "content_block_start", content_block: { type: "tool_use", name: "Write" } } }),
        JSON.stringify({ type: "result", usage: { input_tokens: 100, output_tokens: 50 }, total_cost_usd: 0.05 }),
      ],
    });
  };
  const events = [];
  const run = await runTailorWorker({
    spawnWorker, binPath: "claude", prompt: "P", cwd: "/", env: {}, killMs: 780_000,
    signal: { aborted: false, kill: null }, emit: (e) => events.push(e),
  });
  assert.equal(seen.bin, "claude");
  // The argv is claudeCliArgs' verbatim — the lib spells no tool flag itself.
  assert.deepEqual(seen.args, claudeCliArgs({ kind: "tailor", prompt: "P" }));
  // And that argv carries the tailor scope: Write in, Bash and Task denied.
  assert.ok(toolNames(argValue(seen.args, "--allowedTools")).includes("Write"));
  assert.ok(toolNames(argValue(seen.args, "--disallowedTools")).includes("Bash"));
  assert.ok(toolNames(argValue(seen.args, "--disallowedTools")).includes("Task"));
  assert.deepEqual(run, { cleanExit: true, sawError: false, timedOut: false, tokens: 150, costUsd: 0.05, errorMsg: "" });
  assert.deepEqual(events, [{ type: "text", text: "hi" }, { type: "tool", name: "Write" }]);
});

test("runTailorWorker flags a failed result and a dirty exit", async () => {
  const spawnWorker = () =>
    fakeChild({ stdoutLines: [JSON.stringify({ type: "result", is_error: true, error: "max turns" })], exitCode: 1 });
  const run = await runTailorWorker({
    spawnWorker, binPath: "claude", prompt: "P", cwd: "/", env: {}, killMs: 780_000,
    signal: { aborted: false, kill: null }, emit: () => {},
  });
  assert.equal(run.cleanExit, false);
  assert.equal(run.sawError, true);
  assert.equal(run.errorMsg, "max turns");
});

// ── the whole batch ─────────────────────────────────────────────────────────

/**
 * A tmp-root batch harness. spawnFn dispatches on the script basename; the
 * worker fake writes the HTML path it finds in its own prompt (proving the
 * prompt actually carries the precomputed path).
 */
function batchHarness({ root, workerExitCode = 0, workerWrites = true, scripts = {} }) {
  const calls = { scripts: [], workers: [] };
  const spawnFn = (execPath, args) => {
    const script = path.basename(String(args[0])).replace(/\.mjs$/, "");
    calls.scripts.push([script, ...args.slice(1)]);
    const spec = scripts[script] ?? {};
    return fakeChild({ stdoutLines: spec.stdoutLines ?? [], exitCode: spec.exitCode ?? 0 });
  };
  const spawnWorker = (bin, args) => {
    const prompt = args[args.indexOf("-p") + 1];
    calls.workers.push(prompt);
    return fakeChild({
      exitCode: workerExitCode,
      stdoutLines: [JSON.stringify({ type: "result", usage: { input_tokens: 10, output_tokens: 5 }, total_cost_usd: 0.01 })],
      body: () => {
        if (!workerWrites || workerExitCode !== 0) return;
        const rel = prompt.match(/HTML to (\S+) —/)?.[1];
        assert.ok(rel, "prompt names the scratch HTML path");
        atomicWrite(path.join(root, rel), "<html>cv</html>");
        const ansRel = prompt.match(/JSON to (\S+) with keys/)?.[1];
        if (ansRel) atomicWrite(path.join(root, ansRel), JSON.stringify({ freeText: {}, selections: {}, fieldValues: {} }));
      },
    });
  };
  return { calls, spawnFn, spawnWorker };
}

const stampOk = { "set-status": { stdoutLines: ['{"ok":true,"changed":true,"statusLogged":true}'] } };

async function runBatch({ root, urls, inbox = [], harness, currentStatus }) {
  const events = [];
  await runPrepareBatch({
    root, execPath: "node", binPath: "claude", today: "2026-08-28", urls,
    emit: (e) => events.push(e),
    signal: { aborted: false, kill: null },
    spawnFn: harness.spawnFn,
    spawnWorker: harness.spawnWorker,
    atomicWrite,
    inbox,
    rootScript: (name) => path.join(root, `${name}.mjs`),
    currentStatus,
    env: {},
  });
  return events;
}

test("runPrepareBatch happy path: tailor → render → answers → stamp, honest item + done", async () => {
  const root = tmpRoot();
  try {
    writeReport(root, "005-acme-2026-08-10.md", "https://x.test/jobs/1");
    const harness = batchHarness({ root, scripts: stampOk });
    const events = await runBatch({ root, urls: ["https://x.test/jobs/1"], harness });

    const item = events.find((e) => e.type === "item");
    assert.deepEqual(item, { type: "item", url: "https://x.test/jobs/1", report: "005", status: "prepared" });
    const done = events.find((e) => e.type === "done");
    assert.deepEqual(done, { type: "done", prepared: 1, failed: 0, tokens: 15, costUsd: 0.01 });

    const names = harness.calls.scripts.map((c) => c[0]);
    assert.deepEqual(names, ["generate-pdf", "mark-pdf-ready", "application-answers", "set-status"]);
    const stamp = harness.calls.scripts.find((c) => c[0] === "set-status");
    assert.deepEqual(stamp.slice(1), ["--report", "005", "Evaluated", "--note", PREPARED_NOTE, "--source", "web", "--json"]);
    // No reserve for an already-evaluated batch.
    assert.ok(!names.includes("reserve-report-num"));
    // The tailored HTML survives for the review queue even though the render
    // path sweeps its scratch prefix.
    assert.ok(fs.existsSync(path.join(root, ".career-ops-web", "pdf-tmp", "cv-web-005.html")));
    // Resumable state row landed as completed.
    assert.equal(readPrepareState(prepareStateFile(root)).get("https://x.test/jobs/1").status, "completed");
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("runPrepareBatch stamps the row's CURRENT status — re-preparing an Applied row never downgrades it", async () => {
  const root = tmpRoot();
  try {
    writeReport(root, "005-acme-2026-08-10.md", "https://x.test/jobs/1");
    const harness = batchHarness({ root, scripts: stampOk });
    const events = await runBatch({
      root, urls: ["https://x.test/jobs/1"], harness,
      currentStatus: (report) => (report === "005" ? "Applied" : null),
    });
    const stamp = harness.calls.scripts.find((c) => c[0] === "set-status");
    assert.deepEqual(stamp.slice(1), ["--report", "005", "Applied", "--note", PREPARED_NOTE, "--source", "web", "--json"]);
    assert.equal(events.find((e) => e.type === "item").status, "prepared");
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("runPrepareBatch isolates a failed worker and keeps going", async () => {
  const root = tmpRoot();
  try {
    writeReport(root, "001-acme-2026-08-01.md", "https://x.test/jobs/1");
    writeReport(root, "002-beta-2026-08-02.md", "https://x.test/jobs/2");
    const harness = batchHarness({ root, scripts: stampOk });
    // First worker dies dirty, second succeeds.
    let n = 0;
    const inner = harness.spawnWorker;
    harness.spawnWorker = (bin, args) => {
      n++;
      if (n === 1) return fakeChild({ exitCode: 1 });
      return inner(bin, args);
    };
    const events = await runBatch({ root, urls: ["https://x.test/jobs/1", "https://x.test/jobs/2"], harness });
    const items = events.filter((e) => e.type === "item");
    assert.equal(items[0].status, "failed");
    assert.equal(items[0].report, "001");
    assert.ok(items[0].error);
    assert.deepEqual(items[1], { type: "item", url: "https://x.test/jobs/2", report: "002", status: "prepared" });
    const done = events.find((e) => e.type === "done");
    assert.equal(done.prepared, 1);
    assert.equal(done.failed, 1);
    assert.equal(readPrepareState(prepareStateFile(root)).get("https://x.test/jobs/1").status, "failed");
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("runPrepareBatch fails an item honestly when the worker never writes the HTML", async () => {
  const root = tmpRoot();
  try {
    writeReport(root, "001-acme-2026-08-01.md", "https://x.test/jobs/1");
    const harness = batchHarness({ root, workerWrites: false, scripts: stampOk });
    const events = await runBatch({ root, urls: ["https://x.test/jobs/1"], harness });
    const item = events.find((e) => e.type === "item");
    assert.equal(item.status, "failed");
    assert.match(item.error, /didn't write/);
    // Nothing rendered, nothing stamped.
    assert.deepEqual(harness.calls.scripts, []);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("runPrepareBatch fails an item when the stamp fails — artifacts are not silently 'prepared'", async () => {
  const root = tmpRoot();
  try {
    writeReport(root, "001-acme-2026-08-01.md", "https://x.test/jobs/1");
    const harness = batchHarness({
      root,
      scripts: { "set-status": { stdoutLines: ['{"ok":false,"code":"lock-timeout","error":"tracker is busy"}'], exitCode: 4 } },
    });
    const events = await runBatch({ root, urls: ["https://x.test/jobs/1"], harness });
    const item = events.find((e) => e.type === "item");
    assert.equal(item.status, "failed");
    assert.match(item.error, /tracker is busy/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("runPrepareBatch skips rows already completed in prepare-state.tsv (resume)", async () => {
  const root = tmpRoot();
  try {
    writeReport(root, "005-acme-2026-08-10.md", "https://x.test/jobs/1");
    upsertPrepareState({
      file: prepareStateFile(root),
      row: { id: "005", url: "https://x.test/jobs/1", status: "completed", completed: "t", report: "005" },
      atomicWrite,
    });
    const harness = batchHarness({ root, scripts: stampOk });
    const events = await runBatch({ root, urls: ["https://x.test/jobs/1"], harness });
    assert.equal(harness.calls.workers.length, 0);
    assert.deepEqual(harness.calls.scripts, []);
    const done = events.find((e) => e.type === "done");
    assert.equal(done.prepared, 1);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("runPrepareBatch streams item:failed for a URL nothing can resolve", async () => {
  const root = tmpRoot();
  try {
    const harness = batchHarness({ root, scripts: stampOk });
    const events = await runBatch({ root, urls: ["https://x.test/unknown"], harness });
    const item = events.find((e) => e.type === "item");
    assert.equal(item.status, "failed");
    assert.match(item.error, /evaluate it first/i);
    assert.deepEqual(events.find((e) => e.type === "done"), { type: "done", prepared: 0, failed: 1, tokens: 0, costUsd: null });
    assert.equal(harness.calls.workers.length, 0);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("runPrepareBatch backfills an inbox-only item: reserve → TSV → merge → tailor", async () => {
  const root = tmpRoot();
  try {
    const harness = batchHarness({
      root,
      scripts: { ...stampOk, "reserve-report-num": { stdoutLines: ["007"] } },
    });
    const events = await runBatch({
      root,
      urls: ["https://x.test/jobs/9"],
      inbox: [{ url: "https://x.test/jobs/9", company: "Gamma", role: "Dev" }],
      harness,
    });
    const names = harness.calls.scripts.map((c) => c[0]);
    assert.deepEqual(names, ["reserve-report-num", "merge-tracker", "generate-pdf", "mark-pdf-ready", "set-status"]);
    assert.deepEqual(harness.calls.scripts[0].slice(1), ["--count", "1"]);
    // The backfill row landed through the ONLY row-adding path.
    const tsv = fs.readFileSync(path.join(root, "batch", "tracker-additions", "007-gamma.tsv"), "utf8");
    assert.equal(tsv.trimEnd().split("\t").length, 10);
    assert.match(tsv, /\tEvaluated\t/);
    // No report file → the worker is told to WebFetch the posting itself.
    assert.match(harness.calls.workers[0], /WebFetch/);
    assert.deepEqual(events.find((e) => e.type === "item"), { type: "item", url: "https://x.test/jobs/9", report: "007", status: "prepared" });
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("runPrepareBatch releases reserved numbers when merge-tracker fails", async () => {
  const root = tmpRoot();
  try {
    const harness = batchHarness({
      root,
      scripts: {
        ...stampOk,
        "reserve-report-num": { stdoutLines: ["007"] },
        "merge-tracker": { exitCode: 1 },
      },
    });
    const events = await runBatch({
      root,
      urls: ["https://x.test/jobs/9"],
      inbox: [{ url: "https://x.test/jobs/9", company: "Gamma", role: "Dev" }],
      harness,
    });
    const reserveCalls = harness.calls.scripts.filter((c) => c[0] === "reserve-report-num");
    assert.deepEqual(reserveCalls[1].slice(1), ["--release", "7"]);
    assert.equal(events.find((e) => e.type === "item").status, "failed");
    assert.equal(harness.calls.workers.length, 0);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("runNodeScript surfaces spawn errors without throwing", async () => {
  const res = await runNodeScript({
    spawnFn: () => fakeChild({ spawnError: new Error("ENOENT") }),
    execPath: "node", args: ["x"], cwd: "/",
  });
  assert.equal(res.code, null);
  assert.match(res.stderr, /ENOENT/);
});
