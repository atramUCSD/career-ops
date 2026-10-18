import { execFile } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import * as yaml from "js-yaml";
import { careerOpsRoot, rootScript, spawnEnv, userRoot } from "@/lib/career-ops";
import { atomicWriteWithBackup } from "@/lib/core/safe-write";
import { getProfilePath } from "@/lib/core/profile-path.mjs";
import { PROFILE_CADENCE_KEYS, type ProfileCadenceKey } from "@/lib/followups";
import { configErrorResponse, loadYamlDoc, setIn, toYaml } from "@/lib/yaml-doc.mjs";
import { readJsonObject } from "@/lib/json-body";
import { followupsEnabledFromProfile } from "@/lib/followups-setting.mjs";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// The follow-up cadence knobs live in config/profile.yml → followup_cadence
// (a USER-LAYER file) — the SAME keys the core followup-cadence.mjs reads, so
// tuning them here changes the CLI's verdict too. Reads are live; writes go
// through yaml-doc like /api/profile, so the rest of the profile, comments
// included, is left as written.

function isObj(v: unknown): v is Record<string, unknown> {
  return !!v && typeof v === "object" && !Array.isArray(v);
}

/**
 * PURE defaults, read from the core rather than copied (#2369).
 *
 * `followup-cadence.mjs --json` emits `cadenceDefaults` (DEFAULT_CADENCE) next
 * to `cadenceConfig` (defaults + the user's profile overrides). The form needs
 * the PURE defaults for its placeholders: sourcing them from `cadenceConfig`
 * would render a user's own override as the default they'd be reverting to.
 *
 * Core keys carry no `_days` suffix (`applied_first`); the profile/web keys do
 * (`applied_first_days`), except `applied_max_followups`. That mapping is the
 * only translation here — no values are restated.
 *
 * Returns null when the core is missing or unparseable. Deliberately NOT a
 * hardcoded fallback table: a fallback copy is the same copy in disguise, and
 * that is exactly how states.ts's FALLBACK drifted (#2282).
 */
async function readCoreDefaults(): Promise<Partial<Record<ProfileCadenceKey, number>> | null> {
  const script = rootScript("followup-cadence");
  if (!fs.existsSync(script)) return null;
  const env = await spawnEnv();
  const stdout = await new Promise<string>((resolve) => {
    // process.execPath + windowsHide: see api/doctor/route.ts — a stale inherited
    // console kills every child with 0xC0000142 on Windows; never inherit one.
    execFile(process.execPath, [script, "--json"], { cwd: careerOpsRoot(), env, timeout: 12_000, windowsHide: true }, (_e, out) =>
      resolve(out || ""),
    );
  });
  try {
    const start = stdout.indexOf("{");
    if (start === -1) return null;
    const parsed = JSON.parse(stdout.slice(start)) as { cadenceDefaults?: unknown };
    if (!isObj(parsed.cadenceDefaults)) return null;
    const core = parsed.cadenceDefaults;
    // ALL-OR-NOTHING, and no coercion. Number.parseInt would accept "3.5" as 3
    // and "7days" as 7, and a per-key filter would report defaultsAvailable:
    // true off a single valid key — either way the form would show a baseline
    // the core never emitted. A partial or coerced contract is exactly the
    // silent-wrong-value this whole derivation exists to remove, so a
    // malformed payload degrades to "no defaults" instead.
    const out: Partial<Record<ProfileCadenceKey, number>> = {};
    for (const key of PROFILE_CADENCE_KEYS) {
      const coreKey = key === "applied_max_followups" ? key : key.replace(/_days$/, "");
      const raw = core[coreKey];
      if (typeof raw !== "number" || !Number.isInteger(raw) || raw < 0) return null;
      out[key] = raw;
    }
    return out;
  } catch {
    return null;
  }
}

export async function GET() {
  const file = getProfilePath(userRoot());
  const overrides: Partial<Record<ProfileCadenceKey, number>> = {};
  let enabled = true;
  if (fs.existsSync(file)) {
    let profile: Record<string, unknown> = {};
    try {
      const parsed = yaml.load(fs.readFileSync(file, "utf8"));
      profile = isObj(parsed) ? parsed : {};
    } catch {
      /* unreadable/malformed → show defaults (read is best-effort) */
    }
    enabled = followupsEnabledFromProfile(profile);
    const source = isObj(profile.followup_cadence) ? profile.followup_cadence : {};
    for (const key of PROFILE_CADENCE_KEYS) {
      const n = Number.parseInt(String(source[key]), 10);
      if (Number.isFinite(n) && n >= 0) overrides[key] = n;
    }
  }
  const defaults = await readCoreDefaults();
  // `defaultsAvailable: false` tells the form to render its placeholders as
  // unknown rather than inventing a number — an honest gap beats a stale copy.
  const effective = { ...(defaults ?? {}), ...overrides };
  return Response.json({ defaults: defaults ?? {}, defaultsAvailable: defaults !== null, overrides, effective, enabled });
}

export async function POST(req: Request) {
  const body = await readJsonObject<Record<string, unknown>>(req);
  if (!body) return Response.json({ error: "bad json" }, { status: 400 });

  const cadence: Record<string, number> = {};
  for (const key of PROFILE_CADENCE_KEYS) {
    if (body[key] == null) continue;
    const n = Number.parseInt(String(body[key]), 10);
    if (!Number.isInteger(n) || n < 0) {
      return Response.json({ error: `${key} must be a non-negative integer` }, { status: 400 });
    }
    cadence[key] = n;
  }
  if (body.enabled !== undefined && typeof body.enabled !== "boolean") {
    return Response.json({ error: "enabled must be true or false" }, { status: 400 });
  }
  const enabled = body.enabled as boolean | undefined;
  if (Object.keys(cadence).length === 0 && enabled === undefined) {
    return Response.json({ error: "nothing to write" }, { status: 400 });
  }

  const file = getProfilePath(userRoot());
  try {
    // First create seeds from the example, so a profile is never cadence-only.
    const template = path.join(careerOpsRoot(), "config", "profile.example.yml");
    const { doc, src } = loadYamlDoc(file, template, "config/profile.yml");
    setIn(doc, ["followup_cadence"], cadence);
    if (enabled !== undefined) setIn(doc, ["follow_ups", "enabled"], enabled);
    atomicWriteWithBackup(file, toYaml(doc, src));
    const saved = doc.toJS();
    return Response.json({ ok: true, followup_cadence: saved.followup_cadence, follow_ups: saved.follow_ups });
  } catch (error) {
    return configErrorResponse(error);
  }
}
