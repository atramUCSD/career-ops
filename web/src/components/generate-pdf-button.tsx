"use client";

import { useMemo } from "react";
import Link from "next/link";
import { FileDown, Loader2, FileText, RotateCcw } from "lucide-react";
import { useJobs } from "@/components/jobs/job-store";
import { CostBadge } from "@/components/cost/cost-badge";
import { Button, buttonVariants } from "@/components/ui/button";

// Fires the real career-ops `pdf` mode (worker kind "pdf") to generate an
// ATS-optimized CV tailored to THIS offer → output/cv-… + marks the tracker.
// Once a tailored CV exists (tracker PDF ✅, or a pdf worker just finished), it
// becomes a "View tailored CV" link (served by /api/cv-pdf) + a regenerate icon.
export function GeneratePdfButton({ n, company, pdfReady }: { n: string; company: string; pdfReady: boolean }) {
  const { jobs, startJob } = useJobs();
  const job = useMemo(
    () => jobs.filter((j) => j.kind === "pdf" && j.input === n).sort((a, b) => b.startedAt - a.startedAt)[0],
    [jobs, n],
  );
  const generate = () =>
    startJob({ title: `CV PDF · ${company}`, subtitle: "tailored for this role", kind: "pdf", input: n, page: `/pipeline/${n}` });

  if (job?.status === "running")
    return (
      <Link href={`/jobs/${job.id}`} className={buttonVariants({ variant: "soft", size: "sm" })}>
        <Loader2 aria-hidden className="size-3.5 motion-safe:animate-spin" /> Generating CV…
      </Link>
    );

  const ready = pdfReady || job?.status === "done";
  if (ready)
    return (
      <span className="inline-flex items-center gap-1">
        <a
          href={`/api/cv-pdf?n=${encodeURIComponent(n)}&company=${encodeURIComponent(company)}`}
          target="_blank"
          rel="noreferrer"
          className={buttonVariants({ variant: "soft", size: "sm" })}
        >
          <FileText aria-hidden className="size-3.5" /> View tailored CV
        </a>
        <Button
          variant="ghost"
          size="icon-sm"
          onClick={generate}
          title="Regenerate the tailored CV"
          aria-label="Regenerate the tailored CV"
          className="text-muted hover:text-brand"
        >
          <RotateCcw aria-hidden className="size-3.5" />
        </Button>
      </span>
    );

  // Point-of-action cost affordance: generating a tailored CV runs the user's
  // AI (spends tokens). Surface it right on the trigger so cost is never a
  // surprise — the community's #1 pain (mirrors Explore's token-honesty).
  return (
    <span className="inline-flex items-center gap-1.5">
      <Button
        variant="secondary"
        size="sm"
        onClick={generate}
        className="text-muted hover:border-brand/40 hover:text-brand"
        title="Generate an ATS-optimized CV tailored to this role"
      >
        <FileDown aria-hidden className="size-3.5" /> Generate tailored CV (PDF)
      </Button>
      <CostBadge kind="spend" size="xs" />
    </span>
  );
}
