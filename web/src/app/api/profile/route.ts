import path from "node:path";
import { careerOpsRoot, userRoot } from "@/lib/career-ops";
import { atomicWriteWithBackup } from "@/lib/core/safe-write";
import { configErrorResponse, loadYamlDoc, setIn, toYaml } from "@/lib/yaml-doc.mjs";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// Merge-safe writer for config/profile.yml (a USER-LAYER file — DATA_CONTRACT:
// never clobber the user's archetypes/narrative/proof-points). Only the fields
// in the patch change, and the user's comments stay; a missing file is seeded
// from config/profile.example.yml. Callers: the assistant's confirm-gated
// setProfile, and the Home page's preferences.

const TEXT: Record<string, string[]> = {
  name: ["candidate", "full_name"],
  email: ["candidate", "email"],
  location: ["candidate", "location"],
  currency: ["compensation", "currency"],
  remote: ["compensation", "location_flexibility"],
  targetRange: ["compensation", "target_range"],
  walkAway: ["compensation", "minimum"],
};
const SPEND_TIERS = new Set(["economy", "standard", "premium"]);

type Edit = [string[], unknown];

/** The patch as path edits, or an error message. Empty text is skipped, not cleared. */
function profileEdits(p: Record<string, unknown>): Edit[] | string {
  const edits: Edit[] = [];
  for (const [field, keys] of Object.entries(TEXT)) {
    const v = p[field];
    if (v == null) continue;
    if (typeof v !== "string" || v.length > 200) return `${field} must be text of at most 200 characters`;
    if (v.trim()) edits.push([keys, v.trim()]);
  }
  if (p.roles !== undefined) {
    if (!Array.isArray(p.roles) || p.roles.some((r) => typeof r !== "string")) return "roles must be a list of text";
    const roles = (p.roles as string[]).map((r) => r.trim()).filter(Boolean).slice(0, 24);
    if (roles.length) edits.push([["target_roles", "primary"], roles]);
  }
  // The assistant's shape: a numeric range the user stated.
  const { compMin, compMax } = p;
  if (typeof compMin === "number" && typeof compMax === "number" && compMin > 0 && compMax > 0) {
    edits.push([["compensation", "target_range"], `${compMin}-${compMax}`]);
  }
  if (p.language !== undefined) {
    if (typeof p.language !== "string" || !/^[a-z]{2,3}(-[A-Za-z0-9]{2,8})*$/.test(p.language)) {
      return "language must be a language code such as en or pt-BR";
    }
    edits.push([["language", "output"], p.language]);
  }
  if (p.spendTier !== undefined) {
    if (typeof p.spendTier !== "string" || !SPEND_TIERS.has(p.spendTier)) {
      return "spendTier must be economy, standard or premium";
    }
    edits.push([["spend_tier"], p.spendTier]);
  }
  // seniority intentionally not written (no canonical home in profile.yml);
  // archetypes/narrative live in modes/_profile.md — this writer never touches them.
  return edits;
}

export async function POST(req: Request) {
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return Response.json({ error: "bad json" }, { status: 400 });
  }
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    return Response.json({ error: "expected an object" }, { status: 400 });
  }
  const edits = profileEdits(body as Record<string, unknown>);
  if (typeof edits === "string") return Response.json({ error: edits }, { status: 400 });
  if (edits.length === 0) return Response.json({ error: "nothing to write" }, { status: 400 });

  const file = path.join(userRoot(), "config", "profile.yml");
  try {
    const template = path.join(careerOpsRoot(), "config", "profile.example.yml");
    const { doc, src, seeded } = loadYamlDoc(file, template, "config/profile.yml");
    for (const [keys, value] of edits) setIn(doc, keys, value);
    atomicWriteWithBackup(file, toYaml(doc, src));
    return Response.json({ ok: true, seeded });
  } catch (error) {
    return configErrorResponse(error);
  }
}
