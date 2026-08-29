// POST /api/prepare — bulk-prepare dispatch: one NDJSON progress stream for a
// shortlist of posting URLs. Each application gets a headless tailor worker,
// a backend PDF render, and a `prepared: awaiting review` Notes marker stamped
// through set-status.mjs — the Status cell stays the canonical `Evaluated`.
//
// NOTHING here submits anything anywhere. This route produces artifacts and a
// review-queue marker behind the per-application human gate; approval is a
// separate route (/api/prepare/approve) and submission stays entirely manual.
//
// The orchestration lives in prepare-fanout.mjs (dependency-injected, tested);
// this file is the HTTP contract + stream transport, mirroring /api/run. The
// worker argv comes ONLY from claudeCliArgs inside the lib — no tool flag is
// spelled here (test-all §55.6).
//
// Claude-only, deliberately: the tailor kind's Write-only grant (Bash and Edit
// denied by name) is enforced by claude-invocation.mjs scopes, which no other
// CLI honors (#2507) — a batch of up to ten unrestricted agents is a different
// risk than /api/run's single mitigated worker, so other CLIs are refused
// rather than mitigated here.
import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { resolveCli } from "@/lib/clis";
import { spawnHeadlessCli } from "@/lib/spawn-cli.mjs";
import { careerOpsRoot, readApplications, readInbox, rootScript } from "@/lib/career-ops";
import { canonicalizeStatus } from "@/lib/core/states";
import { atomicWrite } from "@/lib/core/safe-write";
import { acquireTrackerWrite, releaseTrackerWrite } from "@/lib/core/run-registry";
import { runPrepareBatch, MAX_PREPARE_BATCH } from "@/lib/prepare-fanout.mjs";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
// Shared SEQUENTIALLY across the batch's tailor workers — see perWorkerKillMs.
// The per-item render/stamp children run on top of that 780s worker budget, so
// a full batch can exceed 800s; fine locally, where self-hosted Next does not
// enforce maxDuration (perWorkerKillMs's ponytail note has the upgrade path).
export const maxDuration = 800;

const json = (obj: unknown, status: number) =>
  new Response(JSON.stringify(obj), { status, headers: { "Content-Type": "application/json" } });

export async function POST(req: Request) {
  let body: { urls?: unknown; cliId?: unknown };
  try {
    body = await req.json();
  } catch {
    return json({ error: "bad json" }, 400);
  }
  const { urls, cliId } = body;
  if (!Array.isArray(urls) || urls.length === 0 || !urls.every((u) => typeof u === "string" && u.trim())) {
    return json({ error: "urls (non-empty string array) and cliId required" }, 400);
  }
  if (typeof cliId !== "string" || !cliId) {
    return json({ error: "urls (non-empty string array) and cliId required" }, 400);
  }
  if (urls.length > MAX_PREPARE_BATCH) {
    return json({ error: `At most ${MAX_PREPARE_BATCH} applications per batch — the route's time budget is shared across sequential workers.` }, 400);
  }
  const resolved = resolveCli(cliId);
  if (!resolved) {
    return json({ error: `CLI '${cliId}' not found` }, 404);
  }
  if (cliId !== "claude") {
    return json({ error: "Bulk prepare runs on Claude Code only — its tool scopes are what keep ten headless workers write-restricted." }, 400);
  }
  // Tailoring is meaningless without a CV to tailor — same guard as /api/run's pdf kind.
  if (!fs.existsSync(path.join(careerOpsRoot(), "cv.md"))) {
    return json({ error: "Add your CV first so I can tailor it — drop it on the home page." }, 400);
  }
  // The web can run against a CAREER_OPS_ROOT that holds data and no scripts;
  // the whole fan-out is core-script children, so feature-detect before streaming.
  if (!fs.existsSync(rootScript("set-status"))) {
    return json({ error: "bulk prepare needs the career-ops scripts; this root has data only", code: "core-script-missing" }, 503);
  }

  const today = new Date().toISOString().slice(0, 10);
  const enc = new TextEncoder();
  // Render + stamp mutate the tracker; hold the write token for the batch so a
  // concurrent row delete can't race mark-pdf-ready/set-status mid-flight
  // (same guard as /api/run's pdf kind).
  const writeToken = acquireTrackerWrite();
  let writeTokenReleased = false;
  const releaseWriteTokenOnce = () => {
    if (!writeTokenReleased) {
      writeTokenReleased = true;
      releaseTrackerWrite(writeToken);
    }
  };

  let closed = false;
  let heartbeat: ReturnType<typeof setInterval> | undefined;
  // The lib checks `aborted` between phases and calls nothing after it flips;
  // `kill` points at the currently running tailor worker, when there is one.
  const signal: { aborted: boolean; kill: (() => void) | null } = { aborted: false, kill: null };

  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      const send = (obj: unknown) => {
        if (closed) return;
        try {
          controller.enqueue(enc.encode(JSON.stringify(obj) + "\n"));
        } catch {
          // Client gone. Stop the batch at the next phase boundary and stop
          // the current worker now — otherwise it runs on for minutes per
          // abandoned request.
          closed = true;
          signal.aborted = true;
          if (heartbeat) clearInterval(heartbeat);
          try { signal.kill?.(); } catch { /* ignore */ }
        }
      };
      const close = () => {
        if (!closed) {
          closed = true;
          if (heartbeat) clearInterval(heartbeat);
          try { controller.close(); } catch { /* ignore */ }
        }
        releaseWriteTokenOnce();
      };
      // Time-based keepalive, same reasoning as /api/run: the stream is silent
      // while a worker thinks or a PDF renders, and idle gaps long enough for a
      // proxy to drop the connection are routine.
      heartbeat = setInterval(() => send({ type: "keepalive" }), 10_000);

      runPrepareBatch({
        root: careerOpsRoot(),
        execPath: process.execPath,
        binPath: resolved.binPath,
        today,
        urls: urls as string[],
        emit: send,
        signal,
        spawnFn: spawn,
        spawnWorker: spawnHeadlessCli,
        atomicWrite,
        inbox: readInbox(),
        rootScript,
        // The row's CURRENT canonical status, resolved by the Report cell's
        // link — the same lookup /api/prepare/approve does — so the stamp's
        // status write is a no-op and re-preparing an Applied row never
        // downgrades it. Read fresh per call: backfilled rows merge mid-batch.
        currentStatus: (report: string) => {
          const num = parseInt(report, 10);
          const row = readApplications().find((a) => {
            const linked = a.report.match(/\]\(([^)]+)\)/)?.[1];
            const n = linked ? parseInt(path.basename(linked), 10) : parseInt(a.report, 10);
            return n === num;
          });
          return row ? canonicalizeStatus(row.status) : null;
        },
        env: process.env,
      })
        .catch((e: unknown) => {
          send({ type: "error", msg: `Bulk prepare crashed unexpectedly: ${e instanceof Error ? e.message : String(e)}`.slice(0, 200) });
        })
        .finally(close);
    },
    cancel() {
      closed = true;
      signal.aborted = true;
      if (heartbeat) clearInterval(heartbeat);
      try { signal.kill?.(); } catch { /* ignore */ }
      // No token release here: the batch stops at its next phase boundary and
      // its .finally(close) releases the token AFTER any in-flight render or
      // stamp child settles — same deferred-release reasoning as /api/run's
      // pdfRenderPromise, without a second promise to track.
    },
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "text/plain; charset=utf-8",
      "Cache-Control": "no-cache, no-transform",
      "X-Accel-Buffering": "no",
    },
  });
}
