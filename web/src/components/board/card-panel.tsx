"use client";

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import {
  ArrowRightLeft,
  ExternalLink,
  Eye,
  FileText,
  MessageSquare,
  Radar,
  Sparkles,
  Trash2,
  XCircle,
} from "lucide-react";
import type { Application } from "@/lib/career-ops";
import { relativeDays, urgencyTone, type CadenceEntry } from "@/lib/followups";
import { Badge } from "@/components/ui/badge";
import { Button, buttonVariants } from "@/components/ui/button";
import { Dialog } from "@/components/ui/dialog";
import { Textarea } from "@/components/ui/field";
import { CompanyLogo } from "@/components/company-logo";
import { cn } from "@/lib/cn";
import { scoreTone } from "@/lib/format";
import { companyPresentation } from "@/lib/company-presentation.mjs";
import { BOARD_COLUMNS, boardColumn, isHired } from "@/lib/board-columns.mjs";
import type { TimelineEvent } from "@/lib/board-activity.mjs";

type Summary = Record<string, unknown>;
type Detail = {
  meta: { header: Record<string, string>; summary: Summary | null };
  timeline: TimelineEvent[];
};

const KIND_ICON: Record<string, typeof Eye> = {
  scan: Radar,
  evaluated: Sparkles,
  status: ArrowRightLeft,
  move: ArrowRightLeft,
  comment: MessageSquare,
  open: Eye,
  expired: XCircle,
};

const FU_LABEL: Record<string, string> = { urgent: "Reply now", overdue: "Follow up", waiting: "Waiting", cold: "Cold" };

const str = (v: unknown) => (typeof v === "string" && v.trim() ? v.trim() : null);

function when(e: TimelineEvent) {
  if (e.dated) return new Date(`${e.at}T00:00:00`).toLocaleDateString(undefined, { month: "short", day: "numeric" });
  return new Date(e.at).toLocaleString(undefined, { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });
}

export function CardPanel({
  app,
  status,
  fu,
  onMove,
  onClose,
}: {
  app: Application;
  status: string;
  fu?: CadenceEntry;
  onMove: (n: string, status: string) => Promise<boolean>;
  onClose: () => void;
}) {
  const [detail, setDetail] = useState<Detail | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [comment, setComment] = useState("");
  const [saving, setSaving] = useState(false);
  const [moving, setMoving] = useState<string | null>(null);
  const company = companyPresentation(app);
  const lane = boardColumn(status);

  const load = useCallback(async () => {
    try {
      const r = await fetch(`/api/board/${app.n}`);
      if (!r.ok) throw new Error(((await r.json().catch(() => null)) as { error?: string } | null)?.error ?? "load failed");
      setDetail((await r.json()) as Detail);
      setLoadError(null);
    } catch (e) {
      setLoadError((e as Error).message);
    }
  }, [app.n]);

  useEffect(() => {
    // Log the open first so it is already in the timeline the load returns.
    fetch(`/api/board/${app.n}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ kind: "open" }),
    })
      .catch(() => {})
      .finally(load);
  }, [app.n, load]);

  async function moveTo(next: string) {
    setMoving(next);
    if (await onMove(app.n, next)) await load();
    setMoving(null);
  }

  async function addComment(e: React.FormEvent) {
    e.preventDefault();
    if (!comment.trim()) return;
    setSaving(true);
    const r = await fetch(`/api/board/${app.n}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ kind: "comment", text: comment }),
    }).catch(() => null);
    setSaving(false);
    if (r?.ok) {
      setComment("");
      load();
    } else setLoadError("comment not saved");
  }

  const header = detail?.meta.header ?? {};
  const summary = detail?.meta.summary ?? {};
  const url = header.URL?.startsWith("http") ? header.URL : null;
  const comments = (detail?.timeline ?? []).filter((e) => e.kind === "comment");
  const facts: [string, string | null][] = [
    ["Comp", str(summary.advertised_comp)],
    ["Archetype", str(header.Archetype) ?? str(summary.archetype)],
    ["Work auth", str(header["Work Auth"])],
    ["Via", header.Via && header.Via !== "—" ? header.Via : null],
    ["Tracker date", app.date || null],
  ];

  return (
    <Dialog
      open
      onClose={onClose}
      size="full"
      title={
        <span className="flex items-center gap-2">
          <CompanyLogo name={company.logoName} size={20} />
          <span className="truncate">{app.role}</span>
        </span>
      }
      description={
        <>
          {company.label} · #{app.n}
        </>
      }
    >
      {/* Focus lands on the current status, not the comment box: opening a card
          is usually a look or a move, and a focused textarea hides the mobile
          board behind a keyboard. Off-board statuses fall back to the report. */}
      <div className="grid grid-cols-1 gap-6 lg:h-full lg:grid-cols-[4fr_1fr]">
        <div className="flex min-w-0 flex-col gap-6 lg:min-h-0 lg:overflow-y-auto lg:pr-2">
          <section aria-labelledby="panel-status">
            <h3 id="panel-status" className="mb-2 eyebrow text-xs font-semibold text-muted">
              Status
            </h3>
            <div className="flex flex-wrap items-center gap-2" role="group" aria-label="Move to">
              {BOARD_COLUMNS.map((c) => (
                <Button
                  key={c.id}
                  size="sm"
                  variant={lane === c.id ? "soft" : "secondary"}
                  aria-pressed={lane === c.id}
                  data-autofocus={lane === c.id || undefined}
                  disabled={moving !== null}
                  loading={moving === c.status}
                  onClick={() => lane !== c.id && moveTo(c.status)}
                >
                  {c.label}
                </Button>
              ))}
              {isHired(status) && <Badge tone="good">Hired</Badge>}
              <Button
                size="sm"
                variant="danger-ghost"
                className="sm:ml-auto"
                disabled={moving !== null}
                loading={moving === "Discarded"}
                onClick={() => moveTo("Discarded")}
              >
                <Trash2 aria-hidden className="size-3.5" /> Discard
              </Button>
            </div>
            {fu && (
              <p className="mt-2 flex items-center gap-2 text-sm text-muted">
                <Badge tone={urgencyTone(fu.urgency)}>{FU_LABEL[fu.urgency] ?? fu.urgency}</Badge>
                <span className="tabular-nums">
                  {fu.daysSinceApplication}d since applied
                  {fu.daysUntilNext != null && ` · next follow-up ${relativeDays(fu.daysUntilNext)}`}
                </span>
              </p>
            )}
          </section>

          <div className="flex flex-wrap gap-2">
            <Link
              href={`/pipeline/${app.n}`}
              data-autofocus={lane ? undefined : true}
              className={buttonVariants({ variant: "secondary", size: "md" })}
            >
              <FileText aria-hidden className="size-4" /> Full report
            </Link>
            {url && (
              <a href={url} target="_blank" rel="noreferrer" className={buttonVariants({ variant: "secondary", size: "md" })}>
                <ExternalLink aria-hidden className="size-4" /> Open posting
              </a>
            )}
          </div>

          <section aria-labelledby="panel-details">
            <h3 id="panel-details" className="mb-2 eyebrow text-xs font-semibold text-muted">
              Details
            </h3>
            <dl className="grid grid-cols-2 gap-x-6 gap-y-3 xl:grid-cols-4">
              <div>
                <dt className="text-xs text-muted">Score</dt>
                <dd className="mt-0.5">{app.score ? <Badge tone={scoreTone(app.score)}>{app.score}</Badge> : "—"}</dd>
              </div>
              {facts
                .filter(([, v]) => v)
                .map(([k, v]) => (
                  <div key={k} className="min-w-0">
                    <dt className="text-xs text-muted">{k}</dt>
                    <dd className="mt-0.5 text-sm text-foreground">{v}</dd>
                  </div>
                ))}
            </dl>
          </section>

          <section aria-labelledby="panel-comments">
            <h3 id="panel-comments" className="mb-2 eyebrow text-xs font-semibold text-muted">
              Comments
            </h3>
            <form onSubmit={addComment} className="flex flex-col gap-2">
              <Textarea
                value={comment}
                onChange={(e) => setComment(e.target.value)}
                placeholder="Recruiter name, prep notes, what you sent…"
                aria-label="Add a comment"
                maxLength={2000}
                onKeyDown={(e) => {
                  if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) addComment(e);
                }}
              />
              <Button type="submit" size="sm" className="self-end" loading={saving} disabled={!comment.trim()}>
                Add comment
              </Button>
            </form>
            {comments.length > 0 && (
              <ul className="mt-3 flex flex-col gap-2">
                {comments.map((c) => (
                  <li key={c.at} className="rounded-xl border border-border px-3 py-2">
                    <p className="text-xs text-muted tabular-nums">{when(c)}</p>
                    <p className="mt-1 text-sm whitespace-pre-wrap text-foreground">{c.detail}</p>
                  </li>
                ))}
              </ul>
            )}
          </section>


          {app.notes && (
            <section aria-labelledby="panel-notes">
              <h3 id="panel-notes" className="mb-2 eyebrow text-xs font-semibold text-muted">
                Evaluation notes
              </h3>
              <p className="text-sm leading-relaxed text-foreground">{app.notes}</p>
            </section>
          )}

        </div>

        <aside
          aria-labelledby="panel-activity"
          className="flex min-w-0 flex-col border-border max-lg:border-t max-lg:pt-4 lg:min-h-0 lg:overflow-y-auto lg:border-l lg:pl-4"
        >
          <h3 id="panel-activity" className="mb-3 eyebrow text-xs font-semibold text-muted">
            Activity
          </h3>
          {loadError && (
            <p role="alert" className="mb-2 text-sm text-bad-text">
              {loadError}
            </p>
          )}
          {!detail && !loadError && <p className="text-sm text-muted">Loading…</p>}
          <ol className="flex flex-col">
            {detail?.timeline.map((e, i, all) => {
              const Icon = KIND_ICON[e.kind] ?? Eye;
              return (
                <li key={`${e.at}-${i}`} className="relative flex gap-2.5 pb-4 last:pb-0">
                  {i < all.length - 1 && (
                    <span aria-hidden className="absolute top-6 bottom-0 left-2.5 w-px bg-border" />
                  )}
                  <span
                    className={cn(
                      "relative flex size-5 shrink-0 items-center justify-center rounded-full border border-border bg-surface",
                      e.kind === "expired" ? "text-bad-text" : e.kind === "comment" ? "text-brand-text" : "text-muted",
                    )}
                  >
                    <Icon aria-hidden className="size-3" />
                  </span>
                  <div className="min-w-0 flex-1">
                    <p className="text-sm text-foreground">{e.title}</p>
                    {e.detail && e.kind !== "comment" && <p className="text-xs text-muted">{e.detail}</p>}
                    {e.kind === "comment" && <p className="line-clamp-2 text-xs text-muted">{e.detail}</p>}
                    <p className="text-xs text-muted tabular-nums">{when(e)}</p>
                  </div>
                </li>
              );
            })}
          </ol>
        </aside>
      </div>
    </Dialog>
  );
}
