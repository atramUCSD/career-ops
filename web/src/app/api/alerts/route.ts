import { execFile } from "node:child_process";
import path from "node:path";
import { careerOpsRoot, coreModule, rootScript, spawnEnv, userRoot, type NotifyModule } from "@/lib/career-ops";
import { alertsPatch } from "@/lib/alerts-config.mjs";
import { atomicWriteWithBackup } from "@/lib/core/safe-write";
import { configErrorResponse, loadYamlDoc, setIn, toYaml } from "@/lib/yaml-doc.mjs";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// The active profile's email digest: what the next one would say (GET), its
// settings in config/alerts.yml (POST {config}), and the two runs a person
// asks for by hand (POST {action}). Composing and settings go through
// notify-email.mjs itself, so the preview is the mail the scheduler sends.

export async function GET() {
  const root = userRoot();
  try {
    const notify = await coreModule<NotifyModule>("notify-email");
    const run = notify.composeRun({ root });
    const { lastRun } = notify.loadState(root);
    return Response.json({ subject: run.subject, html: run.html, to: run.to, quiet: run.quiet, counts: run.counts, lastRun });
  } catch (error) {
    return Response.json({ error: error instanceof Error ? error.message : String(error) }, { status: 500 });
  }
}

// test: send now, state untouched. seed: mark everything current as seen, send nothing.
const FLAGS: Record<string, string> = { test: "--test", seed: "--seed" };

const lastLine = (s: string) => s.trim().split(/\r?\n/).pop()?.trim() ?? "";

async function runAction(action: unknown): Promise<Response> {
  const flag = typeof action === "string" ? FLAGS[action] : undefined;
  if (!flag) return Response.json({ error: "action must be test or seed" }, { status: 400 });
  const env = await spawnEnv();
  // The send runs as its own process from the code root, where dotenv finds the
  // Gmail token; the server never holds it.
  return new Promise((resolve) => {
    execFile(
      "node",
      [rootScript("notify-email"), flag, "--root", userRoot()],
      { cwd: careerOpsRoot(), env, timeout: 60_000 },
      (error, stdout, stderr) => {
        if (!error) return resolve(Response.json({ ok: true, message: lastLine(stdout) }));
        const message = error.killed ? "Timed out after 60 seconds." : lastLine(stderr) || lastLine(stdout) || error.message;
        resolve(Response.json({ error: message }, { status: 500 }));
      },
    );
  });
}

export async function POST(req: Request) {
  let body: Record<string, unknown>;
  try {
    body = await req.json();
  } catch {
    return Response.json({ error: "bad json" }, { status: 400 });
  }
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    return Response.json({ error: "expected an object" }, { status: 400 });
  }
  if (body.action !== undefined) return runAction(body.action);

  const result = alertsPatch(body.config);
  if ("error" in result) return Response.json({ error: result.error }, { status: 400 });
  const file = path.join(userRoot(), "config", "alerts.yml");
  try {
    const template = path.join(careerOpsRoot(), "config", "alerts.example.yml");
    const { doc, src, seeded } = loadYamlDoc(file, template, "config/alerts.yml");
    // notify-email reads `alerts:` when present and the top level otherwise.
    setIn(doc, doc.has("alerts") ? ["alerts"] : [], result.patch);
    atomicWriteWithBackup(file, toYaml(doc, src));
    return Response.json({ ok: true, seeded });
  } catch (error) {
    return configErrorResponse(error);
  }
}
