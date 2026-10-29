// Tests for data/ui-state.json: shortlist normalization and tolerant reads.
//
// Run:  node --test tests/lib/ui-state.test.mjs

import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { normalizeShortlist, readShortlist, readUiState, SHORTLIST_MAX } from "../../src/lib/ui-state.mjs";

test("normalizeShortlist keeps valid http(s) items, first per URL", () => {
  const out = normalizeShortlist([
    { url: "https://jobs.example/1", company: "Acme", role: "Engineer" },
    { url: "https://jobs.example/1", company: "Dupe", role: "Dupe" },
    { url: "javascript:alert(1)", company: "x", role: "x" },
    { url: "https://user:pw@jobs.example/2", company: "x", role: "x" },
    { url: "http://jobs.example/3", company: 7, role: null },
    null,
    "https://jobs.example/4",
  ]);
  assert.deepEqual(out, [
    { url: "https://jobs.example/1", company: "Acme", role: "Engineer" },
    { url: "http://jobs.example/3", company: "", role: "" },
  ]);
});

test("normalizeShortlist caps list length and text length", () => {
  const many = Array.from({ length: SHORTLIST_MAX + 5 }, (_, i) => ({ url: `https://jobs.example/${i}`, company: "c".repeat(400), role: "r" }));
  const out = normalizeShortlist(many);
  assert.equal(out.length, SHORTLIST_MAX);
  assert.equal(out[0].company.length, 300);
  assert.deepEqual(normalizeShortlist({ url: "https://jobs.example/1" }), []);
});

test("readUiState tolerates missing, corrupt and non-object files", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ui-state-"));
  try {
    const file = path.join(dir, "ui-state.json");
    assert.deepEqual(readUiState(file), {});
    fs.writeFileSync(file, "{not json");
    assert.deepEqual(readUiState(file), {});
    fs.writeFileSync(file, "[1,2]");
    assert.deepEqual(readUiState(file), {});
    fs.writeFileSync(file, JSON.stringify({ other: 1, shortlist: [{ url: "https://jobs.example/1", company: "A", role: "B" }, { url: "ftp://x" }] }));
    assert.deepEqual(readUiState(file).other, 1);
    assert.deepEqual(readShortlist(file), [{ url: "https://jobs.example/1", company: "A", role: "B" }]);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("shortlist route: PUT normalizes and keeps other keys, GET reads it back", async () => {
  await import("../helpers/web-ts-alias-loader.mjs");
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "ui-state-route-"));
  const saved = process.env.CAREER_OPS_ROOT;
  process.env.CAREER_OPS_ROOT = root;
  try {
    const file = path.join(root, "data", "ui-state.json");
    fs.mkdirSync(path.dirname(file));
    fs.writeFileSync(file, JSON.stringify({ other: true }));
    const { GET, PUT } = await import("../../src/app/api/inbox/shortlist/route.ts");
    const put = (body) => PUT(new Request("http://localhost/api/inbox/shortlist", { method: "PUT", headers: { "content-type": "application/json" }, body }));

    assert.equal((await put(JSON.stringify({ shortlist: "nope" }))).status, 400);
    const ok = await put(JSON.stringify({ shortlist: [{ url: "https://jobs.example/1", company: "A", role: "B" }, { url: "data:x" }] }));
    assert.equal(ok.status, 200);
    assert.deepEqual(JSON.parse(fs.readFileSync(file, "utf8")), { other: true, shortlist: [{ url: "https://jobs.example/1", company: "A", role: "B" }] });
    assert.deepEqual(await (await GET()).json(), { shortlist: [{ url: "https://jobs.example/1", company: "A", role: "B" }] });
  } finally {
    if (saved === undefined) delete process.env.CAREER_OPS_ROOT;
    else process.env.CAREER_OPS_ROOT = saved;
    fs.rmSync(root, { recursive: true, force: true });
  }
});
