import { NextResponse } from "next/server";
import fs from "node:fs";
import path from "node:path";
import { userRoot } from "@/lib/career-ops";
import { atomicWriteWithBackup } from "@/lib/core/safe-write";
import { withFileLock, FileBusyError } from "@/lib/core/file-lock";
import { readJsonObject } from "@/lib/json-body";

function cvPath() {
  return path.join(userRoot(), "cv.md");
}

const MAX_CV_BYTES = 200_000;

export async function GET() {
  try {
    return NextResponse.json({ content: fs.readFileSync(cvPath(), "utf8"), exists: true });
  } catch {
    return NextResponse.json({ content: "", exists: false });
  }
}

export async function POST(req: Request) {
  const body = await readJsonObject<{ content?: string }>(req);
  if (!body) return NextResponse.json({ error: "bad json" }, { status: 400 });
  if (typeof body.content !== "string") {
    return NextResponse.json({ error: "content required" }, { status: 400 });
  }
  if (Buffer.byteLength(body.content, "utf8") > MAX_CV_BYTES) {
    return NextResponse.json({ error: "CV is too large (over 200KB)" }, { status: 413 });
  }
  // DATA_CONTRACT: cv.md is user-layer and gitignored (no git recovery). Never
  // blind-overwrite — snapshot the prior CV to a .bak first, write atomically.
  try {
    const bak = await withFileLock(cvPath(), () => atomicWriteWithBackup(cvPath(), body.content as string));
    return NextResponse.json({ ok: true, backedUp: !!bak });
  } catch (error) {
    if (error instanceof FileBusyError) return NextResponse.json({ error: error.message }, { status: 409 });
    return NextResponse.json({ error: "write failed" }, { status: 500 });
  }
}
