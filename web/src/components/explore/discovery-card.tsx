"use client";

import { useMemo, useState } from "react";
import { ExternalLink, Plus, Check, Loader2, ShieldQuestion, Sparkles, Coins } from "lucide-react";
import { cn } from "@/lib/cn";
import { Button, buttonVariants } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { instrumentSerif } from "@/lib/fonts";
import { ATS_LABEL, type AtsSource, type DiscoveredOffer } from "@/lib/explore";
import { useJobs } from "@/components/jobs/job-store";
import { useExplore } from "./explore-provider";

function freshness(postedAt: string): string {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(postedAt)) return "";
  const days = Math.max(0, Math.round((Date.now() - new Date(postedAt + "T00:00:00Z").getTime()) / 86_400_000));
  return days === 0 ? "today" : days === 1 ? "1d ago" : `${days}d ago`;
}

// Real company logo (favicon) via the localhost proxy, cached on disk FOREVER per
// company — so once it resolves it's instant for this card AND every other card,
// this search or any future one. Falls back to a monogram on miss.
function Logo({ company }: { company: string }) {
  const [failed, setFailed] = useState(false);
  const letter = (company || "?").trim().charAt(0).toUpperCase();
  if (failed || !company.trim()) {
    return <div className="grid size-9 shrink-0 place-items-center rounded-xl bg-brand-soft text-sm font-semibold text-brand">{letter}</div>;
  }
  return (
    // eslint-disable-next-line @next/next/no-img-element
    <img
      src={`/api/logo?company=${encodeURIComponent(company)}`}
      alt=""
      loading="lazy"
      onError={() => setFailed(true)}
      className="size-9 shrink-0 rounded-xl border border-border bg-surface object-contain p-1"
    />
  );
}

// What a running worker is doing on this exact posting → the live CTA label.
const WORKER_LABEL: Record<string, string> = { evaluate: "Evaluating…", pdf: "Preparing CV…", research: "Researching…", apply: "Filling…" };

export function DiscoveryCard({ offer, inPipeline, evaluatedN }: { offer: DiscoveredOffer; inPipeline: boolean; evaluatedN?: string }) {
  const { added, adding, addToPipeline } = useExplore();
  const { jobs, startJob } = useJobs();

  // GLOBAL worker awareness: any worker acting on this URL drives the CTA, here
  // and on every other surface that renders this offer (the jobs store is global).
  const job = useMemo(
    () => jobs.filter((j) => j.input === offer.url).sort((a, b) => b.startedAt - a.startedAt)[0],
    [jobs, offer.url],
  );
  const working = job?.status === "running";
  const doneEval = job?.status === "done" && job.kind === "evaluate";
  const statusLabel = WORKER_LABEL[job?.kind ?? ""] ?? "Working…";

  const isAdded = added.has(offer.url) || inPipeline || working || doneEval;
  const isAdding = adding.has(offer.url);
  const unverified = offer.verification === "unconfirmed";
  const fresh = freshness(offer.postedAt) || offer.postedHint || "";

  const evaluate = () => {
    addToPipeline([offer]); // evaluating implies it's in the pipeline — record it
    startJob({ title: `Evaluate · ${offer.company}`, subtitle: offer.title, kind: "evaluate", input: offer.url, page: "/explore" });
  };

  return (
    <Card as="article" inset className="co-rise group flex min-w-0 flex-col gap-2.5 transition-colors duration-150 ease-out hover:border-brand/40">
      <div className="flex items-start gap-3">
        <Logo company={offer.company} />
        <a href={offer.url} target="_blank" rel="noopener noreferrer" className="block min-w-0 flex-1 rounded-md focus-ring max-sm:min-h-11">
          <h3 className={`${instrumentSerif.className} truncate text-lg leading-tight text-foreground transition-colors group-hover:text-brand`}>{offer.title}</h3>
          <p className="mt-0.5 truncate text-sm text-muted">
            {offer.company}
            {offer.location && <span className="text-faint"> · {offer.location}</span>}
          </p>
        </a>
        <a
          href={offer.url}
          target="_blank"
          rel="noopener noreferrer"
          title="Open the posting"
          aria-label="Open the posting"
          className={cn(buttonVariants({ variant: "ghost", size: "icon-sm" }), "-m-1 shrink-0 text-faint")}
        >
          <ExternalLink aria-hidden className="size-4" />
        </a>
      </div>

      <div className="flex flex-wrap items-center gap-1.5 text-2xs">
        <span className="rounded-md border border-border px-1.5 py-0.5 font-medium text-muted">{ATS_LABEL[offer.ats as AtsSource] ?? offer.ats}</span>
        {fresh && <span className="text-faint">{fresh}</span>}
        {unverified && (
          <span
            className="inline-flex items-center gap-1 rounded-md border border-warn/30 bg-warn-soft px-1.5 py-0.5 font-medium text-warn"
            title="Found by AI on the public web — we can't confirm it's still live without opening it. Evaluating runs a real browser check and sets the verdict."
          >
            <ShieldQuestion aria-hidden className="size-3" /> unverified
          </span>
        )}
        {offer.matchedKeyword && (
          <span className="text-faint" title="Keyword match — not yet scored. Evaluate to get an A–F fit score.">
            · matched <span className="text-brand-text">{offer.matchedKeyword}</span>
          </span>
        )}
        {offer.fit && (
          <span
            className={cn(
              "rounded-md border px-1 py-0.5 text-2xs font-medium",
              offer.fit.band === "strong"
                ? "border-good/30 bg-good-soft text-brand-text"
                : "text-faint",
            )}
            title="Free keyword-level estimate: posting title vs your profile's target roles (config/profile.yml). Not an evaluation — Evaluate still gives the real A–F fit score."
          >
            · {offer.fit.band} fit
          </span>
        )}
      </div>

      {offer.why && (
        <p className="flex items-start gap-1.5 text-xs leading-snug text-brand-text">
          <Sparkles aria-hidden className="mt-0.5 size-3 shrink-0" />
          {offer.why}
        </p>
      )}

      <div className="mt-0.5">
        {evaluatedN || doneEval ? (
          <a
            href={evaluatedN ? `/pipeline/${evaluatedN}` : job ? `/jobs/${job.id}` : "/pipeline"}
            className={cn(buttonVariants({ variant: "soft" }), "w-full text-xs")}
          >
            <Check aria-hidden className="size-3.5" /> Evaluated · view report
          </a>
        ) : working ? (
          <div role="status" className="inline-flex h-9 w-full items-center justify-center gap-1.5 rounded-md border border-brand/30 bg-brand-soft/60 px-3 text-xs font-medium text-brand-text">
            <Loader2 aria-hidden className="size-3.5 motion-safe:animate-spin" />
            {statusLabel}
            <span className="text-brand-text">· in pipeline</span>
          </div>
        ) : (
          <div className="flex items-center gap-2">
            <Button
              variant="secondary"
              loading={isAdding}
              disabled={isAdded}
              onClick={() => addToPipeline([offer])}
              className={cn(
                "flex-1 text-xs",
                isAdded ? "border-good/30 bg-good-soft text-brand-text disabled:opacity-100" : "hover:bg-brand-soft hover:text-brand-text",
              )}
            >
              {isAdding ? null : isAdded ? <Check aria-hidden className="size-3.5" /> : <Plus aria-hidden className="size-3.5" />}
              {isAdded ? "In pipeline" : "Add to pipeline"}
            </Button>
            <Button
              variant="soft"
              onClick={evaluate}
              title={unverified ? "Runs a real evaluation — and verifies the posting is live. Uses tokens." : "Runs a real A–F evaluation. Uses tokens."}
              className="flex-1 text-xs"
            >
              Evaluate <Coins aria-hidden className="size-3.5 opacity-80" />
            </Button>
          </div>
        )}
      </div>
    </Card>
  );
}
