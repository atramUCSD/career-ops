import fs from "node:fs";
import path from "node:path";
import { findApplication, readReport, userRoot } from "@/lib/career-ops";
import { trackerRowArg } from "@/lib/status-cli.mjs";
import { readJsonObject } from "@/lib/json-body";
import { withTrackerLock, TrackerBusyError } from "@/lib/core/tracker-lock";
import { resolveTrackerPath } from "@/lib/core/tracker-files.mjs";
import {
  buildTimeline,
  expiredOn,
  parseReportMeta,
  parseStatusLog,
  scanSighting,
  type BoardEvent,
} from "@/lib/board-activity.mjs";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// Card detail for the /board panel (GET) and the board's own activity log
// (POST). The log is append-only JSONL beside the tracker; the tracker stays
// the source of truth for status, this file only remembers what the board saw.

const dataFile = (name: string) => path.join(userRoot(), "data", name);
const readIf = (name: string) => {
  try {
    return fs.readFileSync(dataFile(name), "utf8");
  } catch {
    return "";
  }
};

function boardEvents(n: string): BoardEvent[] {
  const out: BoardEvent[] = [];
  for (const line of readIf("board-activity.jsonl").split("\n")) {
    if (!line.trim()) continue;
    try {
      const e = JSON.parse(line) as BoardEvent;
      if (e.n === n) out.push(e);
    } catch {
      // a torn final line from a crash mid-append; the rest of the log is fine
    }
  }
  return out;
}

export async function GET(_req: Request, { params }: { params: Promise<{ n: string }> }) {
  const n = trackerRowArg((await params).n);
  const app = n ? findApplication(n) : null;
  if (!n || !app) return Response.json({ error: "no such tracker row" }, { status: 404 });
  const meta = parseReportMeta(readReport(n)?.content ?? "");
  const url = meta.header.URL ?? "";
  const timeline = buildTimeline({
    app,
    ledger: parseStatusLog(readIf("status-log.tsv"), n),
    sighting: scanSighting(readIf("scan-history.tsv"), url),
    expired: expiredOn(readIf("expired-jobs.md"), url),
    events: boardEvents(n),
  });
  return Response.json({ app, meta, timeline });
}

const OPEN_DEDUPE_MS = 30 * 60_000;

export async function POST(req: Request, { params }: { params: Promise<{ n: string }> }) {
  const n = trackerRowArg((await params).n);
  if (!n || !findApplication(n)) return Response.json({ error: "no such tracker row" }, { status: 404 });
  const body = await readJsonObject<{ kind?: string; text?: unknown; from?: unknown; to?: unknown }>(req);
  if (!body) return Response.json({ error: "bad json" }, { status: 400 });
  const at = new Date().toISOString();
  const short = (v: unknown) => String(v ?? "").slice(0, 40);
  let event: BoardEvent;
  if (body.kind === "comment") {
    const text = String(body.text ?? "").trim().slice(0, 2000);
    if (!text) return Response.json({ error: "comment text required" }, { status: 400 });
    event = { at, n, kind: "comment", text };
  } else if (body.kind === "move") {
    if (!body.to) return Response.json({ error: "move needs to" }, { status: 400 });
    event = { at, n, kind: "move", from: short(body.from), to: short(body.to) };
  } else if (body.kind === "open") {
    // Reopening the same card while comparing two postings is one look, not five.
    const last = boardEvents(n).at(-1);
    if (last?.kind === "open" && Date.now() - Date.parse(last.at) < OPEN_DEDUPE_MS) return Response.json({ ok: true });
    event = { at, n, kind: "open" };
  } else {
    return Response.json({ error: "kind must be comment, move or open" }, { status: 400 });
  }
  // The cloud inbox runner appends here too (remote comments), so both doors
  // take the tracker lock: two unserialized appends can interleave a line.
  try {
    await withTrackerLock(resolveTrackerPath(userRoot()), () =>
      fs.appendFileSync(dataFile("board-activity.jsonl"), JSON.stringify(event) + "\n"),
    );
  } catch (e) {
    if (e instanceof TrackerBusyError) return Response.json({ error: e.message }, { status: 409 });
    throw e;
  }
  return Response.json({ ok: true, event });
}
