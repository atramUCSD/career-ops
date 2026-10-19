"use client";

import { useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { AnimatePresence, motion } from "motion/react";
import { ChevronsRight, Search, Table2 } from "lucide-react";
import type { Application } from "@/lib/career-ops";
import type { CadenceEntry } from "@/lib/followups";
import { buttonVariants } from "@/components/ui/button";
import { Input } from "@/components/ui/field";
import { layoutMove, listItem } from "@/components/ui/motion";
import { CompanyLogo } from "@/components/company-logo";
import { scoreNum } from "@/lib/format";
import { cn } from "@/lib/cn";
import { companyPresentation, companySearchText } from "@/lib/company-presentation.mjs";
import { BOARD_COLUMNS, boardColumn, distinctTitles, titleKey } from "@/lib/board-columns.mjs";
import { CardPanel } from "./card-panel";

type Filter = "all" | "due" | "cold";
type BoardCard = { key: string; app: Application; status: string; lane: string | null; fu?: CadenceEntry };

const isDue = (fu?: CadenceEntry) => fu?.urgency === "urgent" || fu?.urgency === "overdue";

export function BoardView({ applications, skipped }: { applications: Application[]; skipped: string[] }) {
  const router = useRouter();
  // Optimistic lane per tracker row while /api/status runs. An entry is dropped
  // once the refreshed tracker agrees with it, so a second in-flight move is not
  // snapped back by the first one's refresh.
  const [overrides, setOverrides] = useState<Record<string, string>>({});
  const [followups, setFollowups] = useState<Map<string, CadenceEntry>>(new Map());
  const [error, setError] = useState<string | null>(null);
  const [filter, setFilter] = useState<Filter>("all");
  const [q, setQ] = useState("");
  const [showRejected, setShowRejected] = useState(false);
  const [dragOver, setDragOver] = useState<string | null>(null);
  const [openKey, setOpenKey] = useState<string | null>(null);
  const [showSkipped, setShowSkipped] = useState(false);
  const skipSet = useMemo(() => new Set(skipped), [skipped]);
  const titles = useMemo(() => distinctTitles(applications), [applications]);

  useEffect(() => {
    setOverrides((o) =>
      Object.fromEntries(Object.entries(o).filter(([n, s]) => applications.find((a) => a.n === n)?.status !== s)),
    );
  }, [applications]);

  // Cadence is the core's verdict (followup-cadence.mjs); refetched with the
  // tracker because a status move changes which rule applies.
  useEffect(() => {
    let live = true;
    fetch("/api/followups?full=1")
      .then((r) => r.json())
      .then((j: { entries?: CadenceEntry[] }) => {
        if (live) setFollowups(new Map((j.entries ?? []).map((e) => [String(e.num), e])));
      })
      .catch(() => {}); // badges are an enhancement; the board works without them
    return () => {
      live = false;
    };
  }, [applications]);

  const cards = useMemo(() => {
    const seen = new Map<string, number>();
    return applications.map((app): BoardCard => {
      // Keyed by tracker # plus occurrence: the tracker can repeat a number.
      const k = (seen.get(app.n) ?? 0) + 1;
      seen.set(app.n, k);
      const status = overrides[app.n] ?? app.status;
      return { key: `${app.n}-${k}`, app, status, lane: boardColumn(status), fu: followups.get(app.n) };
    });
  }, [applications, overrides, followups]);

  // Evaluator said Skip and the card has not moved past Apply: parked behind a
  // toggle so the Apply lane is the real queue. Once moved, it shows normally.
  const isParked = (c: BoardCard) => c.lane === "apply" && skipSet.has(c.app.n);
  const parked = cards.filter(isParked).length;
  const onBoard = cards.filter((c) => c.lane && (showSkipped || !isParked(c)));
  const visible = onBoard.filter((c) => {
    if (filter === "due" && !isDue(c.fu)) return false;
    if (filter === "cold" && c.fu?.urgency !== "cold") return false;
    return !q.trim() || companySearchText(c.app).toLowerCase().includes(q.toLowerCase());
  });
  const active = onBoard.filter((c) => c.lane !== "rejected" && !isParked(c)).length;
  const due = onBoard.filter((c) => isDue(c.fu)).length;
  const cold = onBoard.filter((c) => c.fu?.urgency === "cold").length;
  const offBoard = cards.filter((c) => !c.lane).length;

  async function move(n: string, status: string): Promise<boolean> {
    const prev = overrides[n];
    const from = prev ?? applications.find((a) => a.n === n)?.status ?? "";
    setOverrides((o) => ({ ...o, [n]: status }));
    setError(null);
    try {
      const res = await fetch("/api/status", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ n, status }),
      });
      if (!res.ok) {
        const j = (await res.json().catch(() => null)) as { error?: string } | null;
        throw new Error(j?.error ?? "status update failed");
      }
      // The status write already landed; a lost activity line is not worth an error.
      fetch(`/api/board/${n}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ kind: "move", from, to: status }),
      }).catch(() => {});
      router.refresh();
      return true;
    } catch (e) {
      setOverrides((o) => {
        const next = { ...o };
        if (prev === undefined) delete next[n];
        else next[n] = prev;
        return next;
      });
      setError(`#${n}: ${(e as Error).message}`);
      return false;
    }
  }

  const openCard = cards.find((c) => c.key === openKey);

  function drop(laneId: string, e: React.DragEvent) {
    e.preventDefault();
    setDragOver(null);
    const n = e.dataTransfer.getData("text/plain");
    const col = BOARD_COLUMNS.find((c) => c.id === laneId);
    const card = cards.find((c) => c.app.n === n);
    // Same lane is a no-op: dropping a Hired card back on Offer must not demote it.
    if (col && card && card.lane !== laneId) move(n, col.status);
  }

  const laneDrop = (id: string) => ({
    onDragOver: (e: React.DragEvent) => {
      e.preventDefault();
      if (dragOver !== id) setDragOver(id);
    },
    onDragLeave: (e: React.DragEvent) => {
      if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setDragOver(null);
    },
    onDrop: (e: React.DragEvent) => drop(id, e),
  });

  const chips: { id: Filter; label: string; count: number }[] = [
    { id: "all", label: "All", count: onBoard.length },
    { id: "due", label: "Due", count: due },
    { id: "cold", label: "Cold", count: cold },
  ];

  return (
    // Full width, not max-w-6xl: six lanes need the room, and the lane row
    // scrolls horizontally when the viewport cannot fit them.
    <div className="px-4 py-6 sm:px-6 sm:py-8 max-sm:pb-24">
      <div className="mb-6 flex flex-wrap items-end justify-between gap-4">
        <div>
          <h1 className="font-display text-2xl tracking-tight text-landing">Board</h1>
          <p className="mt-1 text-sm text-muted">
            <span className="tabular-nums">{active}</span> active · <span className="tabular-nums">{due}</span> follow-ups due
            {offBoard > 0 && (
              <>
                {" "}
                ·{" "}
                <Link href="/pipeline?tab=ALL" className="rounded-md focus-ring hover:text-foreground">
                  <span className="tabular-nums">{offBoard}</span> discarded or skipped
                </Link>
              </>
            )}
          </p>
        </div>
        <div className="flex items-center gap-2">
          <Link href="/pipeline?tab=ALL" className={buttonVariants({ variant: "secondary", size: "md" })}>
            <Table2 aria-hidden className="size-4" /> Table
          </Link>
          <div className="relative w-64 max-w-[50vw]">
            <Search aria-hidden className="pointer-events-none absolute left-3 top-1/2 z-10 size-4 -translate-y-1/2 text-faint" />
            <Input
              type="search"
              value={q}
              onChange={(e) => setQ(e.target.value)}
              placeholder="Search company or role…"
              aria-label="Search company or role"
              className="pl-9"
            />
          </div>
        </div>
      </div>

      <div className="mb-4 flex flex-wrap items-center gap-2" role="group" aria-label="Filter cards">
        {chips.map((c) => (
          <button
            key={c.id}
            type="button"
            aria-pressed={filter === c.id}
            onClick={() => setFilter(c.id)}
            className={cn(
              "inline-flex items-center gap-1.5 rounded-md border px-2 py-0.5 text-sm focus-ring transition-colors duration-150 ease-out max-sm:min-h-11",
              filter === c.id
                ? "border-brand/40 bg-brand-soft text-brand-text"
                : "border-border text-muted hover:text-foreground",
            )}
          >
            {c.label} <span className="tabular-nums">{c.count}</span>
          </button>
        ))}
        {error && (
          <p role="alert" className="text-sm text-bad-text">
            {error}
          </p>
        )}
      </div>

      {/* Viewport-tall row: lanes scroll inside themselves, so lane headers and
          empty drop targets stay in view while dragging from deep in a lane. */}
      <div className="flex h-[calc(100dvh-16rem)] min-h-96 items-stretch gap-3 overflow-x-auto pb-2 max-sm:h-[calc(100dvh-24.5rem)] max-sm:snap-x max-sm:snap-mandatory">
        {BOARD_COLUMNS.map((col) => {
          // Best score first: the lane is a queue, and the top card is the next one to act on.
          const laneCards = visible
            .filter((c) => c.lane === col.id)
            .sort((a, b) => (scoreNum(b.app.score) || 0) - (scoreNum(a.app.score) || 0));
          const total = onBoard.filter((c) => c.lane === col.id).length;
          if (col.id === "rejected" && !showRejected) {
            return (
              <button
                key={col.id}
                type="button"
                {...laneDrop(col.id)}
                onClick={() => setShowRejected(true)}
                aria-label={`Show ${total} rejected`}
                className={cn(
                  "flex w-14 shrink-0 flex-col items-center gap-3 rounded-xl border border-dashed py-4 text-muted focus-ring transition-colors duration-150 ease-out hover:text-foreground",
                  dragOver === col.id ? "border-bad/50 bg-bad-soft" : "border-border",
                )}
              >
                <span aria-hidden className="size-1.5 rounded-full bg-bad" />
                <span className="text-sm font-semibold tabular-nums">{total}</span>
                <span className="text-xs font-medium [writing-mode:vertical-rl]">{col.label}</span>
              </button>
            );
          }
          return (
            <section
              key={col.id}
              aria-label={col.label}
              {...laneDrop(col.id)}
              className={cn(
                "flex min-h-0 min-w-48 flex-1 max-sm:w-[85vw] max-sm:flex-none max-sm:snap-start flex-col rounded-xl border bg-surface/40 transition-colors duration-150 ease-out",
                dragOver === col.id ? "border-brand/40 bg-brand-soft/40" : "border-border",
              )}
            >
              <header className="flex items-center gap-2 px-3 pt-3 pb-2">
                <span aria-hidden className={cn("size-1.5 rounded-full", LANE_DOT[col.id])} />
                <h2 className="truncate text-sm font-semibold text-foreground" title={col.hint}>
                  {col.label}
                </h2>
                <span className="text-sm tabular-nums text-faint">{total}</span>
                {col.id === "apply" && parked > 0 && (
                  <button
                    type="button"
                    aria-pressed={showSkipped}
                    onClick={() => setShowSkipped((v) => !v)}
                    title="Cards the evaluator marked Skip"
                    className="ml-auto shrink-0 rounded-md px-1.5 py-0.5 text-xs whitespace-nowrap text-muted focus-ring transition-colors duration-150 ease-out hover:text-foreground max-sm:min-h-11"
                  >
                    {showSkipped ? "Hide skipped" : <span className="tabular-nums">+{parked} skipped</span>}
                  </button>
                )}
                {col.id === "rejected" && (
                  <button
                    type="button"
                    onClick={() => setShowRejected(false)}
                    aria-label="Collapse rejected"
                    className="ml-auto rounded-md p-1 text-faint focus-ring hover:text-foreground"
                  >
                    <ChevronsRight aria-hidden className="size-4" />
                  </button>
                )}
              </header>
              <div className="relative flex min-h-0 flex-1 flex-col gap-2 overflow-y-auto px-2 pb-2 [scrollbar-width:thin]">
                <AnimatePresence initial={false} mode="popLayout">
                  {laneCards.map((c) => (
                    <motion.div key={c.key} layout="position" {...listItem} transition={{ ...listItem.transition, layout: layoutMove }}>
                      <JobCard
                        card={c}
                        split={titles.get(titleKey(c.app.company, c.app.role))}
                        muted={isParked(c) || c.lane === "rejected"}
                        onOpen={() => setOpenKey(c.key)}
                      />
                    </motion.div>
                  ))}
                </AnimatePresence>
                {laneCards.length === 0 && (
                  <p className="rounded-xl border border-dashed border-border px-3 py-6 text-center text-xs text-faint">
                    {total > 0 ? "No matches" : col.hint ? `${col.hint}. Drag a card here` : "Drag a card here"}
                  </p>
                )}
              </div>
            </section>
          );
        })}
      </div>
      {openCard && (
        <CardPanel
          key={openCard.key}
          app={openCard.app}
          status={openCard.status}
          fu={openCard.fu}
          onMove={move}
          onClose={() => setOpenKey(null)}
        />
      )}
    </div>
  );
}

const LANE_DOT: Record<string, string> = {
  apply: "bg-faint",
  applied: "bg-info",
  consideration: "bg-info",
  interviewing: "bg-good",
  offer: "bg-good",
  rejected: "bg-bad",
};

function JobCard({
  card,
  split,
  muted,
  onOpen,
}: {
  card: BoardCard;
  split?: { stem: string; tail: string };
  muted: boolean;
  onOpen: () => void;
}) {
  const { app } = card;
  const company = companyPresentation(app);
  return (
    // An article with button semantics, not a <button>: Firefox will not start a
    // native drag from a button element.
    <article
      draggable
      role="button"
      tabIndex={0}
      aria-label={`${company.label}: ${app.role}`}
      title={app.role}
      onClick={onOpen}
      onKeyDown={(e) => {
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          onOpen();
        }
      }}
      onDragStart={(e) => {
        e.dataTransfer.setData("text/plain", app.n);
        e.dataTransfer.effectAllowed = "move";
      }}
      className={cn(
        "group shrink-0 cursor-grab rounded-xl border border-border bg-surface p-3 focus-ring transition-colors duration-150 ease-out hover:border-brand/40 active:cursor-grabbing",
        muted && "bg-surface/60",
      )}
    >
      <div className="flex items-center gap-2">
        <CompanyLogo name={company.logoName} size={20} />
        <span className="min-w-0 flex-1 truncate text-sm text-muted">{company.label}</span>
      </div>
      <div
        className={cn(
          "mt-1.5 text-sm font-semibold leading-snug group-hover:text-brand-text",
          muted ? "text-muted" : "text-foreground",
        )}
      >
        {/* A near-twin of another role at this company: the stem clamps to one
            line and the distinguishing tail always gets its own. */}
        {split ? (
          <>
            <p className="truncate">{split.stem}</p>
            <p className="line-clamp-2">{split.tail}</p>
          </>
        ) : (
          <p className="line-clamp-2">{app.role}</p>
        )}
      </div>
    </article>
  );
}
