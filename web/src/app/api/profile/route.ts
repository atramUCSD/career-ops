import path from "node:path";
import { careerOpsRoot, userRoot } from "@/lib/career-ops";
import { atomicWriteWithBackup } from "@/lib/core/safe-write";
import { withFileLock } from "@/lib/core/file-lock";
import { configErrorResponse, loadYamlDoc, setIn, toYaml } from "@/lib/yaml-doc.mjs";
import { getProfilePath } from "@/lib/core/profile-path.mjs";
import { profileEdits, profilePatchError } from "@/lib/profile-patch.mjs";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// Merge-safe writer for config/profile.yml (a USER-LAYER file — DATA_CONTRACT:
// never clobber the user's archetypes/narrative/proof-points). Only the fields
// in the patch change, and the user's comments stay; a missing file is seeded
// from config/profile.example.yml. Callers: the assistant's confirm-gated
// setProfile, and the Home page's preferences.

export async function POST(req: Request) {
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return Response.json({ error: "bad json" }, { status: 400 });
  }
  // Type and range checks first; profileEdits then validates language, spendTier
  // and text lengths.
  const invalid = profilePatchError(body);
  if (invalid) return Response.json({ error: invalid }, { status: 400 });
  const edits = profileEdits(body as Record<string, unknown>);
  if (typeof edits === "string") return Response.json({ error: edits }, { status: 400 });
  if (edits.length === 0) return Response.json({ error: "nothing to write" }, { status: 400 });

  const file = getProfilePath(userRoot());
  try {
    return await withFileLock(file, () => {
      const template = path.join(careerOpsRoot(), "config", "profile.example.yml");
      const { doc, src, seeded } = loadYamlDoc(file, template, "config/profile.yml");
      for (const [keys, value] of edits) setIn(doc, keys, value);
      atomicWriteWithBackup(file, toYaml(doc, src));
      return Response.json({ ok: true, seeded });
    });
  } catch (error) {
    return configErrorResponse(error);
  }
}
