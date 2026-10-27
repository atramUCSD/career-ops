// withFileLock must share the core's lock directory for the same path (so a
// core writer and a web route exclude each other), fail fast as FileBusyError,
// and surface that as 409 through configErrorResponse.
//
// Run:  node --experimental-strip-types --test tests/lib/file-lock.test.mjs

import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import "../helpers/web-ts-alias-loader.mjs";

const CORE = path.resolve(import.meta.dirname, "../../..");
process.env.CAREER_OPS_CODE_ROOT = CORE;
process.env.CAREER_OPS_WEB_LOCK_TIMEOUT_MS = "300";

const { withFileLock, FileBusyError } = await import("../../src/lib/core/file-lock.ts");
const { configErrorResponse } = await import("../../src/lib/yaml-doc.mjs");
const { acquirePipelineLock } = await import(pathToFileURL(path.join(CORE, "pipeline-lock.mjs")).href);

test("a core holder makes the web writer answer busy, then it runs after release", async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "web-file-lock-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, "profile.yml");

  const held = await acquirePipelineLock(file, { timeoutMs: 1_000 });
  let ran = false;
  const err = await withFileLock(file, () => { ran = true; }).catch((e) => e);
  assert.ok(err instanceof FileBusyError, String(err));
  assert.equal(ran, false);
  assert.equal(configErrorResponse(err).status, 409);
  await held.release();

  assert.equal(await withFileLock(file, () => "written"), "written");
  assert.equal(fs.existsSync(`${file}.lock`), false, "released on success");
});

test("an error inside fn passes through and still releases", async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "web-file-lock-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, "cv.md");
  await assert.rejects(withFileLock(file, () => { throw new Error("boom"); }), /boom/);
  assert.equal(fs.existsSync(`${file}.lock`), false);
});
