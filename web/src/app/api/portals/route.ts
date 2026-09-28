import path from "node:path";
import { careerOpsRoot, userRoot } from "@/lib/career-ops";
import { atomicWriteWithBackup } from "@/lib/core/safe-write";
import { portalsPatch } from "@/lib/portals-config.mjs";
import { configErrorResponse, loadYamlDoc, setIn, toYaml } from "@/lib/yaml-doc.mjs";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// Writes the scan filters in portals.yml (a USER-LAYER file): the assistant's
// confirm-gated onboarding roles, and the Home page's filter editor. Only the
// named settings change; tracked_companies, every other block and the user's
// comments stay as written. Seeds from templates/portals.example.yml on first
// create.

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
  const result = portalsPatch(body as Record<string, unknown>);
  if ("error" in result) return Response.json({ error: result.error }, { status: 400 });

  // User file from the active profile, shipped example from the code root.
  const file = path.join(userRoot(), "portals.yml");
  try {
    const { doc, src, seeded } = loadYamlDoc(file, path.join(careerOpsRoot(), "templates", "portals.example.yml"));
    setIn(doc, [], result.patch);
    atomicWriteWithBackup(file, toYaml(doc, src));
    return Response.json({ ok: true, seeded });
  } catch (error) {
    return configErrorResponse(error);
  }
}
