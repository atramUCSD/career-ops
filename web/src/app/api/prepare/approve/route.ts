// POST /api/prepare/approve — per-application approval of a prepared batch
// item: appends `prepared: approved YYYY-MM-DD` to the row's Notes cell via
// set-status.mjs, the same delegate-to-the-core pattern as /api/status.
//
// Approval NEVER moves lifecycle state. The row's own CURRENT canonical status
// is passed back to set-status, making the status write a guaranteed no-op
// (statusChanged false) — a row the user already advanced to Applied is not
// downgraded — while --note appends the approved marker idempotently under the
// shared tracker lock. There is no batch approve, and nothing here (or
// anywhere) submits an application; submission stays manual.
import { NextResponse } from "next/server";
import { execFile } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { careerOpsRoot, readApplications, rootScript } from "@/lib/career-ops";
import { canonicalizeStatus } from "@/lib/core/states";
import { clientErrorMessage, parseCliJson, trackerRowArg } from "@/lib/status-cli.mjs";
import { boundedLockWaitEnv, CORE_SCRIPT_TIMEOUT_MS } from "@/lib/prepare-fanout.mjs";

export const runtime = "nodejs"; // delegates to the core CLI via child_process

// set-status.mjs exit codes → HTTP, same table as /api/status: 2 not-found,
// 3 ambiguous (two rows link one report), 4 lock contention (retry shortly).
const EXIT_TO_HTTP: Record<number, number> = { 2: 404, 3: 409, 4: 503 };
// Exit 1's caller-fault subset — everything else on that exit is ours (500).
const CLIENT_ERROR_CODES = new Set(["usage", "invalid-state"]);

type CliResult = { code: number; stdout: string; stderr: string; spawnFailed: boolean; timedOut: boolean };

function runSetStatus(args: string[]): Promise<CliResult> {
  return new Promise((resolve) => {
    execFile(
      process.execPath,
      [rootScript("set-status"), ...args],
      {
        cwd: careerOpsRoot(),
        timeout: CORE_SCRIPT_TIMEOUT_MS,
        env: { ...process.env, ...boundedLockWaitEnv(process.env) },
      },
      (err, stdout, stderr) => {
        // Same three-way split as /api/status: non-zero exit, our kill
        // (timeout), and a failure to spawn all arrive through one error
        // object, and a killed child carries no numeric exit code.
        const e = err as (NodeJS.ErrnoException & { killed?: boolean }) | null;
        const timedOut = e?.killed === true;
        const code = typeof e?.code === "number" ? e.code : e ? -1 : 0;
        resolve({ code, stdout: stdout || "", stderr: stderr || "", spawnFailed: !timedOut && code === -1, timedOut });
      },
    );
  });
}

export async function POST(req: Request) {
  let body: { report?: unknown };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "bad json" }, { status: 400 });
  }
  // Same digits-only gate as /api/status's row selector: answer a bad request
  // before paying for a process spawn and a tracker lock.
  const report = trackerRowArg(body.report);
  if (!report) {
    return NextResponse.json({ error: "report must be a report number" }, { status: 400 });
  }
  const script = rootScript("set-status");
  if (!fs.existsSync(script)) {
    return NextResponse.json(
      { error: "approval needs the career-ops scripts; this root has data only", code: "core-script-missing" },
      { status: 503 },
    );
  }

  // Resolve the row's CURRENT status by the Report cell's link (the same
  // number space set-status's --report selector matches on), so the write
  // below can pass it back unchanged. set-status re-resolves under the lock —
  // this read is for the argv, not the authority.
  const num = parseInt(report, 10);
  const row = readApplications().find((a) => {
    const linked = a.report.match(/\]\(([^)]+)\)/)?.[1];
    const n = linked ? parseInt(path.basename(linked), 10) : parseInt(a.report, 10);
    return n === num;
  });
  if (!row) {
    return NextResponse.json({ error: `No tracker row links report #${report}` }, { status: 404 });
  }
  const canon = canonicalizeStatus(row.status);
  if (!canon) {
    // A hand-edited Status cell set-status would reject as invalid-state; a
    // 409 tells the caller the ROW needs fixing, not the request.
    return NextResponse.json({ error: `Row's current status "${row.status}" is not canonical — fix the tracker row first` }, { status: 409 });
  }

  const today = new Date().toISOString().slice(0, 10);
  const { code, stdout, stderr, spawnFailed, timedOut } = await runSetStatus([
    "--report",
    report,
    canon,
    "--note",
    `prepared: approved ${today}`,
    "--source",
    "web",
    "--json",
  ]);
  const parsed = parseCliJson(stdout);

  if (spawnFailed) {
    // Child stderr is a Node stack trace carrying absolute server paths — log
    // only, never echo (same as /api/status).
    console.error(`/api/prepare/approve: set-status.mjs failed to run: ${stderr.trim()}`);
    return NextResponse.json({ error: "approval failed to run" }, { status: 500 });
  }
  if (timedOut) {
    return NextResponse.json(
      { error: "approval timed out; the marker may or may not have been applied" },
      { status: 504, headers: { "Retry-After": "5" } },
    );
  }
  if (code !== 0) {
    const cliCode = typeof parsed?.code === "string" ? parsed.code : undefined;
    const httpStatus =
      code === 1
        ? (cliCode && CLIENT_ERROR_CODES.has(cliCode) ? 400 : 500)
        : (EXIT_TO_HTTP[code] ?? 500);
    if (!parsed && stderr.trim()) {
      console.error(`/api/prepare/approve: set-status.mjs exited ${code} without JSON: ${stderr.trim()}`);
    }
    return NextResponse.json(
      { error: clientErrorMessage(parsed, stderr), ...(cliCode ? { code: cliCode } : {}) },
      { status: httpStatus, ...(httpStatus === 503 ? { headers: { "Retry-After": "5" } } : {}) },
    );
  }
  if (!parsed) {
    return NextResponse.json({ error: "approval returned no result" }, { status: 500 });
  }

  return NextResponse.json({
    ok: true,
    status: canon,
    changed: parsed.changed === true,
    statusLogged: parsed.statusLogged === true,
  });
}
