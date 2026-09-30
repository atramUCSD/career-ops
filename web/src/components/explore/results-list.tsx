"use client";

import { useMemo, useState } from "react";
import { Search, Plus } from "lucide-react";
import { cn } from "@/lib/cn";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/field";
import type { DiscoveredOffer } from "@/lib/explore";
import { CostBadge } from "@/components/cost/cost-badge";
import { DiscoveryCard } from "./discovery-card";
import { useExplore } from "./explore-provider";

export type EnrichedOffer = DiscoveredOffer & { inPipeline: boolean; evaluatedN?: string };

export function ResultsList({ offers }: { offers: EnrichedOffer[] }) {
  const { companiesScanned, partial, addToPipeline, added, mode, running } = useExplore();
  const isAi = mode === "ai";
  const [sort, setSort] = useState<"fresh" | "company">("fresh");
  const [q, setQ] = useState("");

  const view = useMemo(() => {
    const needle = q.trim().toLowerCase();
    let list = offers;
    if (needle) list = list.filter((o) => o.title.toLowerCase().includes(needle) || o.company.toLowerCase().includes(needle));
    const sorted = [...list].sort((a, b) =>
      sort === "fresh" ? (b.postedAt || "").localeCompare(a.postedAt || "") : a.company.localeCompare(b.company),
    );
    return sorted;
  }, [offers, q, sort]);

  const addable = offers.filter((o) => !o.inPipeline && !o.evaluatedN && !added.has(o.url));

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-3">
        <div>
          <h2 className="text-sm text-foreground">
            <span className="font-semibold">{offers.length}</span> {isAi ? `candidate${offers.length === 1 ? "" : "s"}` : `fresh role${offers.length === 1 ? "" : "s"}`}
            <CostBadge kind={isAi ? "spend" : "free-network"} size="xs" className="ml-2 align-middle" />
          </h2>
          <p className="text-xs text-faint">
            {isAi
              ? "found by AI on the open web · unverified until you evaluate"
              : `${companiesScanned > 0 ? `${companiesScanned.toLocaleString()} companies scanned · ` : ""}0 tokens spent${partial ? " · some boards were unreachable (normal for public directories)" : ""}`}
          </p>
        </div>

        <div className="ml-auto flex flex-wrap items-center gap-2">
          <div className="relative">
            <Search aria-hidden className="pointer-events-none absolute top-1/2 left-2 z-[1] size-3.5 -translate-y-1/2 text-faint" />
            <Input
              size="sm"
              aria-label="Filter results"
              value={q}
              onChange={(e) => setQ(e.target.value)}
              placeholder="Filter results…"
              className="w-40 pl-7 max-sm:h-11"
            />
          </div>
          <div role="group" aria-label="Sort results" className="inline-flex rounded-xl border border-border bg-surface p-0.5 text-xs">
            {(["fresh", "company"] as const).map((s) => (
              <button
                key={s}
                type="button"
                aria-pressed={sort === s}
                onClick={() => setSort(s)}
                className={cn(
                  "rounded-md px-2.5 py-1 font-medium capitalize focus-ring transition-colors duration-150 ease-out max-sm:min-h-11",
                  sort === s ? "bg-brand-soft text-brand-text" : "text-muted hover:text-foreground",
                )}
              >
                {s}
              </button>
            ))}
          </div>
          {addable.length > 1 && (
            <Button variant="secondary" size="sm" onClick={() => addToPipeline(addable)}>
              <Plus aria-hidden className="size-3.5" /> Add all {addable.length}
            </Button>
          )}
        </div>
      </div>

      <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-3">
        {view.map((o) => (
          <DiscoveryCard key={o.url} offer={o} inPipeline={o.inPipeline} evaluatedN={o.evaluatedN} />
        ))}
      </div>

      {view.length === 0 && (q.trim() || !running) && (
        <p className="py-10 text-center text-sm text-faint">No results match “{q}”.</p>
      )}
    </div>
  );
}
