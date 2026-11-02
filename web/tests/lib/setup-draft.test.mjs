import { test } from "node:test";
import assert from "node:assert/strict";
import * as YAML from "yaml";
import { changes, checkDraft, leaves, targets, yamlEdits } from "../../src/lib/setup-draft.mjs";
import { profileValues } from "../../src/lib/profile-patch.mjs";
import { setIn, toYaml } from "../../src/lib/yaml-doc.mjs";

const refuses = (draft, pattern) => {
  const result = checkDraft(draft);
  assert.ok("error" in result, JSON.stringify(draft));
  assert.match(result.error, pattern);
};

test("checkDraft refuses what no writer would accept", () => {
  refuses(null, /must be an object/);
  refuses({ scheduler: {} }, /unknown draft section "scheduler"/);
  refuses({ portals: { tracked_companies: [] } }, /portals: unknown setting "tracked_companies"/);
  refuses({ portals: { filters: { salary_filter: { min: -1 } } } }, /^portals: salary_filter.min/);
  refuses({ companies: { remove: ["Acme"] } }, /companies: unknown setting "remove"/);
  refuses({ companies: { add: "Acme" } }, /companies.add must be a list/);
  refuses({ companies: { add: ["--write"] } }, /"--write" is not a company name/);
  refuses({ companies: { add: Array.from({ length: 21 }, (_, i) => `Co ${i}`) } }, /at most 20/);
  refuses({ companies: { enable: ["x".repeat(101)] } }, /at most 100 characters/);
  refuses({ profile: { email: 7 } }, /^profile: email must be a string/);
  refuses({ profile: { spendTier: "lavish" } }, /^profile: spendTier/);
  refuses({ lanes: { devrel: [] } }, /needs at least one title keyword/);
  refuses({ alerts: { max_rows: "ten" } }, /^alerts: max_rows/);
  refuses({ personalization: [] }, /personalization must be an object/);
});

test("checkDraft passes each section through its writer's own validation", () => {
  const { checked } = checkDraft({
    profile: { name: " Ada ", roles: ["Design Engineer", " "], spendTier: "standard" },
    personalization: { exitNarrative: "Ready for scope.", unknownKey: 1 },
    portals: { location: ["Remote"] },
    companies: { enable: [" Globex "], add: ["Initech"] },
    lanes: { devrel: [" DevRel "] },
    alerts: { enabled: true },
  });
  assert.deepEqual(checked.profile, [
    [["candidate", "full_name"], "Ada"],
    [["target_roles", "primary"], ["Design Engineer"]],
    [["spend_tier"], "standard"],
  ]);
  assert.deepEqual(checked.personalization, { exitNarrative: "Ready for scope." });
  // location alone is not a portals write: portalsPatch reads it only with roles.
  assert.equal(checked.portals, undefined);
  assert.deepEqual(checked.companies, { enable: ["Globex"], disable: [], add: ["Initech"] });
  assert.deepEqual(checked.lanes, { devrel: ["DevRel"] });
  assert.deepEqual(checked.alerts, { enabled: true });
  assert.deepEqual(targets(checked), ["portals", "alerts", "profile", "personalization", "lanes"]);
});

test("targets skips a section with nothing to write, and adds alone touch no file", () => {
  assert.deepEqual(targets(checkDraft({ companies: { add: ["Initech"] } }).checked), []);
  assert.deepEqual(targets(checkDraft({ personalization: { unknownKey: 1 }, profile: { name: "  " } }).checked), []);
  assert.deepEqual(targets(checkDraft({ lanes: { a: ["x"] }, alerts: { to: "a@example.com" } }).checked), ["alerts", "lanes"]);
});

test("leaves flattens plain objects and keeps lists whole", () => {
  assert.deepEqual(leaves(["alerts"], { to: "a@b.c", calendar: { enabled: true, reminders: [10, 60] } }), [
    [["alerts", "to"], "a@b.c"],
    [["alerts", "calendar", "enabled"], true],
    [["alerts", "calendar", "reminders"], [10, 60]],
  ]);
  assert.deepEqual(leaves([], {}), []);
});

test("yamlEdits addresses alerts under alerts: only when the file nests them", () => {
  const checked = { alerts: { max_rows: 10 } };
  assert.deepEqual(yamlEdits("alerts", checked, { alerts: { enabled: true } }).edits, [[["alerts", "max_rows"], 10]]);
  assert.deepEqual(yamlEdits("alerts", checked, { enabled: true }).edits, [[["max_rows"], 10]]);
});

test("yamlEdits plans company toggles and lanes against the current file", () => {
  const portals = { tracked_companies: [{ name: "Acme" }, { name: "Globex", enabled: false }] };
  const { checked } = checkDraft({ portals: { roles: ["UX"] }, companies: { enable: ["globex"], disable: ["Acme"] } });
  assert.deepEqual(yamlEdits("portals", checked, portals).edits, [
    [["title_filter", "positive"], ["UX"]],
    [["tracked_companies", 1, "enabled"], true],
    [["tracked_companies", 0, "enabled"], false],
  ]);
  assert.match(yamlEdits("portals", { companies: { enable: ["Hooli"], disable: [] } }, portals).error, /not in tracked_companies/);

  const lanes = { lanes: [{ id: "a" }, { id: "b" }] };
  assert.deepEqual(yamlEdits("lanes", { lanes: { b: ["x"] } }, lanes).edits, [[["lanes", 1, "title_keywords"], ["x"]]]);
  assert.match(yamlEdits("lanes", { lanes: { c: ["x"] } }, lanes).error, /no lane "c"/);
  assert.deepEqual(yamlEdits("profile", {}, {}), { edits: [] });
  assert.match(yamlEdits("personalization", {}, {}).error, /not a YAML target/);
});

test("changes keeps only the values that differ", () => {
  const current = { a: { b: 1, list: ["x"] }, rows: [{ on: true }] };
  assert.deepEqual(
    changes([[["a", "b"], 1], [["a", "list"], ["x", "y"]], [["rows", 0, "on"], true], [["new", "key"], 2]], current),
    [
      { path: ["a", "list"], before: ["x"], after: ["x", "y"] },
      { path: ["new", "key"], before: undefined, after: 2 },
    ],
  );
});

test("profileValues reads back the fields the profile writer owns", () => {
  assert.deepEqual(
    profileValues({
      candidate: { full_name: "Ada", email: "ada@example.com", phone: "not ours" },
      compensation: { minimum: 90000, target_range: "120-150k", currency: "USD" },
      target_roles: { primary: ["Design Engineer", 3] },
      language: { output: "en" },
      spend_tier: "standard",
      archetypes: [{ name: "not ours" }],
    }),
    {
      name: "Ada", email: "ada@example.com", currency: "USD", targetRange: "120-150k", walkAway: 90000,
      language: "en", spendTier: "standard", roles: ["Design Engineer"],
    },
  );
  assert.deepEqual(profileValues({}), {});
});

// The Phase 3 gate: applying a draft rewrites only what it changes. Every
// untouched section keeps its bytes, comments included.
const PORTALS = `# My portals, my notes
title_filter:
  positive:
    # -- Design --
    - "UI Engineer"   # main lane
    - "Design Engineer"
  negative:
    - "Intern"

location_filter:
  allow: ["Remote"]   # keep flow style

# Do not touch: hand-tuned
search_queries:
  - name: Ashby design
    query: 'site:jobs.ashbyhq.com "design engineer"'
tracked_companies:
  - name: Acme
    careers_url: https://a.example/jobs
    max_response_mb: 24  # board was 10 MB
  - name: Globex
    careers_url: https://g.example/jobs
    enabled: false   # paused
`;

function apply(source, target, checked) {
  const doc = YAML.parseDocument(source);
  const current = doc.toJS();
  const planned = yamlEdits(target, checked, current);
  for (const c of changes(planned.edits, current)) setIn(doc, c.path, c.after);
  return toYaml(doc, source);
}

test("apply round-trips byte for byte on untouched sections and keeps comments", () => {
  const { checked } = checkDraft({
    portals: { filters: { title_filter: { negative: ["Intern", "Junior"] } } },
    companies: { enable: ["Globex"] },
  });
  const out = apply(PORTALS, "portals", checked);
  const before = PORTALS.split("\n");
  const after = out.split("\n");
  assert.deepEqual(after.filter((l) => !before.includes(l)), ['    - "Junior"', "    enabled: true   # paused"]);
  assert.deepEqual(before.filter((l) => !after.includes(l)), ["    enabled: false   # paused"]);
  const untouched = PORTALS.slice(PORTALS.indexOf("\nlocation_filter:"), PORTALS.indexOf("  - name: Globex"));
  assert.ok(out.includes(untouched));
  assert.ok(out.startsWith(PORTALS.slice(0, PORTALS.indexOf("  negative:"))));
  assert.deepEqual(YAML.parse(out).title_filter.negative, ["Intern", "Junior"]);

  // A draft that matches the file changes nothing, so nothing is written.
  const same = checkDraft({ portals: { filters: { title_filter: { negative: ["Intern"] } } } }).checked;
  assert.deepEqual(changes(yamlEdits("portals", same, YAML.parse(PORTALS)).edits, YAML.parse(PORTALS)), []);
  assert.equal(apply(PORTALS, "portals", same), PORTALS);
});

test("an alerts draft lands under alerts: and leaves sibling settings alone", () => {
  const head = "# digest\n";
  const tail = "\n# hand-tuned, keep\nschedule:\n  hour: 7    # local\n";
  const source = `${head}alerts:\n  enabled: true\n  to: a@example.com  # me\n  artifact_url: https://example.test/x\n${tail}`;
  const out = apply(source, "alerts", checkDraft({ alerts: { max_rows: 10, to: "a@example.com" } }).checked);
  assert.deepEqual(YAML.parse(out).alerts, { enabled: true, to: "a@example.com", artifact_url: "https://example.test/x", max_rows: 10 });
  // Adding a key re-renders the map that gains it, so its comments keep their
  // text but not their alignment. The other top-level sections keep their bytes.
  assert.ok(out.startsWith(head) && out.endsWith(tail), out);
  assert.match(out, /to: a@example\.com +# me/);
});
