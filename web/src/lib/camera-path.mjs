// Camera math for the setup wizard's world (DESIGN.md 7a). Pure, so node --test
// can hold it to the geometry the plan promises.
//
// A view is [cx, cy, w]: the world point at the viewport centre and the world
// width the viewport shows. That is van Wijk and Nuij's parameterisation, so the
// smooth-zoom path needs no conversion; scale is viewportWidth / w.

/**
 * van Wijk and Nuij's optimal pan-and-zoom path, as d3-interpolate's
 * interpolateZoom computes it. rho = sqrt(2) is their measured sweet spot.
 * Returns S (path length, grows with distance) and at(t) for t in [0, 1].
 */
export function zoomPath(p0, p1, rho = Math.SQRT2) {
  const [ux0, uy0, w0] = p0;
  const [ux1, uy1, w1] = p1;
  const dx = ux1 - ux0;
  const dy = uy1 - uy0;
  const d2 = dx * dx + dy * dy;
  const rho2 = rho * rho;
  const rho4 = rho2 * rho2;

  // Pure zoom: the general form divides by the distance.
  if (d2 < 1e-12) {
    const S = Math.log(w1 / w0) / rho;
    return { S, at: (t) => [ux0 + t * dx, uy0 + t * dy, w0 * Math.exp(rho * t * S)] };
  }

  const d1 = Math.sqrt(d2);
  const b0 = (w1 * w1 - w0 * w0 + rho4 * d2) / (2 * w0 * rho2 * d1);
  const b1 = (w1 * w1 - w0 * w0 - rho4 * d2) / (2 * w1 * rho2 * d1);
  const r0 = Math.log(Math.sqrt(b0 * b0 + 1) - b0);
  const r1 = Math.log(Math.sqrt(b1 * b1 + 1) - b1);
  const S = (r1 - r0) / rho;
  return {
    S,
    at: (t) => {
      const s = t * S;
      const coshr0 = Math.cosh(r0);
      const u = (w0 / (rho2 * d1)) * (coshr0 * Math.tanh(rho * s + r0) - Math.sinh(r0));
      return [ux0 + u * dx, uy0 + u * dy, (w0 * coshr0) / Math.cosh(rho * s + r0)];
    },
  };
}

/** n + 1 views sampled evenly along the path, endpoints exact. */
export function samplePath(p0, p1, n = 12) {
  const { at } = zoomPath(p0, p1);
  return Array.from({ length: n + 1 }, (_, i) => (i === 0 ? p0 : i === n ? p1 : at(i / n)));
}

/** CSS transform that puts view [cx, cy, w] on a vw x vh viewport (transform-origin 0 0). */
export function transformFor([cx, cy, w], vw, vh) {
  const k = vw / w;
  return `translate(${vw / 2 - cx * k}px, ${vh / 2 - cy * k}px) scale(${k})`;
}

/** Inverse of transformFor, from a matrix's a, e, f (DOMMatrix field names). */
export function viewFromMatrix({ a, e, f }, vw, vh) {
  return [(vw / 2 - e) / a, (vh / 2 - f) / a, vw / a];
}

/**
 * Centre at [0, 0], then the ring clockwise from 12 o'clock at 360/ring degree
 * steps. With six on the ring, every ring chord equals R, so a spoke and a ring
 * step are the same flight.
 */
export function radialPositions(ids, R) {
  const [centre, ...ring] = ids;
  const out = { [centre]: [0, 0] };
  ring.forEach((id, i) => {
    const a = (i * 2 * Math.PI) / ring.length;
    out[id] = [R * Math.sin(a), -R * Math.cos(a)];
  });
  return out;
}

/**
 * Duration bucket for a flight: "camera" for one hop at constant zoom, "data"
 * for anything longer or any change of zoom (the review zoom-out). Bucketed by
 * world distance, not stage count, so You to any ring stage is one hop.
 */
export function durationBucket(p0, p1, hop) {
  const zoomed = Math.abs(p1[2] / p0[2] - 1) > 0.01;
  const dist = Math.hypot(p1[0] - p0[0], p1[1] - p0[1]);
  return !zoomed && dist <= hop + 1 ? "camera" : "data";
}
