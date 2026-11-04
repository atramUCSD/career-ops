import { test } from "node:test";
import assert from "node:assert/strict";
import { checkDraft, targets } from "../../src/lib/setup-draft.mjs";
import { addRole, baseFrom, bins, draftFrom, formFrom, passing, setEmail, setKeywords, setRoles, STAGE_IDS, status, validate } from "../../src/lib/setup-wizard.mjs";

// A GET /api/setup response for a user whose files all exist.
const SETUP = {
  profile: {
    value: { name: "Ada", email: "ada@example.com", location: "London", currency: "GBP", remote: "Remote or hybrid", targetRange: "90-110K", walkAway: 85000, roles: ["Analyst"] },
    seeded: false,
  },
  personalization: { value: [{ id: "targetRoles", state: "filled" }, { id: "compTargets", state: "template" }], seeded: false },
  portals: {
    value: {
      title_filter: { positive: ["Analyst"] },
      location_filter: { allow: ["London"] },
      companies: [{ name: "Acme", enabled: true }, { name: "Globex", enabled: false }],
    },
    seeded: false,
  },
  lanes: { value: [{ id: "data", archetype: "Data", title_keywords: ["Analyst"] }], seeded: false },
  alerts: { value: { enabled: true, to: "ada@example.com", min_match: 50, max_rows: 10, quiet_if_empty: true, calendar: { enabled: false } }, seeded: false },
  draft: { value: null },
};

test("an untouched wizard drafts nothing", () => {
  const base = baseFrom(SETUP);
  assert.deepEqual(draftFrom(formFrom(SETUP), base), {});
  assert.equal(base.walkAway, "85000");
});

test("every edit lands in the section its writer reads, and checkDraft accepts it", () => {
  const base = baseFrom(SETUP);
  let form = formFrom(SETUP);
  form = addRole(form, "Data Scientist");
  form = { ...form, home: "Leeds", places: ["London", "Leeds"], companies: { Acme: false, Globex: true }, adds: ["Initech"] };
  form = { ...form, lanes: { data: ["Analyst", "Data Scientist"] }, minMatch: 60, calendarOn: true };
  const draft = draftFrom(form, base, ["compTargets"]);
  assert.deepEqual(draft, {
    profile: { location: "Leeds", roles: ["Analyst", "Data Scientist"] },
    portals: { filters: { title_filter: { positive: ["Analyst", "Data Scientist"] }, location_filter: { allow: ["London", "Leeds"] } } },
    companies: { enable: ["Globex"], disable: ["Acme"], add: ["Initech"] },
    lanes: { data: ["Analyst", "Data Scientist"] },
    alerts: { min_match: 60, calendar: { enabled: true } },
    personalization: { compTargets: "Target 90-110K GBP. Walk-away 85000." },
  });
  const result = checkDraft(draft);
  assert.ok(!("error" in result), result.error);
  assert.deepEqual(targets(result.checked), ["portals", "alerts", "profile", "personalization", "lanes"]);

  // The saved draft reopens as the same form. Which keywords a role added is
  // session state: after a reload, removing a role leaves its keyword.
  const reopened = formFrom({ ...SETUP, draft: { value: draft } });
  assert.deepEqual(reopened, { ...form, roleKeywords: [] });
  assert.deepEqual(draftFrom(reopened, base, ["compTargets"]), draft);
});

test("a fresh install shows no example person and alerts follow the email", () => {
  const fresh = {
    profile: { value: { name: "Jane Smith", email: "jane@example.com", roles: ["Example"] }, seeded: true },
    personalization: { value: [], seeded: true },
    portals: { value: { title_filter: { positive: ["Example"] }, companies: [{ name: "Acme" }] }, seeded: true },
    lanes: { value: null, seeded: true },
    alerts: { value: { enabled: true, to: "", min_match: 42 }, seeded: true },
    draft: { value: null },
  };
  const base = baseFrom(fresh);
  assert.equal(base.name, "");
  assert.deepEqual(base.keywords, []);
  assert.deepEqual(base.companies, { Acme: true });
  assert.deepEqual(base.lanes, {});

  assert.equal(formFrom(fresh).to, "");
  const form = setEmail({ ...formFrom(fresh), name: "Ada" }, "ada@example.com");
  assert.equal(form.to, "ada@example.com");
  const draft = draftFrom(form, base);
  assert.deepEqual(draft, { profile: { name: "Ada", email: "ada@example.com" }, alerts: { to: "ada@example.com" } });
  assert.ok(!("error" in checkDraft(draft)));
  assert.deepEqual(formFrom({ ...fresh, draft: { value: draft } }), form);

  // A different alert address stops following the email.
  const own = setEmail({ ...form, to: "alerts@example.com" }, "ada@example.org");
  assert.equal(own.to, "alerts@example.com");
});

test("a section that failed to load starts empty instead of throwing", () => {
  const form = formFrom({ profile: { error: "bad yaml" }, portals: { error: "x" }, lanes: { error: "x" }, alerts: { error: "x" }, draft: { error: "x" } });
  assert.equal(form.name, "");
  assert.deepEqual(form.companies, {});
  assert.equal(form.minMatch, 42);
});

test("validate speaks in the wizard's words, keyed by field", () => {
  const form = { ...formFrom(SETUP), name: " ", email: "ada@", roles: [], keywords: [], lanes: { data: [] }, home: "", to: "x, ada@example.com" };
  assert.deepEqual(validate("you", form), {
    name: "Enter your name",
    email: "Enter an email address in the correct format, like name@example.com",
  });
  assert.deepEqual(Object.keys(validate("what", form)), ["roles", "keywords", "lane-data"]);
  assert.deepEqual(validate("where", form), { home: "Enter where you live" });
  assert.deepEqual(validate("tell", form), { to: 'Enter "x" as an email address, like name@example.com' });
  assert.deepEqual(validate("tell", { ...form, to: "" }), { to: "Enter an email address for alerts, or turn alerts off" });
  assert.deepEqual(validate("tell", { ...form, to: "", alertsOn: false }), {});
  assert.deepEqual(validate("picky", { ...form, minMatch: 101, maxRows: 0 }), {
    minMatch: "Match score must be a whole number from 0 to 100",
    maxRows: "Matches per alert must be a whole number from 1 to 100",
  });
  assert.match(validate("where", { ...form, home: "x".repeat(201) }).home, /200 characters or fewer/);
  for (const id of STAGE_IDS) assert.deepEqual(validate(id, formFrom(SETUP)), {}, id);
});

test("status marks You without a CV and Who without a company as todo", () => {
  const form = formFrom(SETUP);
  assert.equal(status("you", form, { hasCv: false }), "todo");
  assert.equal(status("you", form, { hasCv: true }), "done");
  assert.equal(status("who", { ...form, companies: { Acme: false } }, { hasCv: true }), "todo");
  assert.equal(status("who", { ...form, companies: { Acme: false }, adds: ["Initech"] }, { hasCv: true }), "done");
});

test("addRole is additive and case-insensitive", () => {
  const form = formFrom(SETUP);
  assert.equal(addRole(form, " analyst "), form);
  assert.equal(addRole(form, ""), form);
  const next = addRole({ ...form, keywords: ["Designer"] }, "Designer");
  assert.deepEqual(next.roles, ["Analyst", "Designer"]);
  assert.deepEqual(next.keywords, ["Designer"]);
});

test("removing a role takes only the keyword addRole added", () => {
  const form = { ...formFrom(SETUP), keywords: ["Designer"] };
  const added = setRoles(form, ["Analyst", "Designer", "Researcher"]);
  assert.deepEqual(added.keywords, ["Designer", "Researcher"]);
  // Designer was a keyword before it was a role, so it outlives the role.
  const removed = setRoles(added, ["Analyst"]);
  assert.deepEqual(removed.roles, ["Analyst"]);
  assert.deepEqual(removed.keywords, ["Designer"]);
  assert.deepEqual(removed.roleKeywords, []);
  // A keyword removed by hand and typed back is the user's, not the role's.
  const owned = setKeywords(setKeywords(added, ["Designer"]), ["Designer", "Researcher"]);
  assert.deepEqual(setRoles(owned, ["Analyst"]).keywords, ["Designer", "Researcher"]);
  assert.deepEqual(draftFrom(removed, baseFrom(SETUP)), draftFrom({ ...formFrom(SETUP), keywords: ["Designer"] }, baseFrom(SETUP)));
});

test("validate catches what the server would refuse in places and adds", () => {
  const form = formFrom(SETUP);
  assert.match(validate("where", { ...form, places: ["London", " Remote "] }).places, /Remove "Remote": it is not a place/);
  assert.deepEqual(validate("where", { ...form, places: ["London", "Remote-first Ltd HQ"] }), {});
  const adds = (a) => validate("who", { ...form, adds: a }).adds;
  assert.match(adds(Array.from({ length: 21 }, (_, i) => `Co${i}`)), /at most 20/);
  assert.match(adds(["Initech", "-x"]), /cannot start with "-"/);
  assert.match(adds(["x".repeat(101)]), /100 characters or fewer/);
  assert.equal(adds(["Initech"]), undefined);
  assert.equal(status("who", { ...form, adds: ["-x"] }, { hasCv: true }), "todo");
});

test("bins and passing", () => {
  assert.deepEqual(bins([0, 4.9, 5, 99, 100, NaN], 20), [2, 1, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 2]);
  assert.equal(passing([10, 42, 43, 90], 42), 3);
});
