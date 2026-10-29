// /api/board/[n]: card detail (GET) and the board activity log (POST) —
// validation, the JSONL append, field caps, and the 30-minute open dedupe.
// Driven through the real handlers against a temp CAREER_OPS_ROOT.
//
// Run: cd web && node --experimental-strip-types --test tests/lib/board-route.test.mjs

import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const ENV_KEYS = ["CAREER_OPS_CODE_ROOT", "CAREER_OPS_ROOT", "CAREER_OPS_DATA_DIR", "CAREER_OPS_TRACKER", "CAREER_OPS_PROFILES_DIR"];

const TRACKER = [
  "# Applications Tracker",
  "",
  "| # | Date | Company | Role | Score | Status | PDF | Report | Notes |",
  "|---|------|---------|------|-------|--------|-----|--------|-------|",
  "| 7 | 2026-01-01 | Acme | Engineer | 4.5/5 | Applied | ✅ | [7](../reports/007-acme-2026-01-01.md) | |",
  "",
].join("\n");

async function withBoard(fn, { busy = false } = {}) {
  await import("../helpers/web-ts-alias-loader.mjs");
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "board-route-"));
  const saved = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]));
  process.env.CAREER_OPS_ROOT = root;
  // The root doubles as the code checkout so the tracker-utils stand-in below is the one loaded.
  process.env.CAREER_OPS_CODE_ROOT = root;
  // Empty rather than deleted: each would pull a read out of the sandbox, and
  // dotenv only fills keys that are absent.
  process.env.CAREER_OPS_DATA_DIR = "";
  process.env.CAREER_OPS_TRACKER = "";
  process.env.CAREER_OPS_PROFILES_DIR = path.join(root, "profiles");
  try {
    fs.mkdirSync(path.join(root, "data"));
    fs.writeFileSync(path.join(root, "data", "applications.md"), TRACKER);
    // withTrackerLock imports the core lock from the code root; a stand-in keeps
    // the core's own packages out of web CI (same as apply-cv-resolver.test.mjs).
    fs.writeFileSync(path.join(root, "tracker-utils.mjs"), [
      "export const trackerLockDirFor = (t) => t + '.lock';",
      busy
        ? "export async function acquireTrackerLock() { throw Object.assign(new Error('held'), { code: 'LOCK_TIMEOUT' }); }"
        : "export async function acquireTrackerLock() { return { release() {} }; }",
    ].join("\n"));
    const { GET, POST } = await import("../../src/app/api/board/[n]/route.ts");
    const params = (n) => ({ params: Promise.resolve({ n }) });
    const post = (n, body) =>
      POST(new Request(`http://localhost/api/board/${n}`, { method: "POST", headers: { "content-type": "application/json" }, body }), params(n));
    const log = () => {
      const file = path.join(root, "data", "board-activity.jsonl");
      return fs.existsSync(file) ? fs.readFileSync(file, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l)) : [];
    };
    await fn({ root, get: (n) => GET(new Request(`http://localhost/api/board/${n}`), params(n)), post, log });
  } finally {
    for (const k of ENV_KEYS) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
    fs.rmSync(root, { recursive: true, force: true });
  }
}

test("board route: unknown or non-numeric rows are 404 on both verbs", () =>
  withBoard(async ({ get, post, log }) => {
    assert.equal((await get("99")).status, 404);
    assert.equal((await get("../7")).status, 404);
    assert.equal((await post("99", JSON.stringify({ kind: "open" }))).status, 404);
    assert.deepEqual(log(), []);
  }));

test("board route: POST rejects bad bodies without appending", () =>
  withBoard(async ({ post, log }) => {
    for (const body of ["{nope", "[1]", JSON.stringify({ kind: "delete" }), JSON.stringify({ kind: "comment", text: "   " }), JSON.stringify({ kind: "move", from: "Applied" })]) {
      assert.equal((await post("7", body)).status, 400, body);
    }
    assert.deepEqual(log(), []);
  }));

test("board route: comment and move are appended trimmed and capped, and GET shows them", () =>
  withBoard(async ({ get, post, log }) => {
    const comment = await (await post("7", JSON.stringify({ kind: "comment", text: `  ${"x".repeat(2100)}  ` }))).json();
    assert.equal(comment.event.text.length, 2000);
    await post("7", JSON.stringify({ kind: "move", from: "Evaluated", to: "I".repeat(50) }));
    const [c, m] = log();
    assert.equal(c.kind, "comment");
    assert.deepEqual([m.kind, m.from, m.to.length], ["move", "Evaluated", 40]);

    const res = await get("7");
    assert.equal(res.status, 200);
    const { app, timeline } = await res.json();
    assert.equal(app.company, "Acme");
    assert.deepEqual(timeline.map((e) => e.kind).sort(), ["comment", "evaluated", "move"]);
  }));

test("board route: a reopen within 30 minutes is not logged again", () =>
  withBoard(async ({ root, post, log }) => {
    const first = await (await post("7", JSON.stringify({ kind: "open" }))).json();
    assert.equal(first.event.kind, "open");
    assert.deepEqual(await (await post("7", JSON.stringify({ kind: "open" }))).json(), { ok: true });
    assert.equal(log().length, 1);

    const stale = { at: new Date(Date.now() - 31 * 60_000).toISOString(), n: "7", kind: "open" };
    fs.writeFileSync(path.join(root, "data", "board-activity.jsonl"), JSON.stringify(stale) + "\n");
    await post("7", JSON.stringify({ kind: "open" }));
    assert.equal(log().length, 2);
  }));

test("board route: a held tracker lock is a 409, not a lost append", () =>
  withBoard(async ({ post, log }) => {
    const res = await post("7", JSON.stringify({ kind: "comment", text: "hi" }));
    assert.equal(res.status, 409);
    assert.deepEqual(log(), []);
  }, { busy: true }));
