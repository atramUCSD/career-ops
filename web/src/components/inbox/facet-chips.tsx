"use client";

import { Search, X } from "lucide-react";
import type { AtsSource } from "@/lib/explore";
import { ATS_LABEL } from "@/lib/explore";
import { FRESHNESS_WINDOWS, SENIORITY_LABEL, type Seniority } from "@/lib/inbox";
import { CostBadge } from "@/components/cost/cost-badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/field";
import { cn } from "@/lib/cn";

// Free, client-side facets over the raw firehose — 0 tokens, instant. Mirrors the
// Explore chip language so the two surfaces read as one system. On mobile the chip
// row scrolls INSIDE its own container (never the page), so its controls use the
// inset focus ring.
export function FacetChips({
  within,
  setWithin,
  sources,
  toggleSource,
  seniorities,
  toggleSeniority,
  locQ,
  setLocQ,
  kw,
  setKw,
  availSources,
  availSeniorities,
  resultCount,
  totalCount,
  anyActive,
  onClear,
}: {
  within: number | null;
  setWithin: (d: number | null) => void;
  sources: Set<AtsSource>;
  toggleSource: (s: AtsSource) => void;
  seniorities: Set<Seniority>;
  toggleSeniority: (s: Seniority) => void;
  locQ: string;
  setLocQ: (v: string) => void;
  kw: string;
  setKw: (v: string) => void;
  availSources: AtsSource[];
  availSeniorities: Seniority[];
  resultCount: number;
  totalCount: number;
  anyActive: boolean;
  onClear: () => void;
}) {
  return (
    <div className="space-y-2.5">
      {/* keyword search + live count */}
      <div className="flex items-center gap-3">
        <div className="relative flex-1">
          <Search aria-hidden className="pointer-events-none absolute left-3 top-1/2 z-10 size-4 -translate-y-1/2 text-faint" />
          <Input
            value={kw}
            onChange={(e) => setKw(e.target.value)}
            placeholder="Filter by company or role…"
            aria-label="Filter by company or role"
            className="bg-surface/60 pl-9 max-sm:min-h-11"
          />
        </div>
        <span className="shrink-0 text-xs text-muted">
          <span className="tabular-nums text-foreground">{resultCount}</span>
          <span className="text-faint">/{totalCount}</span>
        </span>
      </div>

      {/* chip row — desktop wraps, mobile scrolls inside the container */}
      <div className="flex items-center gap-2 overflow-x-auto pb-1 max-sm:pr-6 max-sm:[mask-image:linear-gradient(to_right,#000_85%,transparent)] sm:flex-wrap sm:overflow-visible sm:pb-0">
        {/* freshness (single-select segmented; click active to clear) */}
        <div role="group" aria-label="Posted within" className="inline-flex shrink-0 rounded-full border border-border bg-surface/40 p-0.5 max-sm:p-0">
          {FRESHNESS_WINDOWS.map((w) => (
            <button
              key={w.days}
              type="button"
              onClick={() => setWithin(within === w.days ? null : w.days)}
              aria-pressed={within === w.days}
              className={cn(
                "rounded-full px-2.5 py-1 text-xs font-medium focus-ring-inset transition-colors duration-150 ease-out max-sm:min-h-11",
                within === w.days ? "bg-brand-soft text-brand-text" : "text-muted hover:text-foreground",
              )}
            >
              {w.label}
            </button>
          ))}
        </div>

        {availSources.map((s) => (
          <Pill key={s} on={sources.has(s)} onClick={() => toggleSource(s)}>
            {ATS_LABEL[s]}
          </Pill>
        ))}

        {availSeniorities.map((s) => (
          <Pill key={s} on={seniorities.has(s)} onClick={() => toggleSeniority(s)}>
            {SENIORITY_LABEL[s]}
          </Pill>
        ))}

        {/* location contains */}
        <div className="shrink-0">
          <Input
            size="sm"
            value={locQ}
            onChange={(e) => setLocQ(e.target.value)}
            placeholder="location…"
            aria-label="Filter by location"
            className="w-28 rounded-full bg-surface/40 px-3 max-sm:min-h-11"
          />
        </div>

        {anyActive && (
          <Button variant="ghost" size="sm" onClick={onClear} className="shrink-0 gap-1 text-faint focus-ring-inset">
            <X aria-hidden className="size-3" /> Clear
          </Button>
        )}
      </div>

      {/* Token-honesty is bidirectional: the "free" reassurance is as always-visible
          as the tray's "spend" cue (mobile + desktop) — never desktop-only. */}
      <div className="flex items-center gap-1.5">
        <CostBadge kind="free" size="xs" />
        <span className="text-2xs text-faint">Filtering is free — only scoring uses tokens.</span>
      </div>
    </div>
  );
}

// Custom toggle chip: rounded-full is the section-5 exception for facet chips.
function Pill({ on, onClick, children }: { on: boolean; onClick: () => void; children: React.ReactNode }) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-pressed={on}
      className={cn(
        "shrink-0 rounded-full border px-2.5 py-1 text-xs font-medium focus-ring-inset transition-colors duration-150 ease-out max-sm:min-h-11",
        on ? "border-brand/40 bg-brand-soft text-brand-text" : "border-border text-muted hover:text-foreground",
      )}
    >
      {children}
    </button>
  );
}
