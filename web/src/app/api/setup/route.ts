import { execFile } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { careerOpsRoot, codeFile, portalsConfigPath, rootScript, spawnEnv, userRoot } from "@/lib/career-ops";
import { resolveCodeRoot } from "@/lib/core/code-root.mjs";
import { withFileLock } from "@/lib/core/file-lock";
import { getProfilePath } from "@/lib/core/profile-path.mjs";
import { atomicWrite, atomicWriteWithBackup } from "@/lib/core/safe-write";
import { readJsonObject } from "@/lib/json-body";
import { readPersonalizationState, savePersonalization, UnsureProfileParseError } from "@/lib/personalization-file.mjs";
import { watchedCompanies } from "@/lib/portals-config.mjs";
import { profilePath } from "@/lib/profile-memory.mjs";
import { profileValues } from "@/lib/profile-patch.mjs";
import { changes, checkDraft, targets, yamlEdits } from "@/lib/setup-draft.mjs";
import { ConfigError, configErrorResponse, loadYamlDoc, setIn, toYaml } from "@/lib/yaml-doc.mjs";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// The setup wizard's backend. GET reads what each file already says; POST
// {draft} saves the draft to data/setup-draft.json and returns what applying
// it would change; POST ?apply=1 writes it through the same libraries the Home
// editors use, in process, one file at a time under that file's lock. The
// first failure stops the run and reports which files already landed. Company
// adds run discover-ats.mjs --write last, outside every lock (it takes the
// portals.yml lock itself, and the lock is not reentrant).

type YamlTarget = "portals" | "alerts" | "profile" | "lanes";
type Checked = Record<string, any>;

const codeRoot = () => resolveCodeRoot(process.cwd(), process.env);
const message = (e: unknown) => (e instanceof Error ? e.message : String(e));
const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);
const draftFile = () => path.join(userRoot(), "data", "setup-draft.json");

async function corePersonalization() {
  return import(/* webpackIgnore: true */ pathToFileURL(rootScript("lib/personalization")).href);
}

/** A file's text, or null when it does not exist. Any other read failure throws. */
function readText(file: string): string | null {
  try {
    return fs.readFileSync(file, "utf8");
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw e;
  }
}

function yamlFile(target: YamlTarget): [file: string, template: string, label: string] {
  const root = userRoot();
  switch (target) {
    case "portals":
      return [portalsConfigPath(root), codeFile("templates", "portals.example.yml"), "portals.yml"];
    case "alerts":
      return [path.join(root, "config", "alerts.yml"), path.join(careerOpsRoot(), "config", "alerts.example.yml"), "config/alerts.yml"];
    case "profile":
      return [getProfilePath(root), path.join(careerOpsRoot(), "config", "profile.example.yml"), "config/profile.yml"];
    case "lanes":
      return [path.join(root, "config", "lanes.yml"), path.join(careerOpsRoot(), "config", "lanes.example.yml"), "config/lanes.yml"];
  }
}

function loadYaml(target: YamlTarget) {
  const [file, template, label] = yamlFile(target);
  const loaded = loadYamlDoc(file, template, label);
  const js = loaded.doc.toJS();
  return { ...loaded, file, js: (isObj(js) ? js : {}) as Record<string, unknown> };
}

/** The edits the draft makes to one YAML file, planned against its current text. */
function planYaml(target: YamlTarget, checked: Checked) {
  const loaded = loadYaml(target);
  // Lanes are added by hand: seeding the example's lanes would invent targeting.
  if (target === "lanes" && loaded.seeded) throw new ConfigError("config/lanes.yml does not exist", "invalid-user-config");
  const planned = yamlEdits(target, checked, loaded.js, loaded.seeded);
  if ("error" in planned) throw new ConfigError(planned.error, "invalid-user-config");
  return { ...loaded, changes: changes(planned.edits, loaded.js) };
}

type Core = Awaited<ReturnType<typeof corePersonalization>>;

function planPersonalization(patch: Record<string, unknown>, core: Core) {
  const current = readText(profilePath(userRoot()));
  const { ids, merged } = savePersonalization({ dataRoot: userRoot(), codeRoot: codeRoot(), patch, dryRun: true, write: atomicWriteWithBackup, core });
  return { ids, merged, changed: merged !== current, seeded: current === null };
}

async function diff(checked: Checked) {
  const out: Record<string, unknown> = {};
  for (const target of targets(checked)) {
    try {
      if (target === "personalization") {
        const p = planPersonalization(checked.personalization, await corePersonalization());
        out[target] = { sections: p.ids, changed: p.changed, seeded: p.seeded };
      } else {
        const p = planYaml(target as YamlTarget, checked);
        out[target] = { seeded: p.seeded, changes: p.changes };
      }
    } catch (e) {
      out[target] = { error: message(e) };
    }
  }
  if (checked.companies?.add.length) out.companiesAdd = checked.companies.add;
  return out;
}

/** Write one target under its lock, re-planned inside it. False when nothing changed. */
async function applyTarget(target: string, checked: Checked): Promise<boolean> {
  if (target === "personalization") {
    const core = await corePersonalization();
    const file = profilePath(userRoot());
    return withFileLock(file, () => {
      const p = planPersonalization(checked.personalization, core);
      if (!p.changed) return false;
      atomicWriteWithBackup(file, p.merged);
      return true;
    });
  }
  const [file] = yamlFile(target as YamlTarget);
  return withFileLock(file, () => {
    const p = planYaml(target as YamlTarget, checked);
    // An unchanged file is not rewritten, so a re-run leaves no .bak behind.
    if (!p.changes.length) return false;
    for (const c of p.changes) setIn(p.doc, c.path, c.after);
    atomicWriteWithBackup(file, toYaml(p.doc, p.src));
    return true;
  });
}

const lastLine = (s: string) => s.trim().split(/\r?\n/).pop()?.trim() ?? "";

async function addCompanies(names: string[]): Promise<Record<string, unknown>> {
  const env = await spawnEnv();
  return new Promise((resolve) => {
    execFile(
      process.execPath,
      [rootScript("discover-ats"), ...names, "--write"],
      { cwd: careerOpsRoot(), env, timeout: 120_000, maxBuffer: 8 * 1024 * 1024, windowsHide: true },
      (error, stdout, stderr) => {
        if (error) {
          return resolve({ error: error.killed ? "discover-ats timed out after 120 seconds" : lastLine(stderr) || error.message });
        }
        try {
          const r = JSON.parse(stdout);
          resolve({
            written: r.metadata?.written === true,
            resolved: r.resolved ?? [],
            unresolved: r.unresolved ?? [],
            blacklisted: r.blacklisted ?? [],
            warnings: r.metadata?.warnings ?? [],
          });
        } catch {
          resolve({ error: "discover-ats did not print its JSON result" });
        }
      },
    );
  });
}

// A section that cannot be read is reported on its own; the others still load.
async function section(fn: () => unknown): Promise<unknown> {
  try {
    return await fn();
  } catch (e) {
    return { error: message(e) };
  }
}

const ALERT_KEYS = ["enabled", "to", "min_match", "max_rows", "quiet_if_empty", "calendar"];

export async function GET() {
  return Response.json({
    profile: await section(() => {
      const { js, seeded } = loadYaml("profile");
      return { value: profileValues(js), seeded };
    }),
    personalization: await section(async () => {
      const state = readPersonalizationState(userRoot(), codeRoot(), await corePersonalization());
      return { value: state.sections, seeded: !state.exists };
    }),
    portals: await section(() => {
      const { js, seeded } = loadYaml("portals");
      const { title_filter, location_filter, salary_filter, max_posting_age_days } = js;
      return { value: { title_filter, location_filter, salary_filter, max_posting_age_days, companies: watchedCompanies(js) }, seeded };
    }),
    lanes: await section(() => {
      const { js, seeded } = loadYaml("lanes");
      if (seeded) return { value: null, seeded };
      const lanes = Array.isArray(js.lanes) ? js.lanes.filter(isObj) : [];
      return { value: lanes.map((l) => ({ id: l.id, archetype: l.archetype, title_keywords: l.title_keywords })), seeded };
    }),
    // A whitelist: the file can also hold the artifact URL and other settings
    // that are not the wizard's to show.
    alerts: await section(() => {
      const { js, seeded } = loadYaml("alerts");
      const src = isObj(js.alerts) ? js.alerts : js;
      return { value: Object.fromEntries(ALERT_KEYS.filter((k) => k in src).map((k) => [k, src[k]])), seeded };
    }),
    draft: await section(() => {
      const text = readText(draftFile());
      if (text === null) return { value: null };
      try {
        return { value: JSON.parse(text) };
      } catch {
        throw new Error("data/setup-draft.json is not valid JSON");
      }
    }),
  });
}

export async function POST(req: Request) {
  const body = await readJsonObject<Record<string, unknown>>(req);
  if (!body) return Response.json({ error: "bad json" }, { status: 400 });
  const result = checkDraft(body.draft);
  if ("error" in result) return Response.json({ error: result.error }, { status: 400 });
  const { checked } = result as { checked: Checked };
  const file = draftFile();

  if (new URL(req.url).searchParams.get("apply") !== "1") {
    try {
      fs.mkdirSync(path.dirname(file), { recursive: true });
      await withFileLock(file, () => atomicWrite(file, `${JSON.stringify(body.draft, null, 2)}\n`));
    } catch (e) {
      return configErrorResponse(e);
    }
    return Response.json({ ok: true, diff: await diff(checked) });
  }

  const landed: string[] = [];
  for (const target of targets(checked)) {
    try {
      if (await applyTarget(target, checked)) landed.push(target);
    } catch (e) {
      const status = e instanceof UnsureProfileParseError ? 409 : configErrorResponse(e).status;
      return Response.json({ ok: false, landed, failed: { target, error: message(e) } }, { status });
    }
  }
  // A failed lookup is a warning on a run whose files already landed, not a failure.
  const added = checked.companies?.add.length ? await addCompanies(checked.companies.add) : undefined;
  let draftKept: string | undefined;
  // Applying an unsaved draft leaves nothing to remove, and data/ may not exist to hold a lock.
  if (fs.existsSync(file)) {
    try {
      await withFileLock(file, () => fs.rmSync(file, { force: true }));
    } catch (e) {
      draftKept = message(e);
    }
  }
  return Response.json({ ok: true, landed, added, draftKept });
}
