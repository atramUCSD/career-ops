// Tests for the review queue's delta lib. Pure-text assertions against
// review-diff.mjs (the single source of truth for what the review page shows),
// discovered by the root test-all.mjs gate like every web/tests/lib suite.
//
// Run:  node --test tests/lib/review-diff.test.mjs

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  extractHtmlBullets,
  extractCvBullets,
  reviewDelta,
  matchClaims,
} from "../../src/lib/review-diff.mjs";

const CV = `# Jane Doe

## Summary

Platform engineer focused on developer tooling and CI reliability.

## Experience

### Acme — Remote
**Engineer** · 2023 – Present

- Led migration of the build system to Bazel across 14 services,
  cutting CI time by 40%.
- Maintained the **internal deploy CLI** used by 30 engineers.
- Wrote [runbooks](https://acme.example/runbooks) for on-call rotations.
`;

test("extractHtmlBullets strips tags, decodes entities, skips empties", () => {
  const html = `<ul>
    <li>Cut CI time by 40% &amp; kept builds green</li>
    <li><strong>Maintained</strong> the deploy&nbsp;CLI</li>
    <li>   </li>
  </ul>`;
  assert.deepEqual(extractHtmlBullets(html), [
    "Cut CI time by 40% & kept builds green",
    "Maintained the deploy CLI",
  ]);
});

test("extractCvBullets joins wrapped lines and strips markdown", () => {
  const bullets = extractCvBullets(CV);
  assert.equal(bullets.length, 3);
  // the wrapped continuation line is part of the first bullet
  assert.match(bullets[0], /cutting CI time by 40%\.$/);
  // ** emphasis and [link](url) markup are stripped
  assert.equal(bullets[1], "Maintained the internal deploy CLI used by 30 engineers.");
  assert.equal(bullets[2], "Wrote runbooks for on-call rotations.");
});

test("a bullet identical to cv.md is NOT in the delta", () => {
  const html = `<li>Maintained the internal deploy CLI used by 30 engineers.</li>`;
  assert.deepEqual(reviewDelta(html, CV), []);
});

test("case/whitespace/punctuation-only differences are still unchanged", () => {
  const html = `<li>maintained the  Internal deploy CLI used by 30 engineers</li>`;
  assert.deepEqual(reviewDelta(html, CV), []);
});

test("text lifted verbatim from cv.md prose is tagged verbatim-in-cv.md", () => {
  // exists in the Summary, not as a bullet — added, but traceable word-for-word
  const html = `<li>developer tooling and CI reliability</li>`;
  const d = reviewDelta(html, CV);
  assert.equal(d.length, 1);
  assert.equal(d[0].source, "verbatim-in-cv.md");
  assert.equal(d[0].closest, null);
});

test("a rewrite of an existing bullet is tagged reworded with its closest source", () => {
  const html = `<li>Led the Bazel build system migration across 14 services, cutting CI time by 40% for every team.</li>`;
  const d = reviewDelta(html, CV);
  assert.equal(d.length, 1);
  assert.equal(d[0].source, "reworded");
  assert.match(d[0].closest, /migration of the build system to Bazel/);
});

test("content with no cv.md trace is tagged story-bank claim", () => {
  const html = `<li>Negotiated vendor contracts saving $250K annually.</li>`;
  const d = reviewDelta(html, CV);
  assert.equal(d.length, 1);
  assert.equal(d[0].source, "story-bank claim");
});

test("delta preserves bullet order and mixes sources", () => {
  const html = `
    <li>Maintained the internal deploy CLI used by 30 engineers.</li>
    <li>Led the Bazel migration across 14 services, cutting CI time by 40%.</li>
    <li>Scaled the platform to 2M requests per day.</li>`;
  const d = reviewDelta(html, CV);
  assert.deepEqual(
    d.map((b) => b.source),
    ["reworded", "story-bank claim"],
  );
});

test("matchClaims finds claims normalized and comma-insensitively", () => {
  const claims = [
    { story: "Rollout", claim: "1,200 users", pattern: "count-noun" },
    { story: "Vendor", claim: "$250K", pattern: "money" },
    { story: "Other", claim: "15-person team", pattern: "headcount" },
  ];
  const hits = matchClaims("Onboarded 1200 users and saved $250K.", claims);
  assert.deepEqual(
    hits.map((c) => c.story),
    ["Rollout", "Vendor"],
  );
  assert.deepEqual(matchClaims("No numbers here.", claims), []);
});

test("empty inputs are empty results, not crashes", () => {
  assert.deepEqual(extractHtmlBullets(""), []);
  assert.deepEqual(extractCvBullets(""), []);
  assert.deepEqual(reviewDelta("", ""), []);
  assert.deepEqual(matchClaims("anything", []), []);
});
