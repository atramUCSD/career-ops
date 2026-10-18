"use client";

import { useMemo, useState, type FormEvent } from "react";
import Link from "next/link";
import { FileText, Loader2, Mail, RotateCcw, TriangleAlert } from "lucide-react";
import { useJobs } from "@/components/jobs/job-store";
import { CostBadge } from "@/components/cost/cost-badge";
import { pdfButtonState } from "@/lib/pdf-button-state.mjs";
import { COVER_TONES } from "@/lib/cover-tones.mjs";
import { Button, buttonVariants } from "@/components/ui/button";
import { Select, Textarea } from "@/components/ui/field";

// Fires the real career-ops `cover` mode (worker kind "cover") for THIS
// application. cover.md will not draft until the candidate answers its four
// Step 6 prompts, so the button opens those questions first. The draft lands in
// the run log. Rendering it to PDF is still the CLI's Step 9.
const QUESTIONS = [
  { name: "why", label: "Why this role or company?", hint: "One or two angles: scale, mission, stage, or what you would learn." },
  { name: "problem", label: "What problem would you solve for them?", hint: "The research step checks this against what the company says publicly." },
  { name: "approach", label: "How would you approach it on day one?", hint: "One or two sentences. This is the most specific part of the letter." },
] as const;

export function CoverDraftButton({ n, company }: { n: string; company: string }) {
  const { jobs, startJob } = useJobs();
  const [open, setOpen] = useState(false);
  const [savedBrief, setSavedBrief] = useState<Record<string, string> | null>(null);
  const job = useMemo(
    () => jobs.filter((j) => j.kind === "cover" && j.input === n).sort((a, b) => b.startedAt - a.startedAt)[0],
    [jobs, n],
  );
  // A cover run can finish with VERDICT 1/5 and no letter. Only treat a real
  // draft as ready; weak verdicts surface as a retry failure beside the form.
  const base = pdfButtonState(job, false);
  const weakDraft = job?.status === "done" && job.result?.score != null && job.result.score < 2;
  const state = weakDraft
    ? {
        kind: "idle" as const,
        failure: {
          jobId: job.id,
          reason: job.result?.summary || "The cover run finished without a usable draft.",
        },
      }
    : base;

  const submit = (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    const data = new FormData(e.currentTarget);
    const brief = Object.fromEntries(["why", "problem", "approach", "tone"].map((k) => [k, String(data.get(k) ?? "")]));
    setSavedBrief(brief);
    startJob({ title: `Cover letter · ${company}`, subtitle: "draft for this role", kind: "cover", input: n, page: `/pipeline/${n}`, brief });
    setOpen(false);
  };

  if (state.kind === "running")
    return (
      <Link href={`/jobs/${state.jobId}`} className={buttonVariants({ variant: "soft", size: "sm" })}>
        <Loader2 aria-hidden className="size-3.5 motion-safe:animate-spin" /> Drafting cover letter…
      </Link>
    );

  return (
    <>
      {state.kind === "ready" && job ? (
        <span className="inline-flex items-center gap-1">
          <Link
            href={`/jobs/${job.id}`}
            className={buttonVariants({ variant: "soft", size: "sm" })}
          >
            <FileText aria-hidden className="size-3.5" /> View cover letter draft
          </Link>
          <Button
            variant="ghost"
            size="icon-sm"
            onClick={() => setOpen((o) => !o)}
            title="Draft the cover letter again"
            aria-label="Draft the cover letter again"
            aria-expanded={open}
            className="text-muted hover:text-brand"
          >
            <RotateCcw aria-hidden className="size-3.5" />
          </Button>
        </span>
      ) : (
        <Button
          variant="secondary"
          size="sm"
          onClick={() => setOpen((o) => !o)}
          aria-expanded={open}
          className="text-muted hover:border-brand/40 hover:text-brand"
          title="Draft a cover letter for this role with your AI CLI"
        >
          <Mail aria-hidden className="size-3.5" /> Draft cover letter
        </Button>
      )}
      {state.failure && (
        <Link
          href={`/jobs/${state.failure.jobId}`}
          role="alert"
          title="Open the run log"
          className="inline-flex max-w-md items-start gap-1 rounded-sm text-xs text-bad-text hover:underline focus-ring"
        >
          <TriangleAlert aria-hidden className="mt-0.5 size-3.5 shrink-0" />
          <span>Cover letter not drafted. {state.failure.reason}</span>
        </Link>
      )}
      {open && (
        <form onSubmit={submit} aria-label="Cover letter questions" className="basis-full space-y-4 rounded-xl border border-border bg-surface p-4">
          {QUESTIONS.map((q) => (
            <Textarea key={q.name} name={q.name} label={q.label} hint={q.hint} required maxLength={1000} rows={2} defaultValue={savedBrief?.[q.name] ?? ""} />
          ))}
          <Select name="tone" label="Tone" defaultValue={savedBrief?.tone ?? "mirror"}>
            {Object.entries(COVER_TONES).map(([id, label]) => (
              <option key={id} value={id}>{label}</option>
            ))}
          </Select>
          <div className="flex flex-wrap items-center gap-2">
            <Button type="submit" size="sm">
              <Mail aria-hidden className="size-3.5" /> Draft letter
            </Button>
            <CostBadge kind="spend" size="xs" />
            <Button type="button" variant="ghost" size="sm" onClick={() => setOpen(false)} className="text-muted">
              Cancel
            </Button>
          </div>
        </form>
      )}
    </>
  );
}
