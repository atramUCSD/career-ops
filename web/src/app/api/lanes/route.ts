import path from "node:path";
import { careerOpsRoot, userRoot } from "@/lib/career-ops";
import { atomicWriteWithBackup } from "@/lib/core/safe-write";
import { words } from "@/lib/portals-config.mjs";
import { configErrorResponse, loadYamlDoc, setIn, toYaml } from "@/lib/yaml-doc.mjs";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// Home's lane editor: rewrites title_keywords for the named lanes in
// config/lanes.yml and nothing else. Lanes are added by hand, so a missing
// file is an error here rather than a copy of the example's lanes.

export async function POST(req: Request) {
  let body: Record<string, unknown>;
  try {
    body = await req.json();
  } catch {
    return Response.json({ error: "bad json" }, { status: 400 });
  }
  const edits = body?.lanes;
  if (!edits || typeof edits !== "object" || Array.isArray(edits) || !Object.keys(edits).length) {
    return Response.json({ error: "lanes must name at least one lane" }, { status: 400 });
  }
  const keywords: Record<string, string[]> = {};
  for (const [id, value] of Object.entries(edits)) {
    const list = words(value);
    // lanes.mjs loadLanes refuses a lane with no title keyword.
    if (!list?.length) return Response.json({ error: `lane "${id}" needs at least one title keyword` }, { status: 400 });
    if (list.length > 40 || list.some((k: string) => k.length > 120)) {
      return Response.json({ error: `lane "${id}" allows 40 keywords of at most 120 characters` }, { status: 400 });
    }
    keywords[id] = list;
  }

  const file = path.join(userRoot(), "config", "lanes.yml");
  try {
    const { doc, src, seeded } = loadYamlDoc(file, path.join(careerOpsRoot(), "config", "lanes.example.yml"), "config/lanes.yml");
    if (seeded) return Response.json({ error: "config/lanes.yml does not exist" }, { status: 404 });
    const lanes = doc.toJS().lanes;
    for (const [id, list] of Object.entries(keywords)) {
      const i = Array.isArray(lanes) ? lanes.findIndex((l) => l?.id === id) : -1;
      if (i < 0) return Response.json({ error: `no lane "${id}" in config/lanes.yml` }, { status: 404 });
      setIn(doc, ["lanes", i, "title_keywords"], list);
    }
    atomicWriteWithBackup(file, toYaml(doc, src));
    return Response.json({ ok: true });
  } catch (error) {
    return configErrorResponse(error);
  }
}
