import { test } from "node:test";
import assert from "node:assert/strict";
import { portalsPatch, scanFunnel } from "../../src/lib/portals-config.mjs";

test("the onboarding write replaces the include list and, when given, the allowed locations", () => {
  assert.deepEqual(portalsPatch({ roles: [" ML Engineer ", "", 7, "AI Engineer"], location: ["Remote"] }), {
    patch: { title_filter: { positive: ["ML Engineer", "AI Engineer"] }, location_filter: { allow: ["Remote"] } },
  });
  assert.deepEqual(portalsPatch({ roles: ["x"] }), { patch: { title_filter: { positive: ["x"] } } });
  assert.equal(portalsPatch({ roles: Array.from({ length: 30 }, (_, i) => `r${i}`) }).patch.title_filter.positive.length, 24);
  assert.deepEqual(portalsPatch({ roles: ["  "] }), { error: "no roles" });
});

test("filters carry only the settings they name", () => {
  const { patch } = portalsPatch({
    filters: {
      title_filter: { negative: [] },
      location_filter: { strict: true, block_hard: ["Onsite only"] },
      salary_filter: { max: 0, currency: "EUR" },
      max_posting_age_days: 30,
    },
  });
  assert.deepEqual(patch, {
    title_filter: { negative: [] },
    location_filter: { block_hard: ["Onsite only"], strict: true },
    salary_filter: { max: 0, currency: "EUR" },
    max_posting_age_days: 30,
  });
});

test("filters that scan.mjs would misread are refused", () => {
  for (const filters of [
    "all",
    { title_filter: "UX" },
    { title_filter: { positive: "UX" } },
    { location_filter: { strict: "yes" } },
    { salary_filter: { min: -1 } },
    { salary_filter: { min: 1.5 } },
    { salary_filter: { currency: "usd" } },
    { max_posting_age_days: "45" },
  ]) {
    assert.ok("error" in portalsPatch({ filters }), JSON.stringify(filters));
  }
  assert.deepEqual(portalsPatch({ filters: {} }), { error: "nothing to write" });
});

const RUNS_HEADER = "timestamp\tstatus\tcompanies\tboards\tfound\tfiltered_title\tfiltered_tier\tfiltered_location\tfiltered_posting_age\tfiltered_salary\tfiltered_content\tfiltered_cooldown\tdupes\tnew_added\terrors\tfiltered_blacklist\tfiltered_visa\tfiltered_posted_date\tfiltered_country_eligibility";

test("the last scan reads as a funnel whose segments add up to what it found", () => {
  const run = "2026-09-27T02:19:34.770Z\tcompleted\t67\t22\t40248\t37379\t0\t1170\t550\t1\t0\t0\t778\t370\t3\t0\t0\t0\t0";
  const f = scanFunnel(`${RUNS_HEADER}\n2026-09-26T14:03:29.253Z\tcompleted\t67\t22\t9\t9\t0\t0\t0\t0\t0\t0\t0\t0\t0\t0\t0\t0\t0\n${run}\r\n`);
  assert.equal(f.found, 40248);
  assert.deepEqual(Object.fromEntries(f.segments.map((s) => [s.key, s.count])), {
    title: 37379, location: 1170, salary: 1, age: 550, known: 778, other: 0, new: 370,
  });
  assert.equal(f.segments.reduce((n, s) => n + s.count, 0), f.found);
});

test("a torn or unreadable last row falls back to the run before it", () => {
  const full = "2026-09-26T14:03:29.253Z\tfailed\t67\t22\t10\t4\t1\t0\t0\t0\t0\t0\t0\t2\t0\t0\t0\t0\t0";
  const f = scanFunnel(`${RUNS_HEADER}\n${full}\n2026-09-27T02:19:34.770Z\tcompleted\t67`);
  assert.deepEqual([f.at, f.status, f.found], ["2026-09-26T14:03:29.253Z", "failed", 10]);
  assert.equal(f.segments.find((s) => s.key === "other").count, 4, "tier counts as Other");
  assert.equal(scanFunnel(""), null);
  assert.equal(scanFunnel("date\tcount\n2026-09-27\t4"), null);
});
