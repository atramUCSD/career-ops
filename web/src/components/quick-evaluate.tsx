"use client";

import { useState } from "react";
import { Sparkles } from "lucide-react";
import { useJobs } from "@/components/jobs/job-store";
import { CostBadge } from "@/components/cost/cost-badge";
import { Button } from "@/components/ui/button";

// Auto-pipeline, one click: paste a job URL → fire a real evaluation worker
// (the same kind:"evaluate" that runs modes/oferta.md + writes the A–F report +
// tracker row). The worker pills + assistant cards show progress.
export function QuickEvaluate() {
  const { startJob } = useJobs();
  const [url, setUrl] = useState("");
  const [hint, setHint] = useState("");

  function run() {
    const u = url.trim();
    if (!/^https?:\/\//i.test(u)) {
      setHint("Paste a full job-posting URL (https://…).");
      return;
    }
    startJob({ title: "Evaluate · pasted URL", subtitle: u, kind: "evaluate", input: u, page: "/" });
    setUrl("");
    setHint("Evaluating — watch it in the Workers tray.");
  }

  return (
    <div className="mt-7">
      {/* Composite search field: the wrapper carries the focus state, so the input stays bare. */}
      <div className="flex max-w-xl items-center gap-2 rounded-md border border-control-border bg-surface/70 py-1 pl-4 pr-1 field-focus-within">
        <Sparkles aria-hidden className="size-4 shrink-0 text-brand-text" />
        <input
          aria-label="Job posting URL to evaluate"
          value={url}
          onChange={(e) => {
            setUrl(e.target.value);
            if (hint) setHint("");
          }}
          onKeyDown={(e) => {
            if (e.key === "Enter") run();
          }}
          placeholder="Paste a job URL to evaluate…"
          className="min-w-0 flex-1 bg-transparent py-1.5 text-sm outline-none placeholder:text-faint"
        />
        <Button type="button" onClick={run} className="shrink-0 px-4">
          Evaluate
        </Button>
      </div>
      <div className="mt-2 flex items-center gap-2">
        <CostBadge kind="spend" size="xs" />
        <span className="text-xs text-faint">Evaluation runs on your own AI — your key, your machine.</span>
      </div>
      <p role="status" className="mt-1 text-xs text-faint empty:hidden">
        {hint}
      </p>
    </div>
  );
}
