// System-layer files (templates/, modes/) come from the engine checkout, not the
// data root. Under a data-only CAREER_OPS_ROOT, states.yml read from the data
// root was missing, so readCanonicalStates() silently fell back to labels with no
// aliases, and the AI explore route lost its discover.md prompt.
//
// Run: cd web && node --experimental-strip-types --test tests/lib/code-file.test.mjs

import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { listTree } from "../../../lib/walk-tree.mjs";

test("states and mode prompts resolve from the checkout under a data-only root", async () => {
  await import("../helpers/web-ts-alias-loader.mjs");
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "code-file-"));
  const saved = { ROOT: process.env.CAREER_OPS_ROOT, DATA: process.env.CAREER_OPS_DATA_DIR };
  process.env.CAREER_OPS_ROOT = root;
  process.env.CAREER_OPS_DATA_DIR = "";
  try {
    const { codeFile, careerOpsRoot } = await import("../../src/lib/career-ops.ts");
    const { readCanonicalStates } = await import("../../src/lib/core/states.ts");
    assert.equal(careerOpsRoot(), root);
    // The fallback carries no aliases, so any alias proves states.yml was read.
    assert.ok(readCanonicalStates().some((s) => s.aliases.length > 0), "states.yml was not read");
    // modes/cv-ingest.md is not shipped yet; its route falls back to an inline prompt.
    for (const rel of [["templates", "portals.example.yml"], ["modes", "discover.md"]]) {
      assert.ok(fs.existsSync(codeFile(...rel)), rel.join("/"));
    }
  } finally {
    for (const [k, v] of [["CAREER_OPS_ROOT", saved.ROOT], ["CAREER_OPS_DATA_DIR", saved.DATA]]) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("no web source reads templates/ or modes/ from the data root", () => {
  const src = path.join(import.meta.dirname, "..", "..", "src");
  const offenders = [];
  for (const file of listTree(src, { match: /\.(ts|tsx|mjs)$/ })) {
    const text = fs.readFileSync(file, "utf8");
    if (/careerOpsRoot\(\)\s*,\s*["'](templates|modes)["']/.test(text)) offenders.push(path.relative(src, file));
  }
  assert.deepEqual(offenders, []);
});
