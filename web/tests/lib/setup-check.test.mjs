// Home's setup checklist, run against the real core modules it is handed in
// production (profiles.mjs, personalization.mjs, lanes.mjs), so a change to
// what the core calls a stub, a template or a drifted lane shows up here.
//
// Run:  node --test tests/lib/setup-check.test.mjs

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { driftedKeywords, laneFindings, parseSchtasks, setupChecklist } from "../../src/lib/home/setup-check.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const imp = (f) => import(pathToFileURL(join(ROOT, f)).href);
const { isStubCv, scaffold } = await imp("profiles.mjs");
const { unpersonalizedFiles } = await imp("personalization.mjs");
const { loadLanes, checkLaneRegistration } = await imp("lanes.mjs");
const core = { isStubCv, unpersonalizedFiles, loadLanes, checkLaneRegistration };

function tree(files = {}) {
  const dir = mkdtempSync(join(tmpdir(), "setup-check-"));
  for (const [rel, body] of Object.entries(files)) {
    mkdirSync(dirname(join(dir, rel)), { recursive: true });
    writeFileSync(join(dir, rel), body);
  }
  return dir;
}

const byId = (r) => Object.fromEntries(r.items.map((i) => [i.id, i]));

test("a freshly scaffolded profile is not set up, although most of its files exist", () => {
  const code = tree({
    "modes/_profile.template.md": "# {Your Name}\n\n{Archetype}\n",
    "templates/portals.example.yml": "tracked_companies:\n  - name: Acme\n  - name: Off\n    enabled: false\n",
    "config/profile.example.yml": "candidate:\n  full_name: ''\n",
  });
  const saved = process.env.CAREER_OPS_PROFILES_DIR;
  process.env.CAREER_OPS_PROFILES_DIR = tree();
  try {
    const { dir } = scaffold("pat", { root: code });
    const items = byId(setupChecklist({ codeRoot: code, userRoot: dir, core }));
    assert.equal(items.cv.ready, false);
    assert.match(items.cv.detail, /stub/);
    assert.equal(items.personalization.ready, false);
    assert.equal(items.personalization.action, "personalize");
    assert.equal(items.portals.detail, "1 company");
    assert.equal(items.alerts.ready, false);
  } finally {
    if (saved === undefined) delete process.env.CAREER_OPS_PROFILES_DIR;
    else process.env.CAREER_OPS_PROFILES_DIR = saved;
  }
});

test("lane findings read system files from the code root and user files from the profile", () => {
  const lane = { id: "ux", archetype: "UX Engineer", title_keywords: ["UX Engineer"], golden_case: "evals/golden/ux.json" };
  const code = tree({
    "modes/_shared.md": "UX Engineer",
    "batch/batch-prompt.md": "UX Engineer",
    "evals/golden/ux.json": "{}",
    // The owner's files pass. Reading them for the profile would hide its gap.
    "portals.yml": 'title_filter:\n  positive: ["UX Engineer"]\n',
    "modes/_profile.md": "UX Engineer",
    "config/profile.yml": "x: UX Engineer\n",
  });
  const user = tree({
    "portals.yml": 'title_filter:\n  positive: ["Designer"]\n',
    "modes/_profile.md": "UX Engineer",
    "config/profile.yml": "x: UX Engineer\n",
  });
  const split = laneFindings({ codeRoot: code, userRoot: user, lanes: [lane], check: checkLaneRegistration });
  assert.deepEqual([...new Set(split.map((f) => `${f.severity} ${f.site}`))], ["error portals.yml"]);
  assert.deepEqual(driftedKeywords(split), { ux: { "UX Engineer": "missing" } });
  assert.deepEqual(laneFindings({ codeRoot: code, userRoot: code, lanes: [lane], check: checkLaneRegistration }), []);
});

test("a set-up root reads 6 of 6, and drift or a broken file names itself", () => {
  const code = tree({
    "modes/_profile.template.md": "# {Your Name}\n",
    "modes/_shared.md": "UX Engineer",
    "batch/batch-prompt.md": "UX Engineer",
  });
  const user = tree({
    "cv.md": "# Pat\n\n## Experience\n",
    "config/profile.yml": "target_roles:\n  archetypes:\n    - name: UX Engineer\n",
    "portals.yml": 'title_filter:\n  positive: ["UX Engineer"]\ntracked_companies:\n  - name: A\n  - name: B\n',
    "config/alerts.yml": "alerts:\n  to: pat@example.com\n",
    "modes/_profile.md": "# Pat\n\nUX Engineer\n",
    "config/lanes.yml": 'lanes:\n  - id: ux\n    archetype: UX Engineer\n    title_keywords: ["UX Engineer"]\n',
  });
  const check = () => setupChecklist({ codeRoot: code, userRoot: user, core });
  assert.deepEqual([check().ready, check().total], [6, 6]);
  assert.equal(byId(check()).portals.detail, "2 companies");

  writeFileSync(join(user, "config/lanes.yml"), 'lanes:\n  - id: ux\n    archetype: UX Engineer\n    title_keywords: ["UX Engineer", "UI Engineer"]\n');
  assert.equal(byId(check()).lanes.detail, "1 lane keyword drifted from the title filter");

  writeFileSync(join(user, "portals.yml"), "title_filter: [unclosed\n");
  const items = byId(check());
  assert.equal(items.portals.ready, false);
  assert.match(items.portals.detail, /^portals\.yml doesn't parse at line \d+/);
  assert.equal(items.cv.ready, true, "one broken file must not fail the others");
});

test("the alert task reads from schtasks' CSV, and anything else reads as no task", () => {
  const head = '"HostName","TaskName","Next Run Time","Status","Last Run Time","Last Result","Scheduled Task State","Start Time","Repeat: Every"';
  const row = (state, result) => `"HOST","\career-ops-alert","9/28/2026 7:00:00 AM","Ready","9/27/2026 5:36:03 PM","${result}","${state}","7:00:00 AM","12 Hour(s), 0 Minute(s)"`;
  const task = parseSchtasks(`${head}\r\n${row("Enabled", "0")}\r\n`);
  assert.deepEqual(task, {
    health: "healthy",
    lastResult: 0,
    lastRun: new Date("9/27/2026 5:36:03 PM").toISOString(),
    nextRun: new Date("9/28/2026 7:00:00 AM").toISOString(),
    times: ["7:00 AM", "7:00 PM"],
  });
  assert.equal(parseSchtasks(`${head}\n${row("Enabled", "1")}`).health, "failing");
  assert.equal(parseSchtasks(`${head}\n${row("Enabled", "267011")}`).health, "not-run");
  assert.equal(parseSchtasks(`${head}\n${row("Disabled", "0")}`).health, "disabled");
  assert.equal(parseSchtasks("ERROR: The system cannot find the file specified."), null);
  assert.equal(parseSchtasks(""), null);
});
