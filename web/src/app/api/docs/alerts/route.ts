import fs from "node:fs";
import path from "node:path";
import { careerOpsRoot } from "@/lib/career-ops";

// The wizard links the alert setup steps from here: a browser cannot open a
// file from the checkout, and the fork's GitHub copy lags the local one.
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
  try {
    const text = fs.readFileSync(/* turbopackIgnore: true */ path.join(careerOpsRoot(), "docs", "ALERTS.md"), "utf8");
    return new Response(text, { headers: { "content-type": "text/plain; charset=utf-8" } });
  } catch {
    return new Response("docs/ALERTS.md is not in this checkout.", { status: 404 });
  }
}
