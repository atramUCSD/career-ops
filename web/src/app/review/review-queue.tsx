"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { AlertTriangle, Check, ChevronDown, ChevronRight, Loader2 } from "lucide-react";
import { cn } from "@/lib/cn";

export type ReviewBullet = {
  text: string;
  source: "verbatim-in-cv.md" | "reworded" | "story-bank claim";
  closest: string | null;
  claims: { story: string; claim: string; bucket: "derived-unverified" | "user-cannot-confirm" }[];
};

export type ReviewItem = {
  n: string;
  company: string;
  role: string;
  /** Report FILE number (zero-padded) — the approve target; null when unresolved. */
  report: string | null;
  jdUnread: boolean;
  htmlMissing: boolean;
  bullets: ReviewBullet[];
  flagged: boolean;
};

const SOURCE_TONE: Record<ReviewBullet["source"], string> = {
  "verbatim-in-cv.md": "border-border text-muted",
  reworded: "border-sky-400/40 text-sky-400",
  "story-bank claim": "border-amber-400/50 text-amber-400",
};

/** The per-application review list. The approve control lives ONLY inside the
 *  expanded detail, below the delta — one application at a time, no batch
 *  approve, and nothing here (or anywhere) submits to an ATS. */
export function ReviewQueue({ items }: { items: ReviewItem[] }) {
  const router = useRouter();
  const [open, setOpen] = useState<string | null>(items.find((i) => i.flagged)?.n ?? null);
  const [approved, setApproved] = useState<Set<string>>(new Set());
  const [busy, setBusy] = useState<string | null>(null);
  const [err, setErr] = useState("");

  if (items.length === 0) {
    return (
      <p className="mt-8 rounded-lg border border-border bg-surface/30 p-6 text-sm text-muted">
        Nothing awaiting review. Prepare applications from the inbox shortlist and they land here.
      </p>
    );
  }

  async function approve(item: ReviewItem) {
    if (!item.report) return;
    setBusy(item.n);
    setErr("");
    try {
      const r = await fetch("/api/prepare/approve", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ report: item.report }),
      });
      const d = await r.json().catch(() => ({}));
      if (!r.ok) {
        setErr(d.error || d.msg || "Approve failed.");
        return;
      }
      setApproved((s) => new Set(s).add(item.n));
      router.refresh(); // re-read the tracker so the row leaves the queue
    } catch {
      setErr("Couldn’t reach the approve endpoint.");
    } finally {
      setBusy(null);
    }
  }

  return (
    <div className="mt-6 space-y-2">
      {items.map((item) => {
        const isOpen = open === item.n;
        const done = approved.has(item.n);
        return (
          <div key={item.n} className="rounded-lg border border-border bg-surface/30">
            <button
              type="button"
              onClick={() => {
                setOpen(isOpen ? null : item.n);
                setErr("");
              }}
              className="flex w-full items-center gap-3 px-4 py-3 text-left"
            >
              {isOpen ? (
                <ChevronDown className="size-4 shrink-0 text-faint" />
              ) : (
                <ChevronRight className="size-4 shrink-0 text-faint" />
              )}
              <span className="min-w-0 flex-1 truncate text-sm">
                <span className="font-medium">{item.company}</span>
                <span className="text-muted"> — {item.role}</span>
              </span>
              {item.bullets.some((b) => b.claims.length > 0) && (
                <Chip tone="amber">
                  <AlertTriangle className="size-3" /> unverified figures
                </Chip>
              )}
              {item.jdUnread && (
                <Chip tone="amber">
                  <AlertTriangle className="size-3" /> JD unread
                </Chip>
              )}
              {done && (
                <Chip tone="green">
                  <Check className="size-3" /> approved
                </Chip>
              )}
            </button>

            {isOpen && (
              <div className="border-t border-border px-4 py-4">
                <Delta item={item} />

                {/* Approve renders per application, below the delta — never in
                    the list, never in bulk. It only stamps the Notes marker;
                    submitting the application remains a human act elsewhere. */}
                <div className="mt-4 flex items-center gap-3 border-t border-border pt-4">
                  <button
                    type="button"
                    disabled={!item.report || done || busy === item.n}
                    onClick={() => approve(item)}
                    className={cn(
                      "inline-flex items-center gap-2 rounded-md border px-3 py-1.5 text-sm transition-colors",
                      done
                        ? "border-emerald-400/40 text-emerald-400"
                        : "border-border hover:bg-surface-hover disabled:cursor-not-allowed disabled:opacity-50",
                    )}
                  >
                    {busy === item.n ? <Loader2 className="size-4 animate-spin" /> : <Check className="size-4" />}
                    {done ? "Approved" : "Approve"}
                  </button>
                  <span className="text-xs text-faint">
                    {item.report
                      ? done
                        ? "Marked ready — submit it yourself when you’re ready."
                        : `Stamps report #${item.report} approved. You still submit manually.`
                      : "No report resolved for this row — can’t approve."}
                  </span>
                </div>
                {err && <p className="mt-2 text-xs text-red-400">{err}</p>}
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}

function Delta({ item }: { item: ReviewItem }) {
  if (item.htmlMissing) {
    return (
      <p className="text-sm text-muted">
        Tailored CV not found for this row (scratch HTML missing) — re-run prepare to regenerate it.
      </p>
    );
  }
  if (item.bullets.length === 0) {
    return <p className="text-sm text-muted">No changes versus cv.md — the tailored CV reuses your bullets as-is.</p>;
  }
  return (
    <ul className="space-y-3">
      {item.bullets.map((b, i) => (
        <li key={i} className="text-sm">
          <div className="flex items-start gap-2">
            <span
              className={cn(
                "mt-0.5 shrink-0 rounded-full border px-1.5 py-0.5 text-[10px] uppercase tracking-wide",
                SOURCE_TONE[b.source],
              )}
            >
              {b.source}
            </span>
            <span className="min-w-0">{b.text}</span>
          </div>
          {b.closest && <p className="mt-1 pl-2 text-xs text-faint">was: {b.closest}</p>}
          {b.claims.map((c, j) => (
            <p key={j} className="mt-1 flex items-start gap-1.5 pl-2 text-xs text-amber-400">
              <AlertTriangle className="mt-0.5 size-3 shrink-0" />
              <span>
                “{c.claim}” is {c.bucket}
                {c.story ? ` (story: ${c.story})` : ""} — confirm it before approving.
              </span>
            </p>
          ))}
        </li>
      ))}
    </ul>
  );
}

function Chip({ tone, children }: { tone: "amber" | "green"; children: React.ReactNode }) {
  return (
    <span
      className={cn(
        "inline-flex shrink-0 items-center gap-1 rounded-full border px-2 py-0.5 text-[10px] font-medium uppercase tracking-wide",
        tone === "amber" ? "border-amber-400/50 text-amber-400" : "border-emerald-400/40 text-emerald-400",
      )}
    >
      {children}
    </span>
  );
}
