// /api/lanes: Home's lane editor rewrites title_keywords for named lanes in
// config/lanes.yml — body validation, unknown lanes, a missing or malformed
// file, and that a successful edit leaves the rest of the YAML alone.
// Driven through the real handler against a temp CAREER_OPS_ROOT.
//
// Run: cd web && node --experimental-strip-types --test tests/lib/lanes-route.test.mjs

import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const ENV_KEYS = ["CAREER_OPS_ROOT", "CAREER_OPS_DATA_DIR", "CAREER_OPS_PROFILES_DIR"];

const LANES = `# my lanes
lanes:
  - id: devrel
    archetype: "Developer Relations"
    title_keywords:
      - "Developer Advocate"
    max_evaluations: 5 # keep small
  - id: fde
    archetype: "Forward Deployed"
    title_keywords: ["Forward Deployed Engineer"]
`;

async function withLanes(fn, { lanes = LANES } = {}) {
  await import("../helpers/web-ts-alias-loader.mjs");
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "lanes-route-"));
  const saved = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]));
  process.env.CAREER_OPS_ROOT = root;
  process.env.CAREER_OPS_DATA_DIR = "";
  process.env.CAREER_OPS_PROFILES_DIR = path.join(root, "profiles");
  try {
    const file = path.join(root, "config", "lanes.yml");
    fs.mkdirSync(path.dirname(file));
    if (lanes !== null) fs.writeFileSync(file, lanes);
    const { POST } = await import("../../src/app/api/lanes/route.ts");
    const post = async (body) => {
      const res = await POST(new Request("http://localhost/api/lanes", { method: "POST", headers: { "content-type": "application/json" }, body }));
      return { status: res.status, body: await res.json() };
    };
    await fn({ root, file, post });
  } finally {
    for (const k of ENV_KEYS) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
    fs.rmSync(root, { recursive: true, force: true });
  }
}

test("lanes route: rejects bodies that do not name lanes with usable keywords", () =>
  withLanes(async ({ file, post }) => {
    const bad = [
      "{nope",
      JSON.stringify({}),
      JSON.stringify({ lanes: {} }),
      JSON.stringify({ lanes: [["devrel", ["x"]]] }),
      JSON.stringify({ lanes: { devrel: "Developer Advocate" } }),
      JSON.stringify({ lanes: { devrel: ["  ", 7] } }),
      JSON.stringify({ lanes: { devrel: Array.from({ length: 41 }, (_, i) => `k${i}`) } }),
      JSON.stringify({ lanes: { devrel: ["x".repeat(121)] } }),
    ];
    for (const body of bad) assert.equal((await post(body)).status, 400, body);
    assert.equal(fs.readFileSync(file, "utf8"), LANES);
  }));

test("lanes route: rewrites only title_keywords, trimmed, keeping comments and other lanes", () =>
  withLanes(async ({ file, post }) => {
    const res = await post(JSON.stringify({ lanes: { devrel: [" DevRel ", "", "Developer Advocate"] } }));
    assert.deepEqual(res, { status: 200, body: { ok: true } });
    const out = fs.readFileSync(file, "utf8");
    assert.match(out, /# my lanes/);
    assert.match(out, /max_evaluations: 5 # keep small/);
    const YAML = (await import("yaml")).default;
    const lanes = YAML.parse(out).lanes;
    // setSeq keeps surviving items in place and appends new ones, so request order is not file order.
    assert.deepEqual(lanes[0].title_keywords, ["Developer Advocate", "DevRel"]);
    assert.deepEqual(lanes[1].title_keywords, ["Forward Deployed Engineer"]);
  }));

test("lanes route: an unknown lane is 404 and nothing is written, even alongside a valid one", () =>
  withLanes(async ({ file, post }) => {
    const res = await post(JSON.stringify({ lanes: { devrel: ["DevRel"], nope: ["x"] } }));
    assert.equal(res.status, 404);
    assert.match(res.body.error, /no lane "nope"/);
    assert.equal(fs.readFileSync(file, "utf8"), LANES);
  }));

test("lanes route: malformed lanes.yml is a 409 and is not overwritten", () =>
  withLanes(async ({ file, post }) => {
    assert.equal((await post(JSON.stringify({ lanes: { devrel: ["x"] } }))).status, 409);
    assert.equal(fs.readFileSync(file, "utf8"), "lanes: [unclosed\n");
  }, { lanes: "lanes: [unclosed\n" }));

test("lanes route: a missing lanes.yml is a 404, not a copy of the example", () =>
  withLanes(async ({ root, file, post }) => {
    // loadYamlDoc reads the example before the route can see the file is absent.
    fs.writeFileSync(path.join(root, "config", "lanes.example.yml"), LANES);
    const res = await post(JSON.stringify({ lanes: { devrel: ["x"] } }));
    assert.equal(res.status, 404);
    assert.equal(fs.existsSync(file), false);
  }, { lanes: null }));
