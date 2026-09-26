// Pure geometry for the server-rendered SVG charts in build-artifact.mjs.
// No DOM, no React, no I/O — same contract as funnel-tiles.mjs, so the web
// app can import it as @/lib/chart-geometry.mjs and root code by relative
// path, and both stay unit-testable under a bare `node`.

const round2 = (n) => Math.round(n * 100) / 100;

/**
 * Linear scale from [0, domainMax] to [0, rangeMax]. Values clamp into the
 * domain; a degenerate domain or range maps everything to 0 rather than NaN.
 *
 * @param {number} domainMax
 * @param {number} rangeMax
 * @returns {(v: number) => number}
 */
export function scaleLinear(domainMax, rangeMax) {
  return (v) => {
    if (!(domainMax > 0) || !(rangeMax > 0)) return 0;
    const x = Math.min(Math.max(v, 0), domainMax);
    return round2((x / domainMax) * rangeMax);
  };
}

/**
 * Widths for left-aligned bars sharing one baseline: the largest count spans
 * the full width, zero spans zero. All-zero input yields all-zero widths.
 * `min` floors the width of a non-zero count so a tiny bar stays visible;
 * a zero count always renders at 0.
 *
 * @param {number[]} counts
 * @param {number} maxWidth
 * @param {number} [min]
 * @returns {number[]}
 */
export function barWidths(counts, maxWidth, min = 0) {
  const list = Array.isArray(counts) ? counts : [];
  const s = scaleLinear(Math.max(0, ...list), maxWidth);
  return list.map((c) => (c > 0 ? Math.max(s(c), min) : s(c)));
}

/**
 * Fixed-width histogram bins over [0, max]. Values clamp into range (the
 * closed top lands in the last bin); non-finite values are skipped.
 *
 * @param {number[]} values
 * @param {number} binSize
 * @param {number} [max]
 * @returns {{x0: number, x1: number, n: number}[]}
 */
export function histogramBins(values, binSize, max = 100) {
  const count = Math.max(1, Math.ceil(max / binSize));
  const bins = Array.from({ length: count }, (_, i) => ({
    x0: i * binSize,
    x1: Math.min((i + 1) * binSize, max),
    n: 0,
  }));
  for (const v of Array.isArray(values) ? values : []) {
    if (typeof v !== 'number' || !Number.isFinite(v)) continue;
    const c = Math.min(Math.max(v, 0), max);
    bins[Math.min(Math.floor(c / binSize), count - 1)].n++;
  }
  return bins;
}

/**
 * Offsets and widths for one horizontal stacked strip. Segment widths are
 * proportional shares of `width`; a zero total renders every segment at 0
 * rather than dividing by it.
 *
 * @param {number[]} counts
 * @param {number} width
 * @returns {{x: number, w: number}[]}
 */
export function stackedSegments(counts, width) {
  const list = (Array.isArray(counts) ? counts : []).map((c) => Math.max(0, c || 0));
  const total = list.reduce((a, b) => a + b, 0);
  let x = 0;
  return list.map((c) => {
    const w = total > 0 ? (c / total) * width : 0;
    const seg = { x: round2(x), w: round2(w) };
    x += w;
    return seg;
  });
}

/**
 * SVG path for one sparkline. `yMax` is passed in, not derived, so every row
 * of a chart can share one scale. Empty input yields '', a single point a
 * centered dot-length path, a zero/invalid yMax a flat baseline.
 *
 * @param {number[]} values
 * @param {number} width
 * @param {number} height
 * @param {number} yMax
 * @returns {string}
 */
export function sparklinePath(values, width, height, yMax) {
  const list = Array.isArray(values) ? values : [];
  if (list.length === 0) return '';
  const sy = scaleLinear(yMax, height);
  const step = list.length > 1 ? width / (list.length - 1) : 0;
  const pts = list.map((v, i) => {
    const x = list.length > 1 ? i * step : width / 2;
    return `${round2(x)},${round2(height - sy(v))}`;
  });
  return 'M' + pts.join(' L');
}

/**
 * Heat-cell shade intensity as a percentage, capped so the count printed on
 * top of the shade stays readable. Zero max (an empty heatmap) shades nothing.
 *
 * @param {number} count
 * @param {number} max
 * @param {number} [cap]
 * @returns {number}
 */
export function shadePct(count, max, cap = 60) {
  if (!(max > 0)) return 0;
  return Math.round((Math.min(Math.max(count, 0), max) / max) * cap);
}
