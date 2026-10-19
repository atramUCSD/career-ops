// Tests for the /board card panel: report parsing and timeline merge.
//
// Run:  node --test tests/lib/board-activity.test.mjs

import { test } from "node:test";
import assert from "node:assert/strict";
import { buildTimeline, expiredOn, localDay, parseReportMeta, parseStatusLog, scanSighting } from "../../src/lib/board-activity.mjs";

const REPORT = `# Evaluation: Acme — Engineer

**Date:** 2026-08-23
**URL:** https://jobs.example/1
**Archetype:** Platform

---

## Machine Summary

\`\`\`yaml
final_decision: "Skip"
top_strengths:
  - "React"
\`\`\`

## A) Role Summary
**Not:** header
`;

test("parseReportMeta reads header lines and the summary YAML", () => {
  const { header, summary } = parseReportMeta(REPORT);
  assert.equal(header.URL, "https://jobs.example/1");
  assert.equal(header.Archetype, "Platform");
  assert.equal(header.Not, undefined); // stops at the first ## heading
  assert.deepEqual(summary, { final_decision: "Skip", top_strengths: ["React"] });
});

test("parseReportMeta survives a missing or broken summary", () => {
  assert.equal(parseReportMeta("**URL:** x").summary, null);
  assert.equal(parseReportMeta("## Machine Summary\n\n```yaml\n: : [\n```").summary, null);
});

test("ledger, scan and expired readers match only their own row", () => {
  const log = "4\t2026-09-01\tEvaluated\tApplied\tweb\t\n14\t2026-09-02\tEvaluated\tApplied\tset-status\t\n";
  assert.deepEqual(parseStatusLog(log, "4"), [{ date: "2026-09-01", from: "Evaluated", to: "Applied", source: "web" }]);
  const tsv = "url\tfirst_seen\tportal\nhttps://jobs.example/1\t2026-08-11\tgreenhouse-api\ttitle\n";
  assert.deepEqual(scanSighting(tsv, "https://jobs.example/1"), { date: "2026-08-11", portal: "greenhouse-api" });
  assert.equal(scanSighting(tsv, "https://jobs.example/10"), null);
  const md = "| Removed (est.) | Company | URL |\n|---|---|---|\n| 2026-10-04 | — | https://jobs.example/1 |\n";
  assert.equal(expiredOn(md, "https://jobs.example/1"), "2026-10-04");
  assert.equal(expiredOn(md, "https://jobs.example/2"), null);
});

test("timeline is newest first and a board move hides its own ledger row", () => {
  const noon = new Date(2026, 8, 1, 12).toISOString(); // local noon, 2026-09-01
  const events = [
    { at: noon, n: "4", kind: "move", from: "Evaluated", to: "Applied" },
    { at: new Date(2026, 8, 2, 9).toISOString(), n: "4", kind: "comment", text: "pinged recruiter" },
  ];
  const ledger = [
    { date: "2026-09-01", from: "Evaluated", to: "Applied", source: "web" },
    { date: "2026-09-03", from: "Applied", to: "Rejected", source: "set-status" },
  ];
  const t = buildTimeline({
    app: { date: "2026-08-23", status: "Rejected", score: "3.5/5" },
    ledger,
    sighting: { date: "2026-08-11", portal: "greenhouse-api" },
    expired: null,
    events,
  });
  assert.deepEqual(
    t.map((e) => e.kind),
    ["status", "comment", "move", "evaluated", "scan"],
  );
  assert.equal(localDay(noon), "2026-09-01");
});

test("consecutive opens collapse into one counted entry", () => {
  const at = (d, h) => new Date(2026, 8, d, h).toISOString();
  const t = buildTimeline({
    app: { date: "", status: "Evaluated", score: "" },
    ledger: [],
    sighting: null,
    expired: null,
    events: [
      { at: at(1, 9), n: "4", kind: "open" },
      { at: at(2, 9), n: "4", kind: "open" },
      { at: at(3, 9), n: "4", kind: "comment", text: "x" },
      { at: at(4, 9), n: "4", kind: "open" },
      { at: at(5, 9), n: "4", kind: "open" },
      { at: at(6, 9), n: "4", kind: "open" },
    ],
  });
  assert.deepEqual(t.map((e) => e.title), ["Opened 3×", "Comment", "Opened 2×"]);
  assert.equal(t[0].at, at(6, 9));
  assert.equal(t[0].detail, "since 2026-09-04");
});
