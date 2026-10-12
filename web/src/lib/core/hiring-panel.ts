import path from "node:path";
import { coreModule, userRoot } from "@/lib/career-ops";

/**
 * Hiring-panel runs (modes/hiring-panel.md), read through the core's
 * hiring-panel.mjs so the dashboard never parses the run folder itself
 * (AGENTS.md rule 1). Read-only: the dashboard never starts a run, because the
 * readers need isolated subagents.
 */

export type PanelDefect = {
  n: number;
  line: string;
  category: string;
  problem: string;
  readers: string[];
  k: number;
  fix: string;
  split: boolean;
  disposition: "pending" | "fix" | "needs-user" | "wontfix";
  note: string | null;
};

export type PanelRun = {
  dir: string;
  date: string | null;
  meta: {
    source: string;
    sha256: string;
    report: number | null;
    jd: string;
    extraction: string;
    isolated: boolean;
    mustHaves: number;
  } | null;
  verdicts: { id: string; short: string; verdict: string; good: boolean }[];
  ats: { before: string | null; after: string | null; missingBefore: number | null; missingAfter: number | null };
  /** null until `merge` has written 08-defects.md. */
  defects: PanelDefect[] | null;
  questions: number;
  /** null when the source is pasted, gone, or unhashable. */
  sourceChanged: boolean | null;
  problems: string[];
};

type HiringPanelModule = {
  listRuns: (panelDir: string, opts: { root: string }) => PanelRun[];
  indexRuns: (runs: PanelRun[]) => { byReport: Map<number, PanelRun>; master: PanelRun | null };
};

let warned = false;

async function index(): Promise<ReturnType<HiringPanelModule["indexRuns"]> | null> {
  let mod: HiringPanelModule;
  try {
    mod = await coreModule<HiringPanelModule>("hiring-panel");
  } catch {
    // Older checkout without the module: the panel surfaces hide.
    if (!warned) {
      warned = true;
      console.warn("[career-ops] could not load hiring-panel.mjs — update career-ops to show hiring-panel runs.");
    }
    return null;
  }
  const root = userRoot();
  return mod.indexRuns(mod.listRuns(path.join(root, "output", ".hiring-panel"), { root }));
}

/** The newest run per report number. */
export async function panelRunsByReport(): Promise<Map<number, PanelRun>> {
  return (await index())?.byReport ?? new Map();
}

/** The newest run on cv.md with no report. */
export async function latestMasterRun(): Promise<PanelRun | null> {
  return (await index())?.master ?? null;
}
