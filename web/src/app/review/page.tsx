import fs from "node:fs";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { careerOpsRoot, findReportFile, readApplications, rootScript, spawnEnv, userRoot } from "@/lib/career-ops";
import { matchClaims, reviewDelta } from "@/lib/review-diff.mjs";
import { ReviewQueue, type ReviewItem } from "./review-queue";

export const dynamic = "force-dynamic"; // always read fresh local files

const execFileAsync = promisify(execFile);

type Claim = { story: string; claim: string; bucket: "derived-unverified" | "user-cannot-confirm" };

/** Claims a human must not approve on autopilot: the derived-unverified and
 *  user-cannot-confirm buckets of the core's zero-LLM provenance checker.
 *  Missing/old checkout or a parse failure degrades to "no flags", never a 500. */
async function uncertainClaims(): Promise<Claim[]> {
  const script = rootScript("story-provenance-check");
  if (!fs.existsSync(script)) return [];
  try {
    // The checker's defaults are cwd-relative with no env override, so the
    // active user layer's files are named explicitly.
    const root = userRoot();
    const args = [script, "--story-bank", path.join(root, "interview-prep", "story-bank.md"), "--cv", path.join(root, "cv.md")];
    const { stdout } = await execFileAsync(process.execPath, args, {
      cwd: careerOpsRoot(),
      env: await spawnEnv(),
      timeout: 15_000,
      windowsHide: true,
    });
    const r = JSON.parse(stdout);
    const tag = (items: unknown, bucket: Claim["bucket"]): Claim[] =>
      Array.isArray(items)
        ? items
            .filter((c): c is { story?: string; claim: string } => typeof c?.claim === "string")
            .map((c) => ({ story: c.story ?? "", claim: c.claim, bucket }))
        : [];
    return [...tag(r.derivedUnverified, "derived-unverified"), ...tag(r.userCannotConfirm, "user-cannot-confirm")];
  } catch {
    return [];
  }
}

function readOr(p: string | null, fallback = ""): string {
  try {
    return p ? fs.readFileSync(p, "utf8") : fallback;
  } catch {
    return fallback;
  }
}

export default async function ReviewPage() {
  const root = userRoot();
  // Prepared = the Notes-cell marker, never a novel Status value (the tracker
  // Status stays canonical; see the bulk-prepare contract).
  const prepared = readApplications().filter(
    (a) => /prepared:\s*awaiting review/i.test(a.notes) && !/prepared:\s*approved/i.test(a.notes),
  );
  const claims = prepared.length ? await uncertainClaims() : [];
  const cvMd = readOr(path.join(root, "cv.md"));

  const items: ReviewItem[] = prepared.map((a) => {
    const reportFile = findReportFile(a.n);
    // Report FILE number (kept zero-padded, it can differ from the app number)
    // names both the scratch HTML and the approve target. A backfilled row's
    // report file never exists, so fall back to the Report cell's own link —
    // the same number space the prepare stamp and set-status --report match.
    const linked = a.report.match(/\]\(([^)]+)\)/)?.[1];
    const report =
      (reportFile ? path.basename(reportFile).match(/^\d+/)?.[0] : undefined) ??
      (linked ? path.basename(linked).match(/^\d+/)?.[0] : undefined) ??
      null;
    const jdUnread = /Verification:(\*\*)?\s*unconfirmed/i.test(readOr(reportFile));
    // The tailored CV the prepare worker wrote (resolvePdfPaths convention):
    // ONLY the padded report number names it. A tracker-row-number fallback
    // can resolve a DIFFERENT application's CV when row and report numbers
    // diverge — better to show htmlMissing than review the wrong bullets.
    const htmlPath = report ? path.join(root, ".career-ops-web", "pdf-tmp", `cv-web-${report}.html`) : null;
    const html = htmlPath && fs.existsSync(htmlPath) ? htmlPath : undefined;
    const bullets = html
      ? reviewDelta(readOr(html), cvMd).map((b) => ({ ...b, claims: matchClaims(b.text, claims) }))
      : [];
    return {
      n: a.n,
      company: a.company,
      role: a.role,
      report,
      jdUnread,
      htmlMissing: !html,
      bullets,
      flagged: jdUnread || bullets.some((b) => b.claims.length > 0),
    };
  });

  // Uncertainty first — flagged rows are the ones worth the human's attention.
  items.sort((x, y) => Number(y.flagged) - Number(x.flagged) || parseInt(y.n, 10) - parseInt(x.n, 10));

  return (
    <div className="mx-auto max-w-3xl px-4 py-6 max-sm:pb-24 sm:px-6 sm:py-8">
      <header className="mb-6">
        <h1 className="font-display text-2xl tracking-tight text-landing">Review</h1>
        <p className="mt-1 text-sm text-muted">
          Prepared applications awaiting your sign-off. Approving marks one ready — submitting stays yours, by hand.
        </p>
      </header>
      <ReviewQueue items={items} />
    </div>
  );
}
