// Subtask C — shortlist-tray "Prepare N" wiring. TSX cannot be imported by
// node --test, so structure is asserted on source (decision-card-cta pattern)
// and the pure characterizeBatch function is extracted and actually executed.
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import assert from "node:assert/strict";
import { test } from "node:test";

const dir = dirname(fileURLToPath(import.meta.url));
const tray = readFileSync(join(dir, "../../src/components/inbox/shortlist-tray.tsx"), "utf8");
const triage = readFileSync(join(dir, "../../src/components/inbox/inbox-triage.tsx"), "utf8");

// ---- characterizeBatch: executed, not just grepped ----

function loadCharacterizeBatch() {
  const m = tray.match(/export function characterizeBatch[\s\S]*?\n\}/);
  assert.ok(m, "characterizeBatch must exist in shortlist-tray.tsx");
  const js = m[0]
    .replace("export function", "function")
    .replace(/: Array<number \| null>/g, "")
    .replace(/: PrepBatch/g, "")
    .replace(/: number\[\]/g, "");
  assert.ok(!/: [A-Z]/.test(js), "an unstripped type annotation would break execution — update the strip list");
  return new Function(`${js}; return characterizeBatch;`)();
}

test("characterizeBatch: odd count → middle score; belowFloor + blocked counted", () => {
  const c = loadCharacterizeBatch();
  assert.deepEqual(c([4.5, 3.9, 4.2, null, null]), { count: 5, median: 4.2, belowFloor: 1, blocked: 2 });
});

test("characterizeBatch: even count averages the middle pair", () => {
  const c = loadCharacterizeBatch();
  assert.deepEqual(c([5.0, 4.0]), { count: 2, median: 4.5, belowFloor: 0, blocked: 0 });
});

test("characterizeBatch: nothing scored → null median, all blocked", () => {
  const c = loadCharacterizeBatch();
  assert.deepEqual(c([null, null]), { count: 2, median: null, belowFloor: 0, blocked: 2 });
});

test("characterizeBatch: floor is exclusive at 4.0 (a 4.0 score is not below floor)", () => {
  const c = loadCharacterizeBatch();
  assert.equal(c([4.0]).belowFloor, 0);
  assert.equal(c([3.9]).belowFloor, 1);
});

// ---- two-step confirm: never spend by surprise ----

test("Prepare is two-step: first click only arms confirm; onPrepare fires only inside it", () => {
  assert.match(tray, /setConfirming\("prepare"\)/);
  const calls = tray.match(/onPrepare\(\)/g) || [];
  assert.equal(calls.length, 1, "onPrepare() must be invoked exactly once — in the confirm arm");
  assert.match(tray, /onConfirm=\{\(\) => \{ setConfirming\(null\); onPrepare\(\); \}\}/);
  assert.match(tray, /Prepare \{n\} now/, "confirm arm needs its explicit second button");
});

test("characterization + cost render pre-click on the Prepare button AND in the confirm arm", () => {
  assert.match(tray, /\{batchLine\(batch\)\} · \{prepCostText\}/, "pre-click annotation on the button");
  assert.match(tray, /\{batchText\} · \{costText\}/, "expanded line inside ConfirmPrepare");
  assert.match(tray, /below 4\.0/);
  assert.match(tray, /not scored/);
});

test("batch cap matches the /api/prepare 400 budget", () => {
  assert.match(tray, /const PREPARE_MAX = 10/);
  assert.match(tray, /n > PREPARE_MAX/);
});

test("tray stays dumb: no fetch, no submit vocabulary", () => {
  assert.ok(!/fetch\(/.test(tray), "the tray renders; the mounting page talks to the API");
  assert.ok(!/\/api\/(apply|submit)/.test(tray) && !/\/api\/(apply|submit)/.test(triage), "never-submit: no submission endpoint anywhere on this path");
});

// ---- triage wiring: /api/prepare stream, estimate fallback, results surfacing ----

test("triage POSTs {urls, cliId} to /api/prepare and reads the NDJSON stream", () => {
  assert.match(triage, /fetch\("\/api\/prepare"/);
  assert.match(triage, /JSON\.stringify\(\{ urls, cliId \}\)/);
  assert.match(triage, /res\.body\.getReader\(\)/, "same reader loop as job-store");
  assert.match(triage, /ev\.type === "item"/, "per-item outcomes must be consumed");
});

test("prepare estimate samples tailor runs, falling back to pdf while no tailor history", () => {
  const block = triage.slice(triage.indexOf("const prepEstimate"), triage.indexOf("const prepBatch"));
  const tailor = block.indexOf('j.kind === "tailor"');
  const pdf = block.indexOf('j.kind === "pdf"');
  assert.ok(tailor !== -1 && pdf !== -1 && tailor < pdf, "tailor samples first, pdf as fallback");
});

test("completion refetches server snapshots via co-job-done (job-store pattern)", () => {
  assert.match(triage, /new CustomEvent\("co-job-done"/);
});

test("prepare keeps the shortlist so per-item badges stay visible (score-send and Clear are the only wipes)", () => {
  const wipes = triage.match(/setShortlist\(\[\]\)/g) || [];
  assert.equal(wipes.length, 2, "exactly scoreShortlist's send and the tray's Clear");
});

test("blocked = no completed evaluation (missing, running, or scoreless run)", () => {
  assert.match(triage, /s && !s\.running && s\.score != null \? s\.score : null/);
});
