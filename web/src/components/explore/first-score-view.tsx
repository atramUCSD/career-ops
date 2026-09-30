"use client";

import { useEffect, useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import { Sparkles, FileText, Compass, ShieldCheck, Coins } from "lucide-react";
import { cn } from "@/lib/cn";
import { parseReport, scoreTone, legitimacyTone } from "@/lib/format";
import { useJobs, type Job } from "@/components/jobs/job-store";
import { Dialog } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";

const SEEN_KEY = "career-ops:first-score-seen";

// THE AHA — fires once, the first time an evaluation completes. The maintainer's
// north star: the WHY is the hero (a sentence that clearly read THIS CV and reasoned
// about THIS job), the grade is large-but-secondary. A celebration, not a report.

/** Pull the strongest "why this person" line out of the worker output. Prefer the
 *  VERDICT summary; else the first substantive sentence of the report body. */
function extractWhy(job: Job): string {
  const s = (job.result?.summary || "").trim();
  if (s.length > 30) return s.replace(/\.$/, "") + ".";
  const body = parseReport(job.text || "").body;
  const para = body
    .split(/\n{2,}/)
    .map((p) => p.replace(/[#*>`-]/g, "").replace(/\s+/g, " ").trim())
    .find((p) => p.length > 60 && /\b(you|your|fit|match|strong|experience|background)\b/i.test(p));
  return para ? para.slice(0, 240) : "You're a strong match for this role — open the full report for the breakdown.";
}

export function FirstScoreView() {
  const router = useRouter();
  const { jobs } = useJobs();
  const [dismissed, setDismissed] = useState(false);
  const [seen, setSeen] = useState(true); // assume seen until we read localStorage (avoid flash)

  useEffect(() => {
    try {
      setSeen(localStorage.getItem(SEEN_KEY) === "1");
    } catch {
      setSeen(false);
    }
  }, []);

  const firstDone = useMemo(
    () => jobs.filter((j) => j.kind === "evaluate" && j.status === "done").sort((a, b) => (a.endedAt ?? 0) - (b.endedAt ?? 0))[0],
    [jobs],
  );

  // Stays mounted once there is a result so the Dialog can play its exit fade.
  if (!firstDone) return null;
  const open = !seen && !dismissed;

  const why = extractWhy(firstDone);
  const score = firstDone.result?.score ?? null;
  const meta = parseReport(firstDone.text || "");
  const legit = meta.legitimacy;
  const company = firstDone.title.replace(/^Evaluate\s*·\s*/, "");
  const role = firstDone.subtitle || "";
  const tone = score != null ? scoreTone(`${score}`) : "muted";

  // Escape, backdrop and the close button all count as seen (don't re-pop on reload).
  const close = () => {
    try {
      localStorage.setItem(SEEN_KEY, "1");
    } catch {
      /* ignore */
    }
    setDismissed(true);
  };

  return (
    <Dialog
      open={open}
      onClose={close}
      size="lg"
      title="Your first score"
      className="bg-linear-to-b from-brand/10 to-transparent to-50%"
      footer={
        <>
          <Button
            variant="secondary"
            className="max-sm:flex-1"
            onClick={() => {
              close();
              router.push("/explore");
            }}
          >
            <Compass aria-hidden className="size-4" /> Find more like this
          </Button>
          <Button
            className="max-sm:flex-1"
            onClick={() => {
              close();
              router.push("/pipeline?tab=EVALUATED");
            }}
          >
            <FileText aria-hidden className="size-4" /> See the full report
          </Button>
        </>
      }
    >
      <div className="flex items-start gap-4">
        <div className="min-w-0 flex-1">
          <h3 className="font-display truncate text-lg leading-tight text-foreground">{role || company}</h3>
          {role && <p className="truncate text-sm text-muted">{company}</p>}
        </div>
        {score != null && (
          <div className="shrink-0 text-right">
            <div
              className={cn(
                "text-5xl font-semibold leading-none tabular-nums",
                tone === "good" ? "text-brand-text" : tone === "warn" ? "text-warn" : tone === "bad" ? "text-bad-text" : "text-muted",
              )}
            >
              {score}
            </div>
            <div className="eyebrow text-2xs text-muted">/ 5 fit</div>
          </div>
        )}
      </div>

      {/* THE WHY — the hero. A sentence that read THIS CV against THIS job. */}
      <blockquote className="font-display mt-5 border-l-2 border-brand/40 pl-4 text-xl leading-snug text-foreground">
        <Sparkles aria-hidden className="mb-1 inline size-4 text-brand-text" /> {why}
      </blockquote>

      {legit && (
        <Badge tone={legitimacyTone(legit) === "good" ? "good" : "warn"} className="mt-4 inline-flex items-center gap-1.5 font-medium">
          <ShieldCheck aria-hidden className="size-3" /> Legitimacy: {legit}
        </Badge>
      )}

      <p className="mt-5 flex items-center gap-1.5 text-xs text-faint">
        <Coins aria-hidden className="size-3.5" /> That ran on your own AI. Everything before it — finding this job — was free.
      </p>
    </Dialog>
  );
}
