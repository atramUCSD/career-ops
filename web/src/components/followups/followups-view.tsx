"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { AnimatePresence, motion } from "motion/react";
import { CalendarClock, ChevronDown, ChevronRight, Loader2, Pin, Search, Trash2 } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Input } from "@/components/ui/field";
import { rowItem } from "@/components/ui/motion";
import { CompanyLogo } from "@/components/company-logo";
import { LogDialog } from "@/components/followups/log-dialog";
import { NextDateDialog } from "@/components/followups/next-date-dialog";
import { scoreTone } from "@/lib/format";
import {
  type CadenceEntry,
  type CadenceMetadata,
  type Urgency,
  daysHeatClass,
  followupStatusTone,
  oxfordJoin,
  relativeDays,
  urgencyRank,
  urgencyTone,
} from "@/lib/followups";
import { cn } from "@/lib/cn";

// The /followups tracker: WHO needs a nudge today, HOW urgent, WHEN the next
// touch is due, and the permanent history of every follow-up sent. The verdict
// is the core's followup-cadence.mjs (via /api/followups?full=1) — this view
// only filters, sorts, and records.

const URGENCY_TABS = ["ALL", "URGENT", "OVERDUE", "WAITING", "COLD"] as const;
type UrgencyTab = (typeof URGENCY_TABS)[number];
const TAB_LABEL: Record<UrgencyTab, string> = { ALL: "All", URGENT: "Urgent", OVERDUE: "Overdue", WAITING: "Waiting", COLD: "Cold" };

const COLUMNS = [
  { key: "company", label: "Company" },
  { key: "role", label: "Role" },
  { key: "score", label: "Score" },
  { key: "status", label: "Status" },
  { key: "urgency", label: "Urgency" },
  { key: "days", label: "Days since app" },
  { key: "next", label: "Next follow-up" },
  { key: "count", label: "Follow-ups done" },
  { key: "since", label: "Days since F/U" },
] as const;
type SortKey = (typeof COLUMNS)[number]["key"];
const SORT_KEYS = COLUMNS.map((c) => c.key);

/** Sortable value per column; null means "always last, either direction". */
function sortVal(e: CadenceEntry, key: SortKey): string | number | null {
  switch (key) {
    case "company":
      return e.company.toLowerCase();
    case "role":
      return e.role.toLowerCase();
    case "score": {
      const m = e.score?.match(/(\d+(?:\.\d+)?)/);
      return m ? parseFloat(m[1]) : null;
    }
    case "status":
      return e.status;
    case "urgency":
      // Severity, not alphabetical: negate rank so DESCENDING (▼, the first
      // click) puts the most pressing first — matching how the ▼ glyph reads.
      return -urgencyRank(e.urgency);
    case "days":
      return e.daysSinceApplication;
    case "next":
      return e.daysUntilNext;
    case "count":
      return e.followupCount;
    case "since":
      return e.daysSinceLastFollowup;
  }
}

type CadenceResponse = {
  available: boolean;
  metadata: CadenceMetadata | null;
  entries: CadenceEntry[];
};

export function FollowupsView() {
  const params = useSearchParams();
  const router = useRouter();
  const pathname = usePathname();

  const [data, setData] = useState<CadenceResponse | null>(null);
  const [expanded, setExpanded] = useState<Set<number>>(new Set());
  const [dialogFor, setDialogFor] = useState<CadenceEntry | null>(null);
  const [pinFor, setPinFor] = useState<CadenceEntry | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);

  const refetch = useCallback(() => {
    fetch("/api/followups?full=1")
      .then((r) => r.json())
      .then((d: CadenceResponse) => setData(d))
      .catch(() => setData({ available: false, metadata: null, entries: [] }));
  }, []);
  useEffect(refetch, [refetch]);

  // URL is the source of truth for tab/sort/dir (Pipeline convention); search
  // stays local for snappy typing, seeded from the URL. No sort param → the
  // engine's own order (most pressing first) and all headers show ⇅.
  const pTab = (params.get("urgency") ?? "").toUpperCase();
  const tab: UrgencyTab = (URGENCY_TABS as readonly string[]).includes(pTab) ? (pTab as UrgencyTab) : "ALL";
  const pSort = params.get("sort") ?? "";
  const sortKey: SortKey | null = (SORT_KEYS as readonly string[]).includes(pSort) ? (pSort as SortKey) : null;
  const dir = (params.get("dir") === "-1" ? -1 : 1) as 1 | -1;

  const [q, setQ] = useState(params.get("q") ?? "");
  const lastUrlQ = useRef(params.get("q") ?? "");
  useEffect(() => {
    const urlQ = params.get("q") ?? "";
    if (urlQ !== lastUrlQ.current) {
      lastUrlQ.current = urlQ;
      setQ(urlQ);
    }
  }, [params]);

  const setParams = useCallback(
    (updates: Record<string, string | number | null>) => {
      const sp = new URLSearchParams(params.toString());
      for (const [k, v] of Object.entries(updates)) {
        if (v == null || v === "") sp.delete(k);
        else sp.set(k, String(v));
      }
      const qs = sp.toString();
      router.replace(`${pathname}${qs ? `?${qs}` : ""}`, { scroll: false });
    },
    [params, router, pathname],
  );

  const entries = useMemo(() => (data?.available ? data.entries : []), [data]);
  const meta = data?.available ? data.metadata : null;

  const filtering = tab !== "ALL" || q.trim().length > 0;
  const filtered = useMemo(() => {
    let rows = entries;
    if (tab !== "ALL") rows = rows.filter((e) => e.urgency.toUpperCase() === tab);
    if (q.trim()) {
      const needle = q.toLowerCase();
      rows = rows.filter((e) => `${e.company} ${e.role}`.toLowerCase().includes(needle));
    }
    if (!sortKey) return rows; // engine order: most pressing first
    return [...rows].sort((a, b) => {
      const av = sortVal(a, sortKey);
      const bv = sortVal(b, sortKey);
      if (av == null && bv == null) return 0;
      if (av == null) return 1; // nulls last, either direction
      if (bv == null) return -1;
      if (typeof av === "string" && typeof bv === "string") return av.localeCompare(bv) * dir;
      return ((av as number) - (bv as number)) * dir;
    });
  }, [entries, tab, q, sortKey, dir]);

  const removeLogged = async (num: number) => {
    setActionError(null);
    try {
      const res = await fetch("/api/followups/log", {
        method: "DELETE",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ num }),
      });
      if (!res.ok) {
        const j = (await res.json().catch(() => ({}))) as { error?: string };
        setActionError(typeof j.error === "string" ? `Couldn't remove the follow-up: ${j.error}` : "Couldn't remove the follow-up.");
      }
    } catch {
      setActionError("Couldn't remove the follow-up.");
    }
    refetch();
  };

  const toggleExpand = (num: number) =>
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(num)) next.delete(num);
      else next.add(num);
      return next;
    });

  const subtitle = !data ? (
    <span className="inline-flex items-center gap-1.5">
      <Loader2 aria-hidden className="size-3.5 motion-safe:animate-spin" /> Computing cadence…
    </span>
  ) : !data.available || !meta ? (
    "Cadence unavailable"
  ) : (
    <>
      <span className="tabular-nums">{meta.actionable}</span> active ·{" "}
      <span className="tabular-nums">{meta.urgent}</span> urgent ·{" "}
      <span className="tabular-nums">{meta.overdue}</span> overdue
    </>
  );

  return (
    <div className="mx-auto max-w-6xl px-4 py-6 max-sm:pb-24 sm:px-6 sm:py-8">
      <div className="mb-6 flex flex-wrap items-end justify-between gap-4">
        <div>
          <h1 className="font-display text-2xl tracking-tight text-landing">Follow-up Tracker</h1>
          <p className="mt-1 text-sm text-muted">{subtitle}</p>
        </div>
        <div className="relative w-full sm:w-56">
          <Search aria-hidden className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-faint" />
          <Input
            aria-label="Search company or role"
            value={q}
            onChange={(e) => setQ(e.target.value)}
            placeholder="Search company or role…"
            className="pl-9"
          />
        </div>
      </div>

      {meta && !filtering && <NarrativeCard meta={meta} entries={entries} />}

      {/* urgency filter */}
      <div role="group" aria-label="Filter by urgency" className="flex flex-nowrap gap-1 overflow-x-auto border-b border-border">
        {URGENCY_TABS.map((t) => {
          const count = t === "ALL" ? entries.length : entries.filter((e) => e.urgency.toUpperCase() === t).length;
          return (
            <button
              key={t}
              type="button"
              aria-pressed={tab === t}
              onClick={() => setParams({ urgency: t === "ALL" ? null : t })}
              className={cn(
                "-mb-px inline-flex shrink-0 items-center justify-center gap-1 border-b-2 px-3 py-2 text-sm font-medium focus-ring-inset transition-colors duration-150 ease-out max-sm:min-h-11",
                tab === t ? "border-brand text-foreground" : "border-transparent text-muted hover:text-foreground",
              )}
            >
              {TAB_LABEL[t]} <span className="text-faint tabular-nums">{data ? count : "—"}</span>
            </button>
          );
        })}
      </div>

      {actionError && (
        <p role="alert" className="mt-3 text-xs text-bad-text">
          {actionError}
        </p>
      )}

      {!data ? (
        <div aria-hidden className="mt-4 divide-y divide-border rounded-xl border border-border">
          {[0, 1, 2, 3, 4].map((i) => (
            <div key={i} className="flex h-12 items-center px-4">
              <div className="h-3 w-full rounded-md bg-surface-muted motion-safe:animate-pulse" />
            </div>
          ))}
        </div>
      ) : !data.available ? (
        <EmptyPanel title="Cadence unavailable" body="The cadence engine (followup-cadence.mjs) returned nothing — check that the core scripts are present." />
      ) : filtered.length === 0 ? (
        filtering ? (
          <EmptyPanel title="No matches" body="Try a different urgency filter or clear the search." />
        ) : (
          <EmptyPanel title="Nothing to chase" body="No active applications need a follow-up. Apply to roles (or update statuses) and the cadence starts tracking them." />
        )
      ) : (
        <div className="mt-4 overflow-x-auto rounded-xl border border-border">
          <table className="w-full min-w-[880px] text-sm">
            <thead className="bg-surface/60 text-left text-xs eyebrow text-faint">
              <tr>
                <th className="w-8 px-2 py-2.5" aria-label="Expand" />
                {COLUMNS.map((c) => {
                  const active = sortKey === c.key;
                  return (
                    <th key={c.key} aria-sort={active ? (dir === 1 ? "ascending" : "descending") : "none"} className="px-2.5 py-2.5 font-medium">
                      <button
                        type="button"
                        className="inline-flex cursor-pointer select-none items-center gap-1 rounded-md eyebrow focus-ring-inset transition-colors duration-150 ease-out hover:text-foreground"
                        onClick={() =>
                          // First click on Urgency descends (most pressing first —
                          // how ▼ reads); other columns start ascending.
                          setParams({ sort: c.key, dir: active ? dir * -1 : c.key === "urgency" ? -1 : 1 })
                        }
                      >
                        {c.label}
                        <span aria-hidden="true" className={cn(!active && "text-faint")}>
                          {active ? (dir === 1 ? "▲" : "▼") : "⇅"}
                        </span>
                      </button>
                    </th>
                  );
                })}
                <th className="px-2.5 py-2.5 font-medium">Action</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-border">
              <AnimatePresence initial={false}>
                {filtered.map((e) => (
                  <FollowupRow
                    key={e.num}
                    entry={e}
                    expanded={expanded.has(e.num)}
                    onToggle={() => toggleExpand(e.num)}
                    onLog={() => setDialogFor(e)}
                    onPin={() => setPinFor(e)}
                    onRemove={removeLogged}
                  />
                ))}
              </AnimatePresence>
            </tbody>
          </table>
        </div>
      )}

      {dialogFor && <LogDialog entry={dialogFor} onClose={() => setDialogFor(null)} onLogged={refetch} />}
      {pinFor && <NextDateDialog entry={pinFor} onClose={() => setPinFor(null)} onChanged={refetch} />}
    </div>
  );
}

/** The one-sentence "what to do first" card — only when something is due and no
 *  filter narrows the view (spec: hidden while any filter/search is active). */
function NarrativeCard({ meta, entries }: { meta: CadenceMetadata; entries: CadenceEntry[] }) {
  const due = meta.overdue + meta.urgent;
  if (due <= 0) return null;

  const pressing = [...entries]
    .filter((e) => e.urgency === "overdue" || e.urgency === "urgent")
    .sort((a, b) => urgencyRank(a.urgency) - urgencyRank(b.urgency) || b.daysSinceApplication - a.daysSinceApplication)
    .slice(0, 4);

  const parts: string[] = [];
  if (meta.overdue > 0) parts.push(`Overdue follow-ups: ${meta.overdue}`);
  if (meta.urgent > 0) parts.push(`Urgent: ${meta.urgent}`);
  if (pressing.length > 0) {
    parts.push(`most pressing today: ${oxfordJoin(pressing.map((e) => `${e.company} (#${e.num})`))}`);
    const days = pressing.map((e) => e.daysSinceApplication);
    const max = Math.max(...days);
    parts.push(days.every((d) => d === max) ? `all ${max} days since applied` : `up to ${max} days since applied`);
  }

  return (
    <Card
      inset
      tone={meta.urgent > 0 ? "bad" : "warn"}
      className={cn("mb-6 border-l-4 text-sm text-foreground", meta.urgent > 0 ? "border-l-bad" : "border-l-warn")}
    >
      {parts.join(" — ")}
    </Card>
  );
}

function FollowupRow({
  entry: e,
  expanded,
  onToggle,
  onLog,
  onPin,
  onRemove,
}: {
  entry: CadenceEntry;
  expanded: boolean;
  onToggle: () => void;
  onLog: () => void;
  onPin: () => void;
  onRemove: (num: number) => void;
}) {
  const statusLabel = e.status.charAt(0).toUpperCase() + e.status.slice(1);
  const Chevron = expanded ? ChevronDown : ChevronRight;
  return (
    <>
      <motion.tr {...rowItem} className="group transition-colors duration-150 ease-out hover:bg-surface-hover">
        <td className="px-2 py-3">
          <Button
            type="button"
            variant="ghost"
            size="icon-sm"
            onClick={onToggle}
            aria-expanded={expanded}
            aria-label={`${expanded ? "Hide" : "Show"} follow-up history for ${e.company}`}
            className="text-muted"
          >
            <Chevron aria-hidden className="size-4" />
          </Button>
        </td>
        <td className="px-2.5 py-3 font-medium">
          {e.reportPath ? (
            <Link
              href={`/pipeline/${e.num}`}
              className="flex items-center gap-2.5 rounded-md focus-ring-inset transition-colors duration-150 ease-out group-hover:text-brand-text"
            >
              <CompanyLogo name={e.company} size={20} />
              {e.company}
            </Link>
          ) : (
            <span className="flex items-center gap-2.5">
              <CompanyLogo name={e.company} size={20} />
              {e.company}
            </span>
          )}
        </td>
        <td className="max-w-56 truncate px-2.5 py-3 text-muted">{e.role}</td>
        <td className="px-2.5 py-3">
          <Badge tone={scoreTone(e.score)}>{e.score || "—"}</Badge>
        </td>
        <td className="px-2.5 py-3">
          <Badge tone={followupStatusTone(e.status)}>{statusLabel}</Badge>
        </td>
        <td className="px-2.5 py-3">
          <Badge tone={urgencyTone(e.urgency)}>{e.urgency}</Badge>
        </td>
        <td className={cn("px-2.5 py-3 tabular-nums", daysHeatClass(e.daysSinceApplication))}>{e.daysSinceApplication}</td>
        <td className="whitespace-nowrap px-2.5 py-3">
          {e.daysUntilNext == null ? (
            <span className="text-faint">—</span>
          ) : (
            <span className={cn(e.daysUntilNext < 0 && "font-medium text-bad-text")} title={e.nextFollowupDate ?? undefined}>
              {relativeDays(e.daysUntilNext)}
            </span>
          )}
          {e.nextOverride && (
            <span
              className="ml-1.5 inline-flex align-[-1px]"
              title={`Pinned to ${e.nextOverride} — cleared when you log a follow-up`}
              aria-label="Pinned manually"
            >
              <Pin aria-hidden className="size-3 text-brand-text" />
            </span>
          )}
        </td>
        <td className="px-2.5 py-3 tabular-nums">{e.followupCount}</td>
        <td className={cn("px-2.5 py-3 tabular-nums", daysHeatClass(e.daysSinceLastFollowup))}>
          {e.daysSinceLastFollowup == null ? <span className="text-faint">—</span> : e.daysSinceLastFollowup}
        </td>
        <td className="whitespace-nowrap px-2.5 py-3">
          <span className="inline-flex items-center gap-0.5">
            <Button
              type="button"
              variant="ghost"
              size="sm"
              onClick={onLog}
              title="Log a follow-up (date, channel, contact, notes)"
              aria-label={`Log a follow-up for ${e.company}`}
              className="text-muted hover:bg-brand-soft hover:text-brand-text"
            >
              Log
            </Button>
            <Button
              type="button"
              variant="ghost"
              size="icon-sm"
              onClick={onPin}
              title={e.nextOverride ? `Next date pinned to ${e.nextOverride} — change or clear` : "Pin a custom next follow-up date"}
              aria-label={
                e.nextOverride
                  ? `Change or clear the pinned date for ${e.company}`
                  : `Pin a custom next follow-up date for ${e.company}`
              }
              className={cn("hover:bg-brand-soft hover:text-brand-text", e.nextOverride ? "text-brand-text" : "text-muted")}
            >
              <CalendarClock aria-hidden className="size-3.5" />
            </Button>
          </span>
        </td>
      </motion.tr>
      {expanded && (
        <tr className="bg-surface/30">
          <td colSpan={COLUMNS.length + 2} className="px-4 py-3">
            <HistoryPanel entry={e} onRemove={onRemove} />
          </td>
        </tr>
      )}
    </>
  );
}

function HistoryPanel({ entry: e, onRemove }: { entry: CadenceEntry; onRemove: (num: number) => void }) {
  // Tolerate an older core engine (CAREER_OPS_ROOT can point at a separate
  // checkout whose followup-cadence.mjs predates the per-entry followups[]).
  const history = e.followups ?? [];
  return (
    <div className="space-y-2 pl-7 text-sm">
      {history.length === 0 ? (
        <p className="text-faint">No follow-ups logged yet.</p>
      ) : (
        <ul className="space-y-1.5">
          {history.map((f, i) => (
            <li key={`${f.num ?? "b"}-${f.date}-${i}`} className="group/item flex flex-wrap items-baseline gap-x-2 gap-y-0.5">
              {/* Fixed-width leading slot keeps every entry's text aligned,
                  whether or not it is deletable (legacy bullets carry no num). */}
              <span className="inline-flex w-7 shrink-0 justify-center self-center">
                {f.num != null && (
                  <Button
                    type="button"
                    variant="danger-ghost"
                    size="icon-sm"
                    onClick={() => onRemove(f.num!)}
                    title="Remove this logged follow-up (added by mistake?)"
                    aria-label={`Remove follow-up logged ${f.date}`}
                    className="opacity-0 group-hover/item:opacity-100 focus-visible:opacity-100 pointer-coarse:opacity-100"
                  >
                    <Trash2 aria-hidden className="size-3.5" />
                  </Button>
                )}
              </span>
              <span className="tabular-nums text-muted">{f.date}</span>
              <Badge tone="muted">{f.channel}</Badge>
              {f.contact && <span className="text-muted">{f.contact}</span>}
              {f.notes && <span className="text-faint">{f.notes}</span>}
            </li>
          ))}
        </ul>
      )}
      {e.contacts.length > 0 && (
        <p className="text-xs text-faint">
          Suggested contacts:{" "}
          {e.contacts.map((c, i) => (
            <span key={c.email}>
              {i > 0 && ", "}
              <a href={`mailto:${c.email}`} className="rounded-md text-muted underline decoration-dotted underline-offset-2 focus-ring-inset transition-colors duration-150 ease-out hover:text-brand-text">
                {c.name ? `${c.name} <${c.email}>` : c.email}
              </a>
            </span>
          ))}
        </p>
      )}
    </div>
  );
}

function EmptyPanel({ title, body }: { title: string; body: string }) {
  return (
    <Card className="mt-4 border-dashed px-6 py-12 text-center">
      <h2 className="font-display text-lg text-foreground">{title}</h2>
      <p className="mx-auto mt-1 max-w-md text-sm text-muted">{body}</p>
    </Card>
  );
}
