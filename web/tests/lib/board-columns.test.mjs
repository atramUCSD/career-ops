// Tests for the /board lane mapping.
//
// Run:  node --test tests/lib/board-columns.test.mjs

import { test } from "node:test";
import assert from "node:assert/strict";
import { BOARD_COLUMNS, boardColumn, daysSince, distinctTitles, isHired, isSkipDecision, titleKey } from "../../src/lib/board-columns.mjs";

test("every lane writes a status that lands back in the same lane", () => {
  // A drop writes column.status; if that status mapped elsewhere the card
  // would jump lanes on the next refresh.
  for (const col of BOARD_COLUMNS) assert.equal(boardColumn(col.status), col.id, col.status);
});

test("aliases resolve through canonStatus", () => {
  assert.equal(boardColumn("Aplicado"), "applied");
  assert.equal(boardColumn("entrevista"), "interviewing");
  assert.equal(boardColumn("**Evaluated**"), "apply");
});

test("Hired sits in the Offer lane and is marked", () => {
  assert.equal(boardColumn("Hired"), "offer");
  assert.ok(isHired("Hired"));
  assert.ok(!isHired("Offer"));
});

test("triage outcomes and blanks stay off the board", () => {
  for (const s of ["Discarded", "SKIP", "", "—", "Descartado", "something new"]) assert.equal(boardColumn(s), null, s);
});

test("daysSince counts calendar days and rejects non-dates", () => {
  assert.equal(daysSince("2026-10-01", "2026-10-04"), 3);
  assert.equal(daysSince("2026-10-04", "2026-10-04"), 0);
  assert.equal(daysSince("2026-10-05", "2026-10-04"), 0); // future date clamps, never negative
  assert.equal(daysSince("", "2026-10-04"), null);
  assert.equal(daysSince("Oct 1", "2026-10-04"), null);
});

test("distinctTitles splits near-twin roles at the shared stem", () => {
  const apps = [
    { company: "Discord", role: "Senior Full-Stack Software Engineer, Ads" },
    { company: "Discord", role: "Senior Full-Stack Software Engineer, Game Records" },
    { company: "Salesforce", role: "Deployment Strategist - Public Sector, Nonprofit & Education" },
    { company: "Salesforce", role: "Deployment Strategist (Mid/Senior Levels)" },
    { company: "Salesforce", role: "Full-Stack Software Engineer: Mid, Senior, and Lead (MTS/SMTS)" },
    { company: "OpenAI", role: "Senior Engineer" },
    { company: "Other", role: "Senior Full-Stack Software Engineer, Ads" },
  ];
  const t = distinctTitles(apps);
  assert.deepEqual(t.get(titleKey("Discord", apps[1].role)), { stem: "Senior Full-Stack Software Engineer", tail: "Game Records" });
  assert.deepEqual(t.get(titleKey("Salesforce", apps[2].role)), { stem: "Deployment Strategist", tail: "Public Sector, Nonprofit & Education" });
  assert.deepEqual(t.get(titleKey("Salesforce", apps[3].role)), { stem: "Deployment Strategist", tail: "(Mid/Senior Levels)" });
  assert.equal(t.get(titleKey("Salesforce", apps[4].role)), undefined); // no twin
  assert.equal(t.get(titleKey("Other", apps[6].role)), undefined); // twins only within a company
  assert.equal(t.size, 4);
});

test("isSkipDecision reads the Machine Summary verdict", () => {
  for (const d of ["Skip", "skip — seniority", "Do not apply"]) assert.ok(isSkipDecision(d), d);
  for (const d of ["Consider", "Apply", "", null, undefined, "Skipper role"]) assert.ok(!isSkipDecision(d), String(d));
});
