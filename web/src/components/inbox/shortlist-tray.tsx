"use client";

import { useState } from "react";
import Link from "next/link";
import { ChevronDown, Coins, FileText, Loader2, Settings, Sparkles, X } from "lucide-react";
import { AnimatePresence, motion } from "motion/react";
import { Badge } from "@/components/ui/badge";
import { Button, buttonVariants } from "@/components/ui/button";
import { layoutMove, listItem } from "@/components/ui/motion";
import { CompanyLogo } from "@/components/company-logo";
import { CostBadge } from "@/components/cost/cost-badge";
import { cn } from "@/lib/cn";

export type ShortItem = { url: string; company: string; role: string };

// Batch characterization for "Prepare N" — computed by the mounting page from
// scores it already has (free), shown BEFORE any click so the user knows what
// the batch is: how many, how well they match, what's below the apply floor,
// and what has nothing to tailor against yet.
export type PrepBatch = { count: number; median: number | null; belowFloor: number; blocked: number };

// Live progress of a running prepare batch — per-item outcomes stream in as
// {type:"item"} NDJSON events and flip the saved rows, the way score results
// flip triage rows.
export type PrepProgress = { running: boolean; label: string | null; byUrl: Record<string, "prepared" | "failed"> };

// /api/prepare rejects larger batches with 400 (route time budget is shared
// across sequential tailor workers) — say so up front instead of failing late.
const PREPARE_MAX = 10;

function fmtTokens(t: number): string {
  if (t >= 1_000_000) return `${(t / 1_000_000).toFixed(1)}M`;
  if (t >= 1_000) return `${Math.round(t / 1_000)}k`;
  return `${t}`;
}

function costLine(e: { tokens?: number; usd?: number }): string {
  return e.tokens ? `≈ ${fmtTokens(e.tokens)} tokens${e.usd != null ? ` · ≈ $${e.usd.toFixed(2)}` : ""}` : "uses your tokens";
}

// Pure batch characterization for "Prepare N" — one score slot per shortlist
// item; null = no completed evaluation (blocked: nothing to tailor against).
// Exported for the root-gated test, which executes this function's source.
export function characterizeBatch(scores: Array<number | null>): PrepBatch {
  const done: number[] = [];
  let blocked = 0;
  for (const s of scores) {
    if (s == null) blocked++;
    else done.push(s);
  }
  done.sort((a, b) => a - b);
  const mid = done.length >> 1;
  const median = done.length ? (done.length % 2 ? done[mid] : (done[mid - 1] + done[mid]) / 2) : null;
  // 4.0 = batch-tailor's default --min-score floor and the below-4.0 discourage rule
  return { count: scores.length, median, belowFloor: done.filter((x) => x < 4).length, blocked };
}

// "5 apps · median 4.2 · 1 below 4.0 · 2 not scored"
function batchLine(batch: PrepBatch): string {
  const parts = [`${batch.count} app${batch.count === 1 ? "" : "s"}`];
  if (batch.median != null) parts.push(`median ${batch.median.toFixed(1)}`);
  if (batch.belowFloor > 0) parts.push(`${batch.belowFloor} below 4.0`);
  if (batch.blocked > 0) parts.push(`${batch.blocked} not scored`);
  return parts.join(" · ");
}

// The persistent shortlist tray — bottom-sheet on mobile (thumb-zone), floating card
// on desktop. "Score shortlist" and "Prepare shortlist" are the ONLY token spends in
// the whole inbox: cost is shown BEFORE the click and gated behind an explicit
// confirm (never spend by surprise). Prepare only DRAFTS (tailored CV + form
// answers) behind the per-application review gate — nothing here submits, ever.
export function ShortlistTray({
  items,
  estimate,
  prepEstimate,
  batch,
  prep,
  hasCli,
  onRemove,
  onClear,
  onScore,
  onPrepare,
}: {
  items: ShortItem[];
  estimate: { tokens?: number; usd?: number };
  prepEstimate: { tokens?: number; usd?: number };
  batch: PrepBatch;
  prep: PrepProgress;
  hasCli: boolean;
  onRemove: (url: string) => void;
  onClear: () => void;
  onScore: () => void;
  onPrepare: () => void;
}) {
  const [open, setOpen] = useState(false);
  const [confirming, setConfirming] = useState<null | "score" | "prepare">(null);
  if (items.length === 0) return null;

  const n = items.length;
  const costText = costLine(estimate);
  const prepCostText = costLine(prepEstimate);

  return (
    <div className="fixed inset-x-0 bottom-0 z-30 sm:bottom-4 md:left-60">
      {/* mirrors the page container so the tray lines up with the left-aligned list above it */}
      <div className="mx-auto max-w-6xl sm:px-6">
        <div className="max-w-3xl border-t border-border bg-surface shadow-raised sm:rounded-2xl sm:border">
          {/* expandable saved-items list; relative so popLayout can pin a removed row */}
          {open && (
            <ul id="shortlist-items" className="relative max-h-64 divide-y divide-border overflow-y-auto px-3 py-1">
              <AnimatePresence initial={false} mode="popLayout">
                {items.map((it) => (
                  <motion.li
                    key={it.url}
                    {...listItem}
                    layout="position"
                    transition={{ ...listItem.transition, layout: layoutMove }}
                    className="flex items-center gap-2.5 py-2"
                  >
                    <CompanyLogo name={it.company} size={18} />
                    <span className="min-w-0 flex-1 truncate text-sm">
                      <span className="font-medium">{it.company}</span> <span className="text-muted">· {it.role}</span>
                    </span>
                    {/* per-item prepare outcome, streamed in while the batch runs */}
                    {prep.byUrl[it.url] ? (
                      <Badge tone={prep.byUrl[it.url] === "prepared" ? "good" : "bad"}>{prep.byUrl[it.url]}</Badge>
                    ) : prep.running ? (
                      <Loader2 aria-hidden className="size-3.5 shrink-0 text-muted motion-safe:animate-spin" />
                    ) : null}
                    <Button
                      variant="ghost"
                      size="icon-sm"
                      onClick={() => onRemove(it.url)}
                      aria-label={`Remove ${it.company}`}
                      className="text-faint focus-ring-inset"
                    >
                      <X aria-hidden className="size-4" />
                    </Button>
                  </motion.li>
                ))}
              </AnimatePresence>
            </ul>
          )}

          {/* the persistent bar */}
          <div className="flex items-center gap-2 px-3 py-2.5 sm:px-4">
            <Button
              variant="ghost"
              size="sm"
              onClick={() => setOpen((v) => !v)}
              aria-expanded={open}
              aria-controls="shortlist-items"
              className="text-sm"
            >
              <ChevronDown
                aria-hidden
                className={cn("size-4 text-muted motion-safe:transition-transform motion-safe:duration-200 motion-safe:ease-out", open && "rotate-180")}
              />
              Shortlist <span className="tabular-nums text-brand-text">({n})</span>
            </Button>

            {open && (
              <Button variant="ghost" size="sm" onClick={onClear} className="text-faint">
                Clear
              </Button>
            )}

            <div className="ml-auto flex items-center gap-2">
              {prep.running ? (
                <span className="inline-flex items-center gap-2 text-xs text-muted">
                  <Loader2 aria-hidden className="size-3.5 text-brand motion-safe:animate-spin" />
                  <span className="max-w-64 truncate">{prep.label || "Preparing…"}</span>
                </span>
              ) : confirming === "score" ? (
                <ConfirmScore n={n} costText={costText} hasCli={hasCli} onCancel={() => setConfirming(null)} onConfirm={() => { setConfirming(null); onScore(); }} />
              ) : confirming === "prepare" ? (
                <ConfirmPrepare n={n} costText={prepCostText} batchText={batchLine(batch)} hasCli={hasCli} onCancel={() => setConfirming(null)} onConfirm={() => { setConfirming(null); onPrepare(); }} />
              ) : (
                <>
                  <Button variant="soft" onClick={() => setConfirming("prepare")}>
                    <FileText aria-hidden className="size-4" />
                    <span>Prepare {n}</span>
                    <span className="hidden text-xs font-normal sm:inline">· {batchLine(batch)} · {prepCostText}</span>
                  </Button>
                  <Button onClick={() => setConfirming("score")}>
                    <Sparkles aria-hidden className="size-4" />
                    <span>Score {n}</span>
                    <span className="hidden text-xs font-normal sm:inline">· {costText}</span>
                  </Button>
                </>
              )}
            </div>
          </div>

          {/* cost line — always visible on mobile (where it doesn't fit in the buttons) */}
          <div className="flex items-center gap-2 border-t border-border/60 px-3 py-1.5 text-2xs text-muted sm:hidden">
            <CostBadge kind="spend" size="xs" />
            <span>Score {costText} · Prepare {prepCostText} — the only steps that spend</span>
          </div>

          {/* finished-batch summary (latched from the stream's done/error event) */}
          {!prep.running && prep.label && (
            <div role="status" className="border-t border-border/60 px-3 py-1.5 text-2xs text-muted sm:px-4">
              {prep.label}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

// Shown in place of either confirm when no agent CLI is configured.
function NoCli({ onCancel }: { onCancel: () => void }) {
  return (
    <div className="flex items-center gap-2 text-xs">
      <span className="text-muted">No AI configured.</span>
      <Link href="/config" className={buttonVariants({ variant: "soft", size: "sm" })}>
        <Settings aria-hidden className="size-3.5" /> Set up
      </Link>
      <Button variant="ghost" size="sm" onClick={onCancel} className="text-faint">
        Cancel
      </Button>
    </div>
  );
}

function ConfirmScore({
  n,
  costText,
  hasCli,
  onCancel,
  onConfirm,
}: {
  n: number;
  costText: string;
  hasCli: boolean;
  onCancel: () => void;
  onConfirm: () => void;
}) {
  if (!hasCli) return <NoCli onCancel={onCancel} />;
  return (
    <div className="flex items-center gap-2">
      <span className="hidden items-center gap-1 text-2xs text-muted sm:inline-flex">
        <Coins aria-hidden className="size-3.5 text-brand" /> {costText}
      </span>
      <Button onClick={onConfirm}>Score {n} now</Button>
      <Button variant="ghost" size="sm" onClick={onCancel} className="text-faint">
        Cancel
      </Button>
    </div>
  );
}

// Two-step confirm for "Prepare N" — mirrors ConfirmScore exactly: batch
// characterization + cost are on screen before the confirming click (never spend
// by surprise). Preparation drafts a tailored CV + form answers per application
// and stamps them "awaiting review"; submission stays manual, per application.
function ConfirmPrepare({
  n,
  costText,
  batchText,
  hasCli,
  onCancel,
  onConfirm,
}: {
  n: number;
  costText: string;
  batchText: string;
  hasCli: boolean;
  onCancel: () => void;
  onConfirm: () => void;
}) {
  if (!hasCli) return <NoCli onCancel={onCancel} />;
  if (n > PREPARE_MAX) {
    return (
      <div className="flex items-center gap-2 text-xs">
        <span className="text-muted">Max {PREPARE_MAX} per batch — trim the shortlist first.</span>
        <Button variant="ghost" size="sm" onClick={onCancel} className="text-faint">
          Cancel
        </Button>
      </div>
    );
  }
  return (
    <div className="flex items-center gap-2">
      <span className="hidden items-center gap-1 text-2xs text-muted sm:inline-flex">
        <Coins aria-hidden className="size-3.5 text-brand" /> {batchText} · {costText}
      </span>
      <Button onClick={onConfirm}>Prepare {n} now</Button>
      <Button variant="ghost" size="sm" onClick={onCancel} className="text-faint">
        Cancel
      </Button>
    </div>
  );
}
