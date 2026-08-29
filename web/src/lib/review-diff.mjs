/**
 * review-diff.mjs — the review queue's delta between a tailored CV and cv.md.
 *
 * Pure text lib (no fs, no framework — same pattern as clean-chips.mjs /
 * pdf-paths.mjs) so `node --test` can gate it from the root suite. The review
 * page (src/app/review/page.tsx) does the file reads and passes strings in.
 *
 * The point of the review queue is the DELTA: a bullet identical to one in
 * cv.md needs no human eyes, so only changed/added bullets are returned, each
 * tagged with where its content came from:
 *
 *   verbatim-in-cv.md — the exact text exists in cv.md (just not as this
 *                       bullet — e.g. lifted from the summary or another role)
 *   reworded          — majority word-overlap with one cv.md bullet (that
 *                       closest bullet is returned for a was/now display)
 *   story-bank claim  — no cv.md trace at all; by the Source-of-Truth
 *                       Boundary this content can only have come from
 *                       story-bank.md or the JD, so it gets the loudest tag
 */

const ENTITIES = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " ", ndash: "–", mdash: "—" };

/** Decode the handful of entities the CV template/agents actually emit.
 *  @param {string} s @returns {string} */
function decodeEntities(s) {
  return s
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(parseInt(d, 10)))
    .replace(/&([a-z]+);/gi, (m, name) => ENTITIES[name.toLowerCase()] ?? m);
}

/** Comparison key: lowercased, entity-decoded, punctuation-insensitive,
 *  whitespace-collapsed. @param {string} s @returns {string} */
export function normalize(s) {
  return decodeEntities(s)
    .toLowerCase()
    .replace(/[*_`]/g, "")
    .replace(/[.,;:!?'"()\[\]]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/** Significant words of a normalized string: 4+ chars or containing a digit
 *  (numbers are the salient part of a CV bullet). @param {string} s */
function words(s) {
  return normalize(s)
    .split(" ")
    .filter((w) => w.length >= 4 || /\d/.test(w));
}

/** Bullet texts (`<li>` inner text, tags stripped, entities decoded) from the
 *  tailored CV HTML the pdf worker wrote. @param {string} html @returns {string[]} */
export function extractHtmlBullets(html) {
  const out = [];
  const re = /<li\b[^>]*>([\s\S]*?)<\/li>/gi;
  let m;
  while ((m = re.exec(html)) !== null) {
    const text = decodeEntities(m[1].replace(/<[^>]+>/g, " ")).replace(/\s+/g, " ").trim();
    if (text) out.push(text);
  }
  return out;
}

/** Markdown bullets from cv.md, with wrapped continuation lines joined and
 *  emphasis/link markup stripped. @param {string} md @returns {string[]} */
export function extractCvBullets(md) {
  const out = [];
  let current = null;
  for (const line of md.split("\n")) {
    const b = line.match(/^\s*[-*]\s+(.*)$/);
    if (b) {
      if (current) out.push(current);
      current = b[1];
    } else if (current && /^\s+\S/.test(line)) {
      current += " " + line.trim(); // wrapped continuation of the open bullet
    } else {
      if (current) out.push(current);
      current = null;
    }
  }
  if (current) out.push(current);
  return out.map(stripMd).filter(Boolean);
}

/** @param {string} s @returns {string} */
function stripMd(s) {
  return s
    .replace(/\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/[*_`]/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * @typedef {Object} DeltaBullet
 * @property {string} text - The tailored bullet as it will render.
 * @property {"verbatim-in-cv.md"|"reworded"|"story-bank claim"} source
 * @property {string|null} closest - For "reworded": the cv.md bullet it rewrites.
 */

/**
 * The delta: tailored bullets that are NOT verbatim cv.md bullets, tagged
 * with their provenance. Unchanged bullets are omitted entirely — the review
 * queue shows what moved, never a full document dump.
 * @param {string} tailoredHtml
 * @param {string} cvMd
 * @returns {DeltaBullet[]}
 */
export function reviewDelta(tailoredHtml, cvMd) {
  const cvBullets = extractCvBullets(cvMd);
  const cvBulletKeys = new Set(cvBullets.map(normalize));
  const cvTextKey = normalize(stripMd(cvMd));
  const delta = [];
  for (const text of extractHtmlBullets(tailoredHtml)) {
    const key = normalize(text);
    if (!key || cvBulletKeys.has(key)) continue; // unchanged — not reviewable
    if (cvTextKey.includes(key)) {
      delta.push({ text, source: "verbatim-in-cv.md", closest: null });
      continue;
    }
    // ponytail: O(bullets²) word-overlap scan — fine at CV scale (tens of bullets)
    const w = words(text);
    let best = null;
    let bestRatio = 0;
    for (const cv of cvBullets) {
      const cvWords = new Set(words(cv));
      const ratio = w.length ? w.filter((x) => cvWords.has(x)).length / w.length : 0;
      if (ratio > bestRatio) {
        bestRatio = ratio;
        best = cv;
      }
    }
    if (bestRatio >= 0.5 && best) delta.push({ text, source: "reworded", closest: best });
    else delta.push({ text, source: "story-bank claim", closest: null });
  }
  return delta;
}

/**
 * Which story-provenance-check claims appear in this text. Claims are the
 * checker's bucket entries ({story, claim, pattern, ...}); matching is
 * normalized and comma-insensitive ("1,200 users" hits "1200 users").
 * @template {{claim: string}} C
 * @param {string} text
 * @param {C[]} claims
 * @returns {C[]}
 */
export function matchClaims(text, claims) {
  // digit-group commas must go BEFORE normalize turns "," into a space
  const flatten = (s) => normalize(s.replace(/(\d),(?=\d)/g, "$1"));
  const flat = flatten(text);
  return claims.filter((c) => {
    const key = flatten(c.claim);
    return key.length > 0 && flat.includes(key);
  });
}
