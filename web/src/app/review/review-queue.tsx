"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { AnimatePresence, motion } from "motion/react";
import { AlertTriangle, Check, ChevronDown, ChevronRight } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { listItem } from "@/components/ui/motion";
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
  reworded: "border-info/30 text-info-text",
  "story-bank claim": "border-warn/50 text-warn",
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
      <Card inset>
        <p className="text-sm text-muted">
          Nothing awaiting review. Prepare applications from the inbox shortlist and they land here.
        </p>
      </Card>
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
    // relative: popLayout pins an approved item absolutely while it fades out.
    <div className="relative space-y-3">
      <AnimatePresence initial={false} mode="popLayout">
      {items.map((item) => {
        const isOpen = open === item.n;
        const done = approved.has(item.n);
        return (
          <motion.div key={item.n} {...listItem}>
          <Card inset className="p-0">
            {/* Whole-row disclosure target: kept a raw button (Button centers and pads a control). */}
            <button
              type="button"
              onClick={() => {
                setOpen(isOpen ? null : item.n);
                setErr("");
              }}
              aria-expanded={isOpen}
              className={cn(
                "flex w-full items-center gap-3 px-4 py-3 text-left transition-colors duration-150 ease-out hover:bg-surface-hover focus-ring max-sm:min-h-11",
                isOpen ? "rounded-t-xl" : "rounded-xl",
              )}
            >
              {isOpen ? (
                <ChevronDown aria-hidden className="size-4 shrink-0 text-faint" />
              ) : (
                <ChevronRight aria-hidden className="size-4 shrink-0 text-faint" />
              )}
              <span className="min-w-0 flex-1 truncate text-sm">
                <span className="font-medium">{item.company}</span>
                <span className="text-muted"> — {item.role}</span>
              </span>
              {item.bullets.some((b) => b.claims.length > 0) && (
                <Chip tone="amber">
                  <AlertTriangle aria-hidden className="size-3" /> <span className="max-sm:sr-only">unverified figures</span>
                </Chip>
              )}
              {item.jdUnread && (
                <Chip tone="amber">
                  <AlertTriangle aria-hidden className="size-3" /> <span className="max-sm:sr-only">JD unread</span>
                </Chip>
              )}
              {done && (
                <Chip tone="green">
                  <Check aria-hidden className="size-3" /> <span className="max-sm:sr-only">approved</span>
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
                  <Button
                    variant={done ? "soft" : "secondary"}
                    disabled={!item.report || done}
                    loading={busy === item.n}
                    onClick={() => approve(item)}
                    // The approved state reads as a result, not a dimmed control.
                    className={cn("shrink-0", done && "disabled:opacity-100")}
                  >
                    {busy !== item.n && <Check aria-hidden className="size-4" />}
                    {done ? "Approved" : "Approve"}
                  </Button>
                  <span className="text-xs text-faint">
                    {item.report
                      ? done
                        ? "Marked ready — submit it yourself when you’re ready."
                        : `Stamps report #${item.report} approved. You still submit manually.`
                      : "No report resolved for this row — can’t approve."}
                  </span>
                </div>
                <AnimatePresence initial={false}>
                  {err && (
                    <motion.p key="err" {...listItem} role="alert" className="mt-2 text-xs text-bad-text">
                      {err}
                    </motion.p>
                  )}
                </AnimatePresence>
              </div>
            )}
          </Card>
          </motion.div>
        );
      })}
      </AnimatePresence>
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
                "eyebrow mt-0.5 shrink-0 rounded-md border px-1.5 py-0.5 text-2xs",
                SOURCE_TONE[b.source],
              )}
            >
              {b.source}
            </span>
            <span className="min-w-0">{b.text}</span>
          </div>
          {b.closest && <p className="mt-1 pl-2 text-xs text-faint">was: {b.closest}</p>}
          {b.claims.map((c, j) => (
            <p key={j} className="mt-1 flex items-start gap-1.5 pl-2 text-xs text-warn">
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
        "eyebrow inline-flex shrink-0 items-center gap-1 rounded-md border px-2 py-0.5 text-2xs font-medium",
        tone === "amber" ? "border-warn/50 text-warn" : "border-good/30 text-brand-text",
      )}
    >
      {children}
    </span>
  );
}
