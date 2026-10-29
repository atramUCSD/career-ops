import path from "node:path";
import { userRoot } from "@/lib/career-ops";
import { atomicWrite } from "@/lib/core/safe-write";
import { FileBusyError, withFileLock } from "@/lib/core/file-lock";
import { normalizeShortlist, readShortlist, readUiState } from "@/lib/ui-state.mjs";
import { readJsonObject } from "@/lib/json-body";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// The inbox shortlist, kept in data/ui-state.json instead of one browser's storage.
// PUT replaces the whole list: a single person triages, so the last tab to save wins.

const file = () => path.join(userRoot(), "data", "ui-state.json");

export async function GET() {
  return Response.json({ shortlist: readShortlist(file()) });
}

export async function PUT(req: Request) {
  const body = await readJsonObject<{ shortlist?: unknown }>(req);
  if (!body || !Array.isArray(body.shortlist)) return Response.json({ error: "shortlist must be an array" }, { status: 400 });
  const shortlist = normalizeShortlist(body.shortlist);
  try {
    return await withFileLock(file(), () => {
      atomicWrite(file(), JSON.stringify({ ...readUiState(file()), shortlist }, null, 2) + "\n");
      return Response.json({ shortlist });
    });
  } catch (error) {
    if (error instanceof FileBusyError) return Response.json({ error: error.message }, { status: 409, headers: { "Retry-After": "2" } });
    return Response.json({ error: "write failed" }, { status: 500 });
  }
}
