import { test } from "node:test";
import assert from "node:assert/strict";
import { portalsPatch } from "../../src/lib/portals-config.mjs";

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
