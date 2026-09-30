"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { Compass, ChevronDown, RotateCcw, AlertTriangle, Sparkles, Settings } from "lucide-react";
import Link from "next/link";
import { cn } from "@/lib/cn";
import { Button, buttonVariants } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import type { Application, InboxJob } from "@/lib/career-ops";
import { normalizeTextKey } from "@/lib/core/normalize-text-key.mjs";
import { paramsToFilters, paramsToAi, type ExploreFilters } from "@/lib/explore";
import { FilterBuilder } from "./filter-builder";
import { DiscoveringState } from "./discovering-state";
import { AiHuntView } from "./ai-hunt-view";
import { ExploreModeToggle } from "./explore-mode-toggle";
import { AiSearchBox } from "./ai-search-box";
import { ResultsList, type EnrichedOffer } from "./results-list";
import { useExplore } from "./explore-provider";

// Same shape as core normalizeTextKey(s, " ") — never [^a-z0-9] (#2666).
const norm = (s: string) => normalizeTextKey(s, " ");
const CLI_NAMES: Record<string, string> = {
  claude: "Claude Code",
  codex: "Codex",
  gemini: "Gemini CLI",
  opencode: "OpenCode",
  copilot: "Copilot CLI",
  qwen: "Qwen CLI",
  antigravity: "Antigravity CLI",
};

export function ExplorerView({
  seed,
  inboxSnapshot,
  appsSnapshot,
  rootExists,
}: {
  seed: { filters: ExploreFilters; seededFrom: string[] };
  inboxSnapshot: InboxJob[];
  appsSnapshot: Application[];
  rootExists: boolean;
}) {
  const { filters, setFilters, initFilters, phase, running, offers, discover, loadFresh, status, error, scannerMissing, mode, setMode, aiIntent, setAiIntent, discoverAI, companiesScanned, companiesAvailable, capHit, droppedNoDate, partial } = useExplore();
  const scanNote =
    companiesScanned > 0
      ? `Scanned ${companiesScanned.toLocaleString()}${companiesAvailable > companiesScanned ? ` of ${companiesAvailable.toLocaleString()}` : ""} compan${companiesScanned === 1 ? "y" : "ies"}${partial ? " · some sources were unreachable" : ""}.`
      : undefined;
  const inited = useRef(false);
  const [refineOpen, setRefineOpen] = useState(false);
  const [cli, setCli] = useState<{ id: string | null; name?: string }>({ id: null });
  const [firstRun, setFirstRun] = useState(false);
  // SSR renders the provider's empty defaults; show the seed until init runs so
  // the filter chips don't grow in after hydration (CLS).
  const [ready, setReady] = useState(false);
  const shownFilters =
    !ready && filters.positive.length === 0 && filters.negative.length === 0 ? seed.filters : filters;

  useEffect(() => {
    try {
      const id = JSON.parse(localStorage.getItem("career-ops:config") || "{}").cliId || null;
      setCli({ id, name: id ? CLI_NAMES[id] || id : undefined });
    } catch {
      setCli({ id: null });
    }
  }, []);

  // Initialize once from the URL (shareable search) or the server seed — without
  // clobbering anything the assistant set before this mount.
  useEffect(() => {
    if (inited.current) return;
    inited.current = true;
    const sp = new URLSearchParams(window.location.search);
    const ai = paramsToAi(sp);
    if (ai !== null) {
      setMode("ai");
      setAiIntent(ai);
    } else if (sp.get("view") === "fresh") {
      // Today's "See all N" (#84) hands off here instead of a bare config form —
      // load the SAME /api/whats-new offers it already showed, through the normal
      // results-phase UI. The config form (Refine search / Re-cast) stays reachable.
      // Force scan mode: a session restored in "ai" mode (sessionStorage rehydrate)
      // must not show the AI-search UI for this scan-only hand-off.
      setMode("scan");
      initFilters(seed.filters);
      void loadFresh();
    } else {
      initFilters(sp.toString() ? paramsToFilters(sp) : seed.filters);
      // Onboarding hand-off: ?run=1 auto-fires the free scan + flags the first-run
      // banner (the "matches found from your CV, free" reveal).
      if (sp.get("run") === "1") {
        setFirstRun(true);
        void discover();
      }
    }
    setReady(true);
  }, [seed.filters, initFilters, setMode, setAiIntent, discover, loadFresh]);

  const inboxUrls = useMemo(() => new Set(inboxSnapshot.map((j) => j.url)), [inboxSnapshot]);
  const enriched: EnrichedOffer[] = useMemo(
    () =>
      offers.map((o) => {
        const inPipeline = inboxUrls.has(o.url);
        const c = norm(o.company);
        const t = norm(o.title);
        const ev = appsSnapshot.find((a) => {
          if (norm(a.company) !== c) return false;
          const ar = norm(a.role);
          return ar.length > 3 && (t.includes(ar) || ar.includes(t.split(" ").slice(0, 3).join(" ")));
        });
        return { ...o, inPipeline, evaluatedN: ev?.n };
      }),
    [offers, inboxUrls, appsSnapshot],
  );

  const isAi = mode === "ai";
  const isResults = phase === "results";
  const canDiscover = filters.ats.length > 0;
  const scanRunning = running && !isAi;
  // Keep one ResultsList mounted across scanning → revealing → results so
  // filter/sort/scroll and co-rise survive the 850ms reveal handoff.
  const showScanList = !isAi && offers.length > 0 && (scanRunning || isResults);

  if (running && isAi)
    return (
      <>
        <h1 className="sr-only">Explore</h1>
        <AiHuntView cliName={cli.name} />
      </>
    );

  return (
    <div className={scanRunning ? undefined : "mx-auto max-w-6xl px-4 py-6 sm:px-6 sm:py-8 max-sm:pb-24"}>
      {scanRunning && <h1 className="sr-only">Explore</h1>}
      {scanRunning && <DiscoveringState />}
      {!scanRunning && (
        <>
      <header className="mb-6">
        <div className="flex flex-wrap items-center gap-3">
          <div className="flex items-center gap-2.5">
            <Compass aria-hidden className="size-6 text-brand" />
            <h1 className="font-display text-2xl tracking-tight text-landing">Explore</h1>
            <span className="eyebrow rounded-md border border-brand/30 bg-brand-soft px-2 py-0.5 text-2xs font-bold text-brand-text">New</span>
          </div>
          <div className="w-full sm:ml-auto sm:w-auto">
            <ExploreModeToggle mode={mode} onChange={setMode} cliConfigured={!!cli.id} />
          </div>
        </div>
        {!isResults && (
          <p className="mt-3 max-w-2xl text-base leading-relaxed text-muted">
            {isAi
              ? "Describe the role in plain language — an AI hunts the open web for it, on your own AI. Candidates are unverified until you evaluate."
              : "Scan the public ATS network — Greenhouse, Lever, Ashby, Workday. Fresh postings matched to you, zero tokens. You only spend when you choose to evaluate one."}
          </p>
        )}
      </header>

      {!rootExists && (
        <Card tone="warn" inset className="mb-6 flex items-start gap-2 text-sm text-foreground">
          <AlertTriangle aria-hidden className="mt-0.5 size-4 shrink-0 text-warn" />
          Your career-ops home isn’t set up yet — discovery needs a checkout with a profile to seed from.
        </Card>
      )}

      {isAi ? (
        phase === "blocked" ? (
          <BlockedCard />
        ) : (
          <div className="space-y-6">
            <AiSearchBox
              intent={aiIntent}
              onIntent={setAiIntent}
              onSubmit={() => void discoverAI()}
              cliConfigured={!!cli.id}
              cliName={cli.name}
              onRunScan={() => setMode("scan")}
            />
            {phase === "results" && <ResultsList offers={enriched} />}
            {phase === "empty-loose" && (
              <EmptyState
                tone="loose"
                title="No public matches — yet."
                body="AI search reads what's public. Try broader intent, or run the free Scan over the ATS network."
                onRerun={() => setMode("scan")}
                rerunLabel="Run the free Scan"
              />
            )}
            {phase === "failed" && <FailedCard msg={error || status} scannerMissing={scannerMissing} onRetry={() => void discoverAI()} />}
          </div>
        )
      ) : (
        <>
          {isResults ? (
            <Card inset className="mb-6 p-0">
              <button
                type="button"
                aria-expanded={refineOpen}
                onClick={() => setRefineOpen((v) => !v)}
                className="flex w-full items-center gap-2 rounded-xl px-4 py-3 text-sm font-medium text-foreground focus-ring transition-colors duration-150 ease-out hover:bg-surface-hover max-sm:min-h-11"
              >
                <Compass aria-hidden className="size-4 text-brand" /> Refine search
                <ChevronDown
                  aria-hidden
                  className={cn("ml-auto size-4 text-muted motion-safe:transition-transform motion-safe:duration-200 motion-safe:ease-out", refineOpen && "rotate-180")}
                />
              </button>
              {refineOpen && (
                <div className="space-y-4 border-t border-border p-4">
                  <FilterBuilder filters={shownFilters} onChange={setFilters} seededFrom={seed.seededFrom} />
                  <DiscoverBar canDiscover={canDiscover} onDiscover={discover} label="Re-cast (free)" />
                </div>
              )}
            </Card>
          ) : (
            <Card className="mb-6">
              <FilterBuilder filters={shownFilters} onChange={setFilters} seededFrom={seed.seededFrom} />
              <div className="mt-5">
                <DiscoverBar canDiscover={canDiscover} onDiscover={discover} label="Discover (free)" />
              </div>
            </Card>
          )}

          {isResults && firstRun && (
            <Card tone="good" inset className="mb-4 flex items-start gap-2.5">
              <Sparkles aria-hidden className="mt-0.5 size-4 shrink-0 text-brand-text" />
              <p className="text-sm leading-relaxed text-foreground">
                These are live roles that match your CV. <span className="text-brand-text">Nothing here cost you a token.</span> Pick the one you&apos;re most curious about — Evaluate it and I&apos;ll tell you exactly how you score, and why.
              </p>
            </Card>
          )}

          {isResults && capHit && (
            <CappedBanner companiesScanned={companiesScanned} companiesAvailable={companiesAvailable} onRefine={() => setRefineOpen(true)} />
          )}
        </>
      )}
      </>
      )}

      {showScanList && (
        <div className={scanRunning ? "relative z-[1] mx-auto max-w-6xl px-4 pb-10 sm:px-6 max-sm:pb-24" : undefined}>
          <ResultsList offers={enriched} />
        </div>
      )}

      {!scanRunning && !isAi && (
        <>
          {phase === "empty-current" && (
            <EmptyState
              tone="good"
              title="You're all caught up."
              body="Nothing new since your last scan. Your pipeline is current — that's the goal."
              note={scanNote}
              onRerun={() => {
                setFilters({ ...filters, sinceDays: Math.max(filters.sinceDays, 30) });
                void discover();
              }}
              rerunLabel="Look back 30 days"
            />
          )}
          {phase === "empty-loose" && (
            <EmptyState
              tone="loose"
              title="No fresh matches — yet."
              body="Discovery is free — loosen and re-cast as often as you want."
              note={scanNote}
              onRerun={() => {
                setFilters({ ...filters, sinceDays: 30, block: [], allow: [] });
                void discover();
              }}
              rerunLabel="Widen to 30 days · clear location"
            />
          )}
          {phase === "degraded" && (
            <DegradedCard
              onRetry={() => void discover()}
              companiesScanned={companiesScanned}
              companiesAvailable={companiesAvailable}
              capHit={capHit}
              droppedNoDate={droppedNoDate}
              partial={partial}
            />
          )}
          {phase === "failed" && <FailedCard msg={error || status} scannerMissing={scannerMissing} onRetry={() => void discover()} />}
        </>
      )}
    </div>
  );
}

function DiscoverBar({ canDiscover, onDiscover, label }: { canDiscover: boolean; onDiscover: () => void; label: string }) {
  return (
    <div className="flex flex-wrap items-center gap-3">
      <Button size="lg" disabled={!canDiscover} onClick={onDiscover} className="font-semibold">
        <Compass aria-hidden className="size-4" /> {label}
      </Button>
      <span className="inline-flex items-center gap-1.5 text-xs text-muted">
        <span aria-hidden className="size-1.5 rounded-full bg-good" />
        Evaluating a role later costs tokens. Discovering never does.
      </span>
    </div>
  );
}

function EmptyState({ tone, title, body, note, onRerun, rerunLabel }: { tone: "good" | "loose"; title: string; body: string; note?: string; onRerun: () => void; rerunLabel: string }) {
  return (
    <Card className="py-12 text-center">
      <div className={cn("mx-auto grid size-12 place-items-center rounded-full", tone === "good" ? "bg-good-soft text-brand-text" : "bg-brand-soft text-brand")}>
        <Sparkles aria-hidden className="size-6" />
      </div>
      <h2 className="mt-4 font-display text-lg text-foreground">{title}</h2>
      <p className="mx-auto mt-1.5 max-w-md text-sm text-muted">{body}</p>
      {note && <p className="mx-auto mt-1 max-w-md text-xs text-faint">{note}</p>}
      <Button variant="secondary" onClick={onRerun} className="mt-4">
        <RotateCcw aria-hidden className="size-4" /> {rerunLabel}
      </Button>
    </Card>
  );
}

function DegradedCard({
  onRetry,
  companiesScanned,
  companiesAvailable,
  capHit,
  droppedNoDate,
  partial,
}: {
  onRetry: () => void;
  companiesScanned: number;
  companiesAvailable: number;
  capHit: boolean;
  droppedNoDate: number;
  partial: boolean;
}) {
  // 0 results, but the scan was NOT a clean full search → never "all caught up".
  // Pick the most informative reason (authoritative when the scanner's --json mode
  // is available; otherwise the 0-companies fallback).
  let title = "The scan ran, but couldn’t reach any sources.";
  let body =
    "The public ATS directories didn’t respond — usually a transient network hiccup or rate-limit, so nothing could be searched. This isn’t “all caught up”; a retry in a moment usually clears it.";
  if (companiesScanned > 0 && capHit) {
    title = "No matches in the slice we searched.";
    body = `The scan is capped, so it only searched ${companiesScanned.toLocaleString()}${companiesAvailable > companiesScanned ? ` of ${companiesAvailable.toLocaleString()}` : ""} companies — not the whole network. Raise scan depth (Refine search) or narrow your roles, then re-cast to look deeper.`;
  } else if (companiesScanned > 0 && droppedNoDate > 0) {
    title = "Fresh-looking roles were skipped for missing dates.";
    body = `${droppedNoDate.toLocaleString()} posting${droppedNoDate === 1 ? "" : "s"} matched but had no clear publish date, so the freshness filter dropped them. Widening the time window often brings dated equivalents back.`;
  } else if (companiesScanned > 0 && partial) {
    title = "Some job boards were unreachable.";
    body = `The scan searched ${companiesScanned.toLocaleString()} companies, but one or more sources didn’t respond — so this is a partial result, not “all caught up”. A retry usually clears it.`;
  }
  return (
    <Card tone="warn" className="text-center">
      <AlertTriangle aria-hidden className="mx-auto size-6 text-warn" />
      <p className="mt-2 text-sm font-medium text-foreground">{title}</p>
      <p className="mx-auto mt-1 max-w-md text-sm text-muted">{body}</p>
      <Button variant="soft" onClick={onRetry} className="mt-3">
        <RotateCcw aria-hidden className="size-4" /> Retry the scan
      </Button>
    </Card>
  );
}

function CappedBanner({ companiesScanned, companiesAvailable, onRefine }: { companiesScanned: number; companiesAvailable: number; onRefine: () => void }) {
  // Results ARE present, but the scan was capped — tell the user there's more, so a
  // partial list never reads as "everything there is".
  return (
    <Card tone="warn" inset className="mb-4 flex flex-wrap items-center gap-x-3 gap-y-1.5 py-2.5 text-sm">
      <span className="text-foreground">
        Showing a capped slice — searched {companiesScanned.toLocaleString()}
        {companiesAvailable > companiesScanned ? ` of ${companiesAvailable.toLocaleString()}` : ""} companies.
      </span>
      <Button variant="ghost" size="sm" onClick={onRefine} className="-mx-2 text-brand-text">
        Raise scan depth to search deeper
      </Button>
    </Card>
  );
}

function FailedCard({ msg, scannerMissing, onRetry }: { msg: string; scannerMissing: boolean; onRetry: () => void }) {
  // The scanner-missing case (data-only / pre-scan-ats-full checkout) must NOT
  // offer a "Try again" that re-fails forever — give a real next step instead.
  // The caller decides this from the response body's SCANNER_MISSING code, never
  // from the error text and never from the bare 400: a runtime scan error ("The
  // scanner returned no readable output.") mentions the scanner too, and 400 is
  // a shared channel that also carries malformed-request and MODE_MISSING
  // failures. Neither may be misreported as a broken checkout.
  if (scannerMissing) {
    return (
      <Card className="py-10 text-center">
        <div className="mx-auto grid size-12 place-items-center rounded-full bg-brand-soft text-brand">
          <Compass aria-hidden className="size-6" />
        </div>
        <h2 className="mt-4 font-display text-lg text-foreground">Discovery needs the full toolkit</h2>
        <p className="mx-auto mt-1.5 max-w-md text-sm text-muted">
          Your career-ops home looks data-only or is on an older version. The free scanner ships with a complete checkout —
          update career-ops, or paste a job URL on the pipeline to evaluate it directly.
        </p>
        <div className="mt-4 flex flex-wrap justify-center gap-2">
          <Link href="/pipeline" className={buttonVariants()}>
            Open pipeline
          </Link>
          <Link href="/config" className={buttonVariants({ variant: "secondary" })}>
            Open Config
          </Link>
        </div>
      </Card>
    );
  }
  return (
    <Card tone="warn" className="text-center">
      <AlertTriangle aria-hidden className="mx-auto size-6 text-warn" />
      <p className="mt-2 text-sm font-medium text-foreground">Couldn’t finish the search.</p>
      <p className="mt-1 text-sm text-muted">{msg}</p>
      <Button variant="soft" onClick={onRetry} className="mt-3">
        <RotateCcw aria-hidden className="size-4" /> Try again
      </Button>
    </Card>
  );
}

function BlockedCard() {
  return (
    <Card className="py-12 text-center">
      <div className="mx-auto grid size-12 place-items-center rounded-full bg-brand-soft text-brand">
        <Sparkles aria-hidden className="size-6" />
      </div>
      <h2 className="mt-4 font-display text-lg text-foreground">AI search needs a CLI</h2>
      <p className="mx-auto mt-1.5 max-w-md text-sm text-muted">
        Connect Claude Code, Gemini, or any agent CLI — your key, your tokens, your machine. The free Scan stays available without one.
      </p>
      <Link href="/config" className={cn(buttonVariants(), "mt-4")}>
        <Settings aria-hidden className="size-4" /> Open Config
      </Link>
    </Card>
  );
}
