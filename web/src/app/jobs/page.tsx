"use client";

import Link from "next/link";
import { Check, AlertTriangle, Loader2, Trash2 } from "lucide-react";
import { useJobs } from "@/components/jobs/job-store";
import { pillTone } from "@/components/jobs/worker-card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";

export default function JobsHistory() {
  const { jobs, clearFinished } = useJobs();

  return (
    <div className="mx-auto max-w-6xl px-4 py-6 sm:px-6 sm:py-8 max-sm:pb-24">
      <div className="mb-6 flex flex-col items-start gap-3 sm:flex-row sm:items-end sm:justify-between sm:gap-4">
        <div>
          <h1 className="font-display text-2xl tracking-tight text-landing">Workers</h1>
          <p className="mt-1 text-sm text-muted">
            Every evaluation you ran — a persistent log. <span className="tabular-nums">{jobs.length}</span> total.
          </p>
        </div>
        {jobs.some((j) => j.status !== "running") && (
          <Button variant="secondary" size="sm" onClick={clearFinished}>
            <Trash2 aria-hidden className="size-3.5" /> Clear finished
          </Button>
        )}
      </div>

      {jobs.length === 0 ? (
        <Card inset className="border-dashed border-faint/40 py-12 text-center text-sm text-muted">
          No workers yet. Hit <span className="text-foreground">Evaluate</span> on an inbox posting to spin one up.
        </Card>
      ) : (
        <ul className="divide-y divide-border overflow-hidden rounded-xl border border-border bg-surface/40">
          {jobs.map((j) => {
            const tone = pillTone(j);
            return (
              <li key={j.id}>
                <Link
                  href={`/jobs/${j.id}`}
                  className="flex items-center gap-3 px-4 py-3 focus-ring-inset transition-colors duration-150 ease-out hover:bg-surface-hover"
                >
                  {j.status === "running" ? (
                    <Loader2 aria-hidden className="size-4 shrink-0 motion-safe:animate-spin text-brand" />
                  ) : j.status === "error" ? (
                    <AlertTriangle aria-hidden className="size-4 shrink-0 text-bad-text" />
                  ) : (
                    <Check aria-hidden className="size-4 shrink-0 text-brand-text" />
                  )}
                  <div className="min-w-0 flex-1">
                    <div className="truncate text-sm font-medium">{j.title}</div>
                    {(j.subtitle || j.result?.summary) && (
                      <div className="truncate text-xs text-muted">{j.result?.summary || j.subtitle}</div>
                    )}
                  </div>
                  {j.result?.score != null && (
                    <Badge tone={tone} className="shrink-0">
                      {j.result.score}/5
                    </Badge>
                  )}
                  <span className="shrink-0 text-xs capitalize text-faint max-sm:sr-only">{j.status}</span>
                </Link>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}
