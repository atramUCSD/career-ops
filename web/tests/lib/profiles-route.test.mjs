// /api/profiles: the profile selector — listing with the owner's pending count,
// scaffolding a new profile through core profiles.mjs, switching, and the
// 400/409 answers for bad names, duplicates and unknown profiles.
// Driven through the real handlers against a temp CAREER_OPS_ROOT, with
// CAREER_OPS_PROFILES_DIR inside it so the scaffold never reaches the checkout.
//
// Run: cd web && node --experimental-strip-types --test tests/lib/profiles-route.test.mjs

import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const ENV_KEYS = ["CAREER_OPS_ROOT", "CAREER_OPS_DATA_DIR", "CAREER_OPS_PROFILES_DIR"];

test("profiles route: list, create, duplicate, switch and switch back", async () => {
  await import("../helpers/web-ts-alias-loader.mjs");
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "profiles-route-"));
  const profilesDir = path.join(root, "profiles");
  const saved = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]));
  process.env.CAREER_OPS_ROOT = root;
  process.env.CAREER_OPS_DATA_DIR = "";
  process.env.CAREER_OPS_PROFILES_DIR = profilesDir;
  try {
    fs.mkdirSync(path.join(root, "data"));
    fs.writeFileSync(path.join(root, "data", "pipeline.md"), "- [ ] a\n- [x] done\n* [ ] b\n");
    const { GET, POST } = await import("../../src/app/api/profiles/route.ts");
    const post = async (body) => {
      const res = await POST(new Request("http://localhost/api/profiles", { method: "POST", headers: { "content-type": "application/json" }, body }));
      return { status: res.status, body: await res.json() };
    };

    assert.deepEqual(await (await GET()).json(), { active: null, owner: { pending: 2 }, profiles: [] });

    for (const body of ["{nope", JSON.stringify({}), JSON.stringify({ select: 3 }), JSON.stringify({ create: "../escape" }), JSON.stringify({ create: ".hidden" })]) {
      assert.equal((await post(body)).status, 400, body);
    }
    assert.equal(fs.existsSync(profilesDir), false, "a rejected create scaffolds nothing");

    assert.deepEqual(await post(JSON.stringify({ create: "alex" })), { status: 200, body: { active: "alex" } });
    assert.ok(fs.existsSync(path.join(profilesDir, "alex", "cv.md")));
    assert.ok(fs.existsSync(path.join(profilesDir, "alex", "data", "applications.md")));
    const listed = await (await GET()).json();
    assert.equal(listed.active, "alex");
    assert.deepEqual(listed.profiles.map((p) => [p.name, p.cv, p.pending]), [["alex", true, 0]]);

    const dup = await post(JSON.stringify({ create: "alex" }));
    assert.equal(dup.status, 409);

    const unknown = await post(JSON.stringify({ select: "nobody" }));
    assert.equal(unknown.status, 400);
    assert.match(unknown.body.error, /no such profile "nobody"/);

    assert.deepEqual(await post(JSON.stringify({ select: null })), { status: 200, body: { active: null } });
    assert.equal(fs.readFileSync(path.join(root, ".career-ops-web", "active-profile"), "utf8"), "");
    assert.deepEqual(await post(JSON.stringify({ select: "alex" })), { status: 200, body: { active: "alex" } });
  } finally {
    for (const k of ENV_KEYS) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
    fs.rmSync(root, { recursive: true, force: true });
  }
});
