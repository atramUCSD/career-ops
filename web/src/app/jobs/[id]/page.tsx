"use client";

import { use } from "react";
import Link from "next/link";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { ArrowLeft, Loader2, Wrench, CircleDot, Check, X } from "lucide-react";
import { useJobs } from "@/components/jobs/job-store";
import { HeroGlow } from "@/components/hero-glow";
import { Badge } from "@/components/ui/badge";
import { Card } from "@/components/ui/card";

const PAGE = "mx-auto max-w-3xl px-4 py-6 sm:px-6 sm:py-8 max-sm:pb-24";

function BackLink() {
  return (
    <Link
      href="/pipeline"
      className="inline-flex items-center gap-1.5 rounded-md text-sm text-muted focus-ring transition-colors duration-150 ease-out hover:text-brand max-sm:min-h-11"
    >
      <ArrowLeft aria-hidden className="size-4" /> Pipeline
    </Link>
  );
}

export default function JobPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params);
  const { jobs } = useJobs();
  const job = jobs.find((j) => j.id === id);

  if (!job) {
    return (
      <div className={PAGE}>
        <BackLink />
        <p className="mt-6 text-sm text-muted">
          This worker is no longer in memory (it finished earlier or the page was reloaded).
        </p>
      </div>
    );
  }

  return (
    <div className={PAGE}>
      <BackLink />

      <div className="mt-6 space-y-8">
        {/* overflow-hidden clips HeroGlow; nothing focusable inside, so no outline is cut. */}
        <Card as="section" className="dot-bg overflow-hidden bg-surface/40">
          {job.status === "running" && <HeroGlow />}
          <div className="relative z-10">
            <p className="eyebrow flex items-center gap-2 text-2xs font-semibold text-muted">
              {job.status === "running" ? (
                <><Loader2 aria-hidden className="size-3 animate-spin text-brand" /> working</>
              ) : job.status === "done" ? (
                <><Check aria-hidden className="size-3 text-brand-text" /> done</>
              ) : (
                <><X aria-hidden className="size-3 text-bad-text" /> error</>
              )}
            </p>
            <h1 className="mt-2 font-display text-2xl tracking-tight text-landing">{job.title}</h1>
            {job.subtitle && <p className="mt-1 text-sm text-muted">{job.subtitle}</p>}
            {job.result?.score != null && (
              <div className="mt-3 flex flex-wrap items-center gap-2">
                <Badge tone={job.result.tone}>{job.result.score}/5</Badge>
                {job.result.summary && <span className="text-sm text-muted">{job.result.summary}</span>}
              </div>
            )}
          </div>
        </Card>

        <section>
          <h2 className="eyebrow mb-3 text-xs font-semibold text-muted">Steps</h2>
          <ol className="space-y-2">
            {job.steps.map((s, i) => (
              <li key={i} className="flex items-start gap-2.5 text-sm">
                {s.kind === "tool" ? (
                  <Wrench aria-hidden className="mt-0.5 size-3.5 shrink-0 text-brand" />
                ) : (
                  <CircleDot aria-hidden className="mt-0.5 size-3.5 shrink-0 text-faint" />
                )}
                <span className={s.kind === "tool" ? "font-medium" : "text-muted"}>
                  {s.kind === "tool" ? `Using ${s.label}` : s.label}
                </span>
              </li>
            ))}
            {job.status === "running" && (
              <li className="flex items-center gap-2.5 text-sm text-muted">
                <Loader2 aria-hidden className="size-3.5 animate-spin text-brand" /> thinking…
              </li>
            )}
          </ol>
        </section>

        {job.text && (
          <section>
            <h2 className="eyebrow mb-3 text-xs font-semibold text-muted">Output</h2>
            <Card className="report-prose bg-surface/40 [&>:last-child]:mb-0">
              <ReactMarkdown remarkPlugins={[remarkGfm]}>{job.text}</ReactMarkdown>
            </Card>
          </section>
        )}
      </div>
    </div>
  );
}
