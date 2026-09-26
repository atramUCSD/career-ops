// Tests for the pure chart geometry behind build-artifact.mjs's SVG charts.
// Imports straight from chart-geometry.mjs so the renderer and the tests can
// never drift apart.
//
// Run:  node --test web/tests/lib/chart-geometry.test.mjs

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  scaleLinear,
  barWidths,
  histogramBins,
  stackedSegments,
  sparklinePath,
  shadePct,
} from "../../src/lib/chart-geometry.mjs";

test("scaleLinear maps the domain edges and clamps beyond them", () => {
  const s = scaleLinear(10, 100);
  assert.equal(s(0), 0);
  assert.equal(s(10), 100);
  assert.equal(s(5), 50);
  assert.equal(s(-3), 0); // below the domain clamps, never a negative width
  assert.equal(s(25), 100); // above the domain clamps to the full range
});

test("a degenerate scale maps everything to zero instead of NaN", () => {
  assert.equal(scaleLinear(0, 100)(5), 0);
  assert.equal(scaleLinear(10, 0)(5), 0);
  assert.equal(scaleLinear(-1, 100)(5), 0);
});

test("bar geometry: n=0 is a zero-width bar, the max spans the full width", () => {
  assert.deepEqual(barWidths([0, 5, 10], 200), [0, 100, 200]);
});

test("bar geometry floors non-zero counts at min while zero stays zero", () => {
  assert.deepEqual(barWidths([0, 1, 100], 100, 4), [0, 4, 100]);
  // The floor never inflates a bar already above it.
  assert.deepEqual(barWidths([50, 100], 100, 4), [50, 100]);
});

test("bar geometry survives an all-zero and an empty dataset", () => {
  // The all-zero case is the divide-by-max trap: every bar must be 0, not NaN.
  assert.deepEqual(barWidths([0, 0, 0], 200), [0, 0, 0]);
  assert.deepEqual(barWidths([], 200), []);
});

test("histogram bins cover the range and the closed top lands in the last bin", () => {
  const bins = histogramBins([0, 9, 99, 100], 10, 100);
  assert.equal(bins.length, 10);
  assert.equal(bins[0].n, 2); // 0 and 9
  assert.equal(bins[9].n, 2); // 99 and the score of exactly 100
  assert.deepEqual([bins[0].x0, bins[0].x1], [0, 10]);
  assert.deepEqual([bins[9].x0, bins[9].x1], [90, 100]);
});

test("histogram clamps strays into range and skips non-numbers", () => {
  const bins = histogramBins([-5, 250, null, NaN, "7"], 10, 100);
  assert.equal(bins[0].n, 1); // -5 clamps to 0
  assert.equal(bins[9].n, 1); // 250 clamps to 100
  assert.equal(bins.reduce((a, b) => a + b.n, 0), 2); // null/NaN/string dropped
});

test("stacked segments tile the strip proportionally", () => {
  assert.deepEqual(stackedSegments([1, 1, 2], 100), [
    { x: 0, w: 25 },
    { x: 25, w: 25 },
    { x: 50, w: 50 },
  ]);
});

test("an empty stack renders zero-width segments, not a division by zero", () => {
  assert.deepEqual(stackedSegments([0, 0], 100), [
    { x: 0, w: 0 },
    { x: 0, w: 0 },
  ]);
  assert.deepEqual(stackedSegments([], 100), []);
});

test("sparkline path outputs: two points span the width, y inverts", () => {
  // 0 sits on the baseline (y = height), the max at the top (y = 0).
  assert.equal(sparklinePath([0, 10], 100, 20, 10), "M0,20 L100,0");
});

test("sparkline honors a shared yMax rather than its own max", () => {
  // Row peaks at 5 but the chart-wide peak is 10 → the line tops out halfway.
  assert.equal(sparklinePath([0, 5], 100, 20, 10), "M0,20 L100,10");
});

test("sparkline edge cases: empty, single point, zero yMax", () => {
  assert.equal(sparklinePath([], 100, 20, 10), "");
  assert.equal(sparklinePath([5], 120, 20, 5), "M60,0"); // one centered point
  assert.equal(sparklinePath([3, 4], 100, 20, 0), "M0,20 L100,20"); // flat baseline
});

test("heat shade scales to the cap and an empty heatmap shades nothing", () => {
  assert.equal(shadePct(0, 10), 0);
  assert.equal(shadePct(5, 10), 30);
  assert.equal(shadePct(10, 10), 60);
  assert.equal(shadePct(99, 10), 60); // over-max clamps to the cap
  assert.equal(shadePct(3, 0), 0);
});
