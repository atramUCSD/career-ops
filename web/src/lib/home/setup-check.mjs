import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import * as yaml from "js-yaml";

// System-layer sites checkLaneRegistration reads. They live in the code root
// even while a profile is active, and the core reads every site from one
// root: pointed at a profile it calls these missing, pointed at the code root
// it reads the owner's portals.yml and profile.yml instead of the profile's.
const CODE_SITES = ["modes/_shared.md", "batch/batch-prompt.md"];

/**
 * checkLaneRegistration findings for a data root that may not be the code
 * root. `check` is the core's function, injected so this module never imports
 * a root file (the web bundler would try to trace it).
 *
 * @param {{codeRoot: string, userRoot: string, lanes: {golden_case?: string}[],
 *   check: (lanes: any[], opts: {root: string}) => {lane: string, severity: string, site: string, message: string}[]}} opts
 */
export function laneFindings({ codeRoot, userRoot, lanes, check }) {
  if (path.resolve(codeRoot) === path.resolve(userRoot)) return check(lanes, { root: codeRoot });
  // Golden cases are evals/golden/*.json in the checkout, never in a profile.
  const codeSite = new Set([...CODE_SITES, ...lanes.map((l) => l.golden_case).filter(Boolean)]);
  return [
    ...check(lanes, { root: userRoot }).filter((f) => !codeSite.has(f.site)),
    ...check(lanes, { root: codeRoot }).filter((f) => codeSite.has(f.site)),
  ];
}

/**
 * { laneId: { keyword: "missing" | "blocked" } } from the portals.yml errors.
 * The core reports a keyword absent from title_filter.positive twice, once as
 * missing and once as "blocked by a negative", because its accepts() probe
 * also fails when no positive matches. Count keywords, not findings.
 */
export function driftedKeywords(findings) {
  const out = {};
  for (const f of findings) {
    const m = f.site === "portals.yml" && f.severity === "error" && /^title keyword "(.*)" is (not in|blocked)/.exec(f.message);
    if (!m) continue;
    const lane = (out[f.lane] ??= {});
    // "missing" wins: adding the keyword to the positives is the fix, and
    // whether a negative also blocks it can only be judged after that.
    if (m[2] === "not in" || !lane[m[1]]) lane[m[1]] = m[2] === "not in" ? "missing" : "blocked";
  }
  return out;
}

function readText(root, rel) {
  try {
    return readFileSync(path.join(root, rel), "utf8");
  } catch (e) {
    if (e.code === "ENOENT") return null;
    throw e;
  }
}

function parseYaml(text, rel) {
  try {
    return yaml.load(text) ?? {};
  } catch (e) {
    throw new Error(e.mark ? `${rel} doesn't parse at line ${e.mark.line + 1}: ${e.reason}` : e.message);
  }
}

const plural = (n, word) => `${n} ${word}${n === 1 ? "" : "s"}`;

/**
 * The six files a data root needs before its scans and scores mean anything.
 * Existence alone is not the test: doctor.mjs auto-copies templates and
 * profiles.mjs scaffolds a stub CV, so four of these exist from the first
 * second and would all read as done.
 *
 * @param {{codeRoot: string, userRoot: string, core: {
 *   isStubCv: (text: string) => boolean,
 *   unpersonalizedFiles: (root: string, templateRoot: string) => {path: string, reason: string, impact: string}[],
 *   loadLanes: (file: string) => {id: string, archetype: string, title_keywords: string[], golden_case?: string}[],
 *   checkLaneRegistration: (lanes: any[], opts: {root: string}) => {lane: string, severity: string, site: string, message: string}[],
 * }}} opts
 */
export function setupChecklist({ codeRoot, userRoot, core }) {
  const text = (rel) => readText(userRoot, rel);
  // One unreadable file must not take the whole checklist, or the Home page,
  // down with it; it becomes that row's failure instead.
  const item = (id, label, check) => {
    try {
      return { id, label, ...check() };
    } catch (e) {
      return { id, label, ready: false, detail: e.message };
    }
  };

  const items = [
    item("cv", "cv.md", () => {
      const cv = text("cv.md");
      if (cv === null) return { ready: false, detail: "Missing. Every score needs a CV to read." };
      if (core.isStubCv(cv)) return { ready: false, detail: "Still the scaffolded stub. Paste the real CV over it." };
      return { ready: true, detail: "Canonical CV" };
    }),
    item("profile", "config/profile.yml", () => {
      const t = text("config/profile.yml");
      if (t === null) return { ready: false, detail: "Missing. Name, targets and comp live here." };
      parseYaml(t, "config/profile.yml");
      return { ready: true, detail: "Name, targets, comp" };
    }),
    item("portals", "portals.yml", () => {
      const t = text("portals.yml");
      if (t === null) return { ready: false, detail: "Missing. The scanner has nothing to scan." };
      const doc = parseYaml(t, "portals.yml");
      // Same skip rule as scan.mjs resolveEntries.
      const n = (Array.isArray(doc.tracked_companies) ? doc.tracked_companies : []).filter(
        (c) => c && typeof c === "object" && c.enabled !== false && typeof c.name === "string" && c.name.trim(),
      ).length;
      return { ready: true, detail: `${n} compan${n === 1 ? "y" : "ies"}` };
    }),
    item("alerts", "config/alerts.yml", () => {
      const t = text("config/alerts.yml");
      if (t === null) return { ready: false, detail: "No digest set up for this profile." };
      const doc = parseYaml(t, "config/alerts.yml");
      const cfg = doc.alerts ?? doc;
      if (cfg.enabled === false) return { ready: true, detail: "Digest turned off" };
      if (!String(cfg.to ?? "").trim()) return { ready: false, detail: "No recipient, so nothing is sent." };
      return { ready: true, detail: "Digest settings" };
    }),
    item("personalization", "modes/_profile.md", () => {
      if (text("modes/_profile.md") === null) return { ready: false, detail: "Missing. Evaluations have no archetypes to score against." };
      const flagged = core.unpersonalizedFiles(userRoot, codeRoot);
      if (flagged.length === 0) return { ready: true, detail: "Archetypes and North Star" };
      return {
        ready: false,
        detail: flagged.map((f) => `${f.path} ${f.reason}: ${f.impact}.`).join(" "),
        action: "personalize",
      };
    }),
    item("lanes", "config/lanes.yml", () => {
      const file = path.join(userRoot, "config", "lanes.yml");
      if (!existsSync(file)) return { ready: true, detail: "Optional. Scans use the title filter alone." };
      const lanes = core.loadLanes(file);
      const findings = laneFindings({ codeRoot, userRoot, lanes, check: core.checkLaneRegistration });
      const errors = findings.filter((f) => f.severity === "error");
      if (errors.length === 0) return { ready: true, detail: `${plural(lanes.length, "lane")} in sync` };
      const drifted = Object.values(driftedKeywords(findings)).reduce((n, kws) => n + Object.keys(kws).length, 0);
      return {
        ready: false,
        detail: drifted
          ? `${plural(drifted, "lane keyword")} drifted from the title filter`
          : `${plural(errors.length, "archetype gap")} in the evaluation files`,
        action: "lanes",
      };
    }),
  ];
  return { items, ready: items.filter((i) => i.ready).length, total: items.length };
}

const csvRow = (line) => [...line.matchAll(/"((?:[^"]|"")*)"/g)].map((m) => m[1].replace(/""/g, '"').trim());
const clock = (t) => `${((Math.floor(t / 60) + 11) % 12) + 1}:${String(t % 60).padStart(2, "0")} ${t < 720 ? "AM" : "PM"}`;

/** "7:00:00 AM" repeated every "12 Hour(s), 0 Minute(s)" is 7:00 AM and 7:00 PM. */
function runTimes(start, repeat) {
  const s = /^(\d{1,2}):(\d{2})(?::\d{2})?\s*([AP])M$/i.exec(start ?? "");
  if (!s) return [];
  const first = ((Number(s[1]) % 12) + (s[3].toUpperCase() === "P" ? 12 : 0)) * 60 + Number(s[2]);
  const r = /(\d+) Hour\(s\), (\d+) Minute\(s\)/.exec(repeat ?? "");
  const step = r ? Number(r[1]) * 60 + Number(r[2]) : 0;
  const times = [first];
  for (let t = first + step; step > 0 && t < first + 1440 && times.length < 4; t += step) times.push(t % 1440);
  return times.map(clock);
}

// Last Result codes that are states, not failures: SCHED_S_TASK_RUNNING and
// SCHED_S_TASK_HAS_NOT_RUN.
const RUNNING = 0x41301;
const NOT_RUN = 0x41303;

/**
 * The scheduled alert task from `schtasks /query /tn <name> /fo CSV /v`, or
 * null for anything else: no such task, another OS, or a Windows display
 * language that translates the column names.
 */
export function parseSchtasks(csv) {
  const [head, row] = String(csv ?? "").split(/\r?\n/).filter((l) => l.trim()).map(csvRow);
  if (!head || !row) return null;
  const get = (name) => {
    const v = row[head.indexOf(name)];
    return v && v !== "N/A" ? v : null;
  };
  if (!get("TaskName")) return null;
  const when = (s) => {
    const d = new Date(s ?? "");
    return Number.isNaN(d.getTime()) || d.getFullYear() < 2000 ? null : d.toISOString();
  };
  const lastResult = Number(get("Last Result"));
  const health =
    get("Scheduled Task State") !== "Enabled" ? "disabled"
    : lastResult === 0 ? "healthy"
    : lastResult === RUNNING ? "running"
    : lastResult === NOT_RUN ? "not-run"
    : "failing";
  return {
    health,
    lastResult: Number.isFinite(lastResult) ? lastResult : null,
    lastRun: when(get("Last Run Time")),
    nextRun: when(get("Next Run Time")),
    times: runTimes(get("Start Time"), get("Repeat: Every")),
  };
}
