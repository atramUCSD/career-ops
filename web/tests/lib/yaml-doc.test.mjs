import { after, test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import * as YAML from "yaml";
import { ConfigError, loadYamlDoc, setIn, toYaml } from "../../src/lib/yaml-doc.mjs";

const SOURCE = `# Portals — the user's own notes
title_filter:
  positive:
    # -- Design --
    - "UI"
    - "UX"
    # -- Engineering --
    - "Frontend"
    - "Platform"
  negative:
    - "Intern"   # never

# Salary floor comes from profile.yml
salary_filter:
  min: 130000 # walk-away
  max: 0
  currency: "USD"
max_posting_age_days: 45
tracked_companies:
  - name: Acme
    careers_url: https://example.com/jobs
`;

function edit(source, ...edits) {
  const doc = YAML.parseDocument(source);
  for (const [keys, value] of edits) setIn(doc, keys, value);
  return toYaml(doc, source);
}

const changedLines = (a, b) => {
  const before = a.split("\n");
  return b.split("\n").filter((line) => !before.includes(line));
};

test("an untouched document serializes to its exact bytes", () => {
  assert.equal(toYaml(YAML.parseDocument(SOURCE), SOURCE), SOURCE);
});

test("a scalar edit changes one line and keeps its trailing comment", () => {
  const out = edit(SOURCE, [["salary_filter", "min"], 120000]);
  assert.deepEqual(changedLines(SOURCE, out), ["  min: 120000 # walk-away"]);
  assert.equal(out.replace("120000", "130000"), SOURCE);
});

test("a list edit keeps item comments, moves a removed item's heading, and matches quoting", () => {
  const out = edit(SOURCE, [["title_filter", "positive"], ["UI", "UX", "Platform", "Design Systems"]]);
  assert.match(out, /# -- Engineering --\n {4}- "Platform"\n {4}- "Design Systems"\n/);
  assert.match(out, /# -- Design --\n {4}- "UI"/);
  assert.deepEqual(YAML.parse(out).title_filter.positive, ["UI", "UX", "Platform", "Design Systems"]);
  // The rest of the file is untouched, down to the aligned comment on a
  // sibling in the same block.
  assert.ok(out.endsWith(SOURCE.slice(SOURCE.indexOf("  negative:"))));
});

test("a heading whose items were all removed goes with them", () => {
  const out = edit(SOURCE, [["title_filter", "positive"], ["UI", "UX", "Backend"]]);
  assert.doesNotMatch(out, /Engineering/);
  assert.match(out, /- "UX"\n {4}- "Backend"\n {2}negative:/);
});

test("every edit reads back as the document it was made from", () => {
  const doc = YAML.parseDocument(SOURCE);
  setIn(doc, ["title_filter", "negative"], []);
  setIn(doc, ["salary_filter"], { min: 0, currency: "GBP" });
  setIn(doc, ["location_filter"], { strict: true, block: ["Onsite only"] });
  assert.deepEqual(YAML.parse(toYaml(doc, SOURCE)), doc.toJS());
});

test("an object merges key by key and leaves unnamed settings alone", () => {
  const out = edit(SOURCE, [["salary_filter"], { currency: "EUR" }], [["max_posting_age_days"], 30]);
  const parsed = YAML.parse(out);
  assert.deepEqual(parsed.salary_filter, { min: 130000, max: 0, currency: "EUR" });
  assert.equal(parsed.max_posting_age_days, 30);
  assert.deepEqual(parsed.tracked_companies, [{ name: "Acme", careers_url: "https://example.com/jobs" }]);
  assert.match(out, /# Salary floor comes from profile.yml\nsalary_filter:/);
});

test("a new key is added without disturbing the existing text", () => {
  const out = edit(SOURCE, [["location_filter", "allow"], ["Remote"]]);
  assert.ok(out.startsWith(SOURCE.trimEnd()));
  assert.deepEqual(YAML.parse(out).location_filter, { allow: ["Remote"] });
});

test("an empty key becomes settings; a value in the way is refused", () => {
  const out = edit("compensation:\nname: x\n", [["compensation", "minimum"], "90000"]);
  assert.deepEqual(YAML.parse(out), { compensation: { minimum: "90000" }, name: "x" });

  const doc = YAML.parseDocument("compensation: negotiable\n");
  assert.throws(
    () => setIn(doc, ["compensation", "minimum"], "90000"),
    (error) => error instanceof ConfigError && error.kind === "invalid-user-config",
  );
});

test("a numeric key indexes into a list of settings", () => {
  const source = "lanes:\n  - id: a\n    title_keywords: [x]\n  - id: b\n    title_keywords:\n      - y # keep\n";
  const out = edit(source, [["lanes", 1, "title_keywords"], ["y", "z"]]);
  assert.deepEqual(YAML.parse(out).lanes, [
    { id: "a", title_keywords: ["x"] },
    { id: "b", title_keywords: ["y", "z"] },
  ]);
  assert.match(out, /- y # keep\n/);
});

test("Windows line endings survive an edit", () => {
  const crlf = SOURCE.replace(/\n/g, "\r\n");
  const out = edit(crlf, [["title_filter", "positive"], ["UI"]], [["max_posting_age_days"], 30]);
  assert.doesNotMatch(out, /[^\r]\n/);
  assert.deepEqual(YAML.parse(out).title_filter.positive, ["UI"]);
});

const dirs = [];
after(() => {
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
});

function fixture() {
  const dir = mkdtempSync(path.join(tmpdir(), "career-ops-yaml-doc-"));
  dirs.push(dir);
  const template = path.join(dir, "portals.example.yml");
  writeFileSync(template, "title_filter:\n  positive: [Template Role]\n");
  return { file: path.join(dir, "portals.yml"), template };
}

const rejects = (fn, kind) => assert.throws(fn, (error) => error instanceof ConfigError && error.kind === kind);

test("a missing file seeds from the template", () => {
  const { file, template } = fixture();
  const { doc, seeded } = loadYamlDoc(file, template);
  assert.equal(seeded, true);
  assert.deepEqual(doc.toJS(), { title_filter: { positive: ["Template Role"] } });
});

test("a malformed, list or scalar user file is refused, never replaced by the template", () => {
  const { file, template } = fixture();
  for (const source of ["title_filter: [broken\n", "- a\n- b\n", "just text\n", "2026-09-12\n", "# only a comment\n"]) {
    writeFileSync(file, source);
    rejects(() => loadYamlDoc(file, template), "invalid-user-config");
    assert.equal(readFileSync(file, "utf8"), source);
  }
});

test("a broken template is an installation error, and an unreadable file is not a missing one", () => {
  const { file, template } = fixture();
  writeFileSync(template, "title_filter: [broken\n");
  rejects(() => loadYamlDoc(file, template), "invalid-template");

  mkdirSync(file);
  rejects(() => loadYamlDoc(file, template), "read-failed");
});
