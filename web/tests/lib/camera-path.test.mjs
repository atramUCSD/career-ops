// The wizard camera's geometry: path endpoints, the equal-chord ring the
// duration buckets rely on, and the transform round trip the flight resumes from.

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  zoomPath,
  samplePath,
  transformFor,
  viewFromMatrix,
  radialPositions,
  durationBucket,
} from "../../src/lib/camera-path.mjs";

const close = (a, b, eps = 1e-6) => Math.abs(a - b) < eps;
const closeView = (a, b) => a.every((v, i) => close(v, b[i]));

const IDS = ["you", "what", "where", "who", "picky", "tell", "when"];
const R = 900;

test("path starts and ends on its endpoints, and zooms out between", () => {
  const p0 = [0, 0, 1440];
  const p1 = [779.4, -450, 1440];
  const { at, S } = zoomPath(p0, p1);
  assert.ok(S > 0);
  assert.ok(closeView(at(0), p0));
  assert.ok(closeView(at(1), p1));
  assert.ok(at(0.5)[2] > 1440, "mid-flight shows more world than either end");
});

test("pure zoom (same centre) takes the d2 = 0 branch and stays on centre", () => {
  const { at } = zoomPath([10, 20, 1440], [10, 20, 4000]);
  assert.ok(closeView(at(1), [10, 20, 4000]));
  assert.deepEqual(at(0.5).slice(0, 2), [10, 20]);
});

test("samplePath returns n + 1 views with exact endpoints", () => {
  const p0 = [0, 0, 1440];
  const p1 = [0, -900, 1440];
  const views = samplePath(p0, p1, 12);
  assert.equal(views.length, 13);
  assert.equal(views[0], p0);
  assert.equal(views[12], p1);
});

test("radial ring: centre at origin, What at 12 o'clock, every ring chord and spoke equals R", () => {
  const pos = radialPositions(IDS, R);
  assert.deepEqual(pos.you, [0, 0]);
  assert.ok(close(pos.what[0], 0) && close(pos.what[1], -R));
  assert.ok(pos.where[0] > 0 && pos.where[1] < 0, "Where sits at 2 o'clock");
  const ring = IDS.slice(1);
  ring.forEach((id, i) => {
    const next = pos[ring[(i + 1) % ring.length]];
    assert.ok(close(Math.hypot(pos[id][0] - next[0], pos[id][1] - next[1]), R), `${id} chord`);
    assert.ok(close(Math.hypot(...pos[id]), R), `${id} spoke`);
  });
});

test("duration bucket: one hop is camera, two ring steps and any zoom are data", () => {
  const pos = radialPositions(IDS, R);
  const v = (id) => [...pos[id], 1440];
  assert.equal(durationBucket(v("you"), v("who"), R), "camera");
  assert.equal(durationBucket(v("what"), v("where"), R), "camera");
  assert.equal(durationBucket(v("what"), v("who"), R), "data");
  assert.equal(durationBucket(v("you"), [0, 0, 4000], R), "data");
});

test("viewFromMatrix inverts transformFor", () => {
  const view = [779.4, -450, 2880];
  const [tx, ty, k] = transformFor(view, 1440, 900).match(/-?\d+(\.\d+)?(e-?\d+)?/g).map(Number);
  assert.ok(closeView(viewFromMatrix({ a: k, e: tx, f: ty }, 1440, 900), view));
});
