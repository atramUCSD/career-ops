import { execFile } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { parseEnv, promisify } from "node:util";
import * as yaml from "js-yaml";
import { careerOpsRoot, coreModule, profilesModule, readInbox, userRoot, activeProfile, type NotifyModule } from "@/lib/career-ops";
import { scanFunnel } from "@/lib/portals-config.mjs";
import { driftedKeywords, laneFindings, parseSchtasks, setupChecklist } from "@/lib/home/setup-check.mjs";

// Everything Home shows about profiles, the digest, filters, lanes and
// preferences, read once per request from the same files and core modules the
// CLI uses. Each section fails on its own: a malformed lanes.yml shows as an
// error in the lanes panel instead of taking the page down.

type Lane = {
  id: string;
  archetype: string;
  title_keywords: string[];
  jd_gate?: { positive?: string[]; negative?: string[] };
  max_evaluations?: number;
  golden_case?: string;
};
type Finding = { lane: string; severity: string; site: string; message: string };
type LanesModule = {
  loadLanes: (file: string) => Lane[];
  checkLaneRegistration: (lanes: Lane[], opts: { root: string }) => Finding[];
  laneForTitle: (title: string, lanes: Lane[]) => { id: string } | null;
};
type PersonalizationModule = {
  unpersonalizedFiles: (root: string, templateRoot: string) => { path: string; reason: string; impact: string }[];
};
type GmailModule = { credentialsFrom: (env: Record<string, string | undefined>) => { missing: string[] } };

export type Failed = { error: string };
export type Checklist = ReturnType<typeof setupChecklist>;
export type Schedule = NonNullable<ReturnType<typeof parseSchtasks>>;
export type Funnel = NonNullable<ReturnType<typeof scanFunnel>>;

export type ProfileCard = {
  name: string | null; // null is the owner
  label: string;
  roles: string;
  dir: string;
  pending: number;
  digest: string;
  setup: { ready: number; total: number };
  active: boolean;
};

export type HomeData = {
  profiles: ProfileCard[];
  active: ProfileCard;
  checklist: Checklist | Failed;
  schedule: Schedule | null;
  gmailMissing: string[];
  alerts: ({ exists: boolean; lastRun: string | null } & Record<string, unknown>) | Failed;
  filters: Record<string, unknown> | null | Failed;
  funnel: Funnel | null;
  lanes:
    | {
        list: (Lane & { pending: number; drifted: Record<string, "missing" | "blocked"> })[];
        sites: { site: string; ok: boolean; note?: string }[];
      }
    | null
    | Failed;
  prefs: Record<string, unknown> | null | Failed;
  checkedAt: string;
};

const attempt = <T>(fn: () => T): T | Failed => {
  try {
    return fn();
  } catch (e) {
    return { error: e instanceof Error ? e.message : String(e) };
  }
};
export const failed = (v: unknown): v is Failed => !!v && typeof v === "object" && "error" in v;

function readYaml(file: string): Record<string, unknown> | null {
  let text: string;
  try {
    text = fs.readFileSync(file, "utf8");
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw e;
  }
  const doc = yaml.load(text);
  if (doc == null) return {};
  if (typeof doc !== "object" || Array.isArray(doc)) throw new Error(`${path.basename(file)} is not a map`);
  return doc as Record<string, unknown>;
}

const obj = (v: unknown): Record<string, unknown> =>
  v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : {};

async function schedule(): Promise<Schedule | null> {
  if (process.platform !== "win32") return null;
  try {
    const { stdout } = await promisify(execFile)("schtasks", ["/query", "/tn", "career-ops-alert", "/fo", "CSV", "/v"], {
      timeout: 5000,
      windowsHide: true,
    });
    return parseSchtasks(stdout);
  } catch {
    return null;
  }
}

/** Which Gmail variables are unset. Only names leave this function, never values. */
function gmailMissing(gmail: GmailModule): string[] {
  let file: Record<string, string> = {};
  try {
    file = parseEnv(fs.readFileSync(path.join(careerOpsRoot(), ".env"), "utf8")) as Record<string, string>;
  } catch {}
  return gmail.credentialsFrom({ ...file, ...process.env }).missing;
}

export async function homeData(): Promise<HomeData> {
  const code = careerOpsRoot();
  const root = userRoot();
  const [profiles, notify, lanesMod, personalization, gmail, task] = await Promise.all([
    profilesModule(),
    coreModule<NotifyModule>("notify-email"),
    coreModule<LanesModule>("lanes"),
    coreModule<PersonalizationModule>("personalization"),
    coreModule<GmailModule>("gmail-send"),
    schedule(),
  ]);
  const core = { ...lanesMod, ...personalization, isStubCv: profiles.isStubCv };
  const running = task && task.health !== "disabled";

  const card = (name: string | null, dir: string, pending: number): ProfileCard => {
    const profile = attempt(() => readYaml(path.join(dir, "config", "profile.yml")));
    const p = failed(profile) ? {} : obj(profile);
    const primary = obj(p.target_roles).primary;
    const roles = Array.isArray(primary) ? primary.filter((r) => typeof r === "string").slice(0, 2).join(" · ") : "";
    const fullName = obj(p.candidate).full_name;
    let digest = "Off";
    if (fs.existsSync(path.join(dir, "config", "alerts.yml"))) {
      const cfg = attempt(() => notify.loadConfig(dir));
      if (failed(cfg)) digest = "Unreadable";
      else if (cfg.enabled !== false && cfg.to.trim()) digest = running ? task.times.join(" · ") || "Scheduled" : "Not scheduled";
    }
    const setup = attempt(() => setupChecklist({ codeRoot: code, userRoot: dir, core }));
    return {
      name,
      label: name === null ? "Me (owner)" : typeof fullName === "string" && fullName.trim() ? fullName.trim() : name,
      roles,
      dir: name === null ? "./" : `profiles/${name}/`,
      pending,
      digest,
      setup: failed(setup) ? { ready: 0, total: 6 } : { ready: setup.ready, total: setup.total },
      active: name === activeProfile(),
    };
  };

  const cards = [
    card(null, code, profiles.pendingCount(code)),
    ...profiles.listProfiles().map((n) => {
      const d = profiles.describe(n);
      return card(n, d.dir, d.pending);
    }),
  ];

  const lanesFile = path.join(root, "config", "lanes.yml");
  const lanes = attempt(() => {
    if (!fs.existsSync(lanesFile)) return null;
    const list = lanesMod.loadLanes(lanesFile);
    const findings = laneFindings({ codeRoot: code, userRoot: root, lanes: list, check: lanesMod.checkLaneRegistration });
    const drift = driftedKeywords(findings) as Record<string, Record<string, "missing" | "blocked">>;
    const pending: Record<string, number> = {};
    for (const job of readInbox()) {
      if (job.done) continue;
      const id = lanesMod.laneForTitle(job.role, list)?.id;
      if (id) pending[id] = (pending[id] ?? 0) + 1;
    }
    const sites = ["config/profile.yml", "modes/_shared.md", "batch/batch-prompt.md", "modes/_profile.md"].map((site) => {
      const hits = findings.filter((f) => f.site === site);
      const errors = hits.filter((f) => f.severity === "error");
      return {
        site,
        ok: hits.length === 0,
        note: errors.length ? `${errors.length} archetype${errors.length === 1 ? "" : "s"} missing` : hits[0]?.message,
      };
    });
    return {
      list: list.map((l) => ({ ...l, pending: pending[l.id] ?? 0, drifted: drift[l.id] ?? {} })),
      sites,
    };
  });

  const alerts = attempt(() => ({
    ...notify.loadConfig(root),
    exists: fs.existsSync(path.join(root, "config", "alerts.yml")),
    lastRun: notify.loadState(root).lastRun,
  }));

  let tsv: string | null = null;
  try {
    tsv = fs.readFileSync(path.join(root, "data", "scan-runs.tsv"), "utf8");
  } catch {}

  return {
    profiles: cards,
    active: cards.find((c) => c.active) ?? cards[0],
    checklist: attempt(() => setupChecklist({ codeRoot: code, userRoot: root, core })),
    schedule: task,
    gmailMissing: gmailMissing(gmail),
    alerts,
    filters: attempt(() => readYaml(path.join(root, "portals.yml"))),
    funnel: scanFunnel(tsv),
    lanes,
    prefs: attempt(() => readYaml(path.join(root, "config", "profile.yml"))),
    checkedAt: new Date().toISOString(),
  };
}
