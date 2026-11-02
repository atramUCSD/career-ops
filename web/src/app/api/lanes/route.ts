import path from "node:path";
import { careerOpsRoot, userRoot } from "@/lib/career-ops";
import { atomicWriteWithBackup } from "@/lib/core/safe-write";
import { withFileLock } from "@/lib/core/file-lock";
import { laneEdits, laneKeywords } from "@/lib/lanes-config.mjs";
import { configErrorResponse, loadYamlDoc, setIn, toYaml } from "@/lib/yaml-doc.mjs";
import { readJsonObject } from "@/lib/json-body";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// Home's lane editor: rewrites title_keywords for the named lanes in
// config/lanes.yml and nothing else. Lanes are added by hand, so a missing
// file is an error here rather than a copy of the example's lanes.

export async function POST(req: Request) {
  const body = await readJsonObject<Record<string, unknown>>(req);
  if (!body) return Response.json({ error: "bad json" }, { status: 400 });
  const checked = laneKeywords(body.lanes);
  if ("error" in checked) return Response.json({ error: checked.error }, { status: 400 });

  const file = path.join(userRoot(), "config", "lanes.yml");
  try {
    return await withFileLock(file, () => {
      const { doc, src, seeded } = loadYamlDoc(file, path.join(careerOpsRoot(), "config", "lanes.example.yml"), "config/lanes.yml");
      if (seeded) return Response.json({ error: "config/lanes.yml does not exist" }, { status: 404 });
      const planned = laneEdits(doc.toJS(), checked.keywords);
      if ("error" in planned) return Response.json({ error: planned.error }, { status: 404 });
      for (const [keys, list] of planned.edits) setIn(doc, keys, list);
      atomicWriteWithBackup(file, toYaml(doc, src));
      return Response.json({ ok: true });
    });
  } catch (error) {
    return configErrorResponse(error);
  }
}
