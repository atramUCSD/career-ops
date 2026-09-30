"use client";

import { useEffect, useRef } from "react";
import { animate, motion, useInView, useReducedMotion } from "motion/react";
import { cn } from "@/lib/cn";
import { barWidths } from "@/lib/chart-geometry.mjs";
import { DURATION, EASE_OUT } from "./motion";

// Numbers settle, they do not bounce. Bar, Steps and SegmentBar are
// decorative: callers always render the number or label beside them.

export type Tone = "brand" | "good" | "warn" | "bad" | "info" | "boost" | "muted";

const FILL: Record<Tone, string> = {
  brand: "bg-brand",
  good: "bg-good",
  warn: "bg-warn",
  bad: "bg-bad",
  info: "bg-info",
  boost: "bg-boost",
  muted: "bg-faint",
};

const DATA = { duration: DURATION.data, ease: EASE_OUT } as const;
const STAGGER = 0.04;
// Past 8 items the stagger stops growing, so a long list still lands in ~0.9s.
const delay = (i: number) => Math.min(i, 7) * STAGGER;

/**
 * Counts to its new value when it changes. The first render is the final
 * value, so server HTML, screen readers and reduced-motion viewers read the
 * real number without waiting on an animation.
 */
export function CountUp({ value, className }: { value: number; className?: string }) {
  const ref = useRef<HTMLSpanElement>(null);
  const last = useRef(value);
  const reduce = useReducedMotion();
  useEffect(() => {
    const from = last.current;
    last.current = value;
    if (from === value || reduce || !ref.current) return;
    const node = ref.current;
    const controls = animate(from, value, { ...DATA, onUpdate: (v) => (node.textContent = Math.round(v).toLocaleString()) });
    return () => controls.stop();
  }, [value, reduce]);
  return (
    <span ref={ref} className={cn("tabular-nums", className)}>
      {value.toLocaleString()}
    </span>
  );
}

/** A proportion bar that grows from the left the first time it scrolls into view. */
export function Bar({
  pct,
  tone = "brand",
  size = "md",
  className,
}: {
  pct: number;
  tone?: Tone;
  size?: "sm" | "md";
  className?: string;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const seen = useInView(ref, { once: true });
  return (
    <div
      ref={ref}
      aria-hidden
      className={cn("w-full overflow-hidden rounded-full bg-surface-muted", size === "sm" ? "h-1" : "h-1.5", className)}
    >
      <motion.div
        className={cn("h-full origin-left rounded-full", FILL[tone])}
        initial={{ scaleX: 0 }}
        animate={{ scaleX: seen ? Math.min(100, Math.max(pct, 0)) / 100 : 0 }}
        transition={DATA}
      />
    </div>
  );
}

/** Segmented progress: `done` of `total` steps, filling left to right. */
export function Steps({ done, total, tone = "brand", className }: { done: number; total: number; tone?: Tone; className?: string }) {
  const ref = useRef<HTMLDivElement>(null);
  const seen = useInView(ref, { once: true });
  return (
    <div ref={ref} className={cn("flex gap-1", className)} aria-hidden>
      {Array.from({ length: total }, (_, i) => (
        <div key={i} className="h-1 flex-1 overflow-hidden rounded-full bg-surface-muted">
          <motion.div
            className={cn("h-full origin-left rounded-full", FILL[tone])}
            initial={{ scaleX: 0 }}
            animate={{ scaleX: seen && i < done ? 1 : 0 }}
            transition={{ ...DATA, delay: delay(i) }}
          />
        </div>
      ))}
    </div>
  );
}

/**
 * Parts of one whole laid end to end, each scaled in from the left and
 * staggered, so the bar reads as the funnel draining.
 */
export function SegmentBar({
  parts,
  className,
}: {
  parts: { key: string; count: number; tone: Tone; label: string }[];
  className?: string;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const seen = useInView(ref, { once: true });
  const total = parts.reduce((n, p) => n + p.count, 0) || 1;
  return (
    <div ref={ref} className={cn("flex h-2 w-full gap-0.5 overflow-hidden rounded-full", className)} aria-hidden>
      {parts
        .filter((p) => p.count > 0)
        .map((p, i) => (
          <motion.div
            key={p.key}
            title={`${p.label}: ${p.count.toLocaleString()}`}
            className={cn("h-full min-w-1 origin-left first:rounded-l-full last:rounded-r-full", FILL[p.tone])}
            style={{ flexGrow: p.count / total, flexBasis: 0 }}
            initial={{ scaleX: 0 }}
            animate={{ scaleX: seen ? 1 : 0 }}
            transition={{ ...DATA, delay: delay(i) }}
          />
        ))}
    </div>
  );
}

/**
 * Horizontal bar chart (replaces /analytics' inline BarChart). Widths are
 * relative to the largest value through the shared chart geometry, with a 4%
 * floor so a small non-zero count stays visible; `total` only adds the share
 * beside each count. `takeaway` is a screen-reader summary; labels and
 * counts stay real list text.
 */
export function BarList({
  items,
  takeaway,
  total,
  className,
}: {
  items: { label: string; value: number; tone?: Tone }[];
  takeaway: string;
  total?: number;
  className?: string;
}) {
  const widths = barWidths(items.map((i) => i.value), 100, 4);
  return (
    <div className={className}>
      <p className="sr-only">{takeaway}</p>
      <ul className="space-y-2.5">
        {items.map((it, i) => (
          <li key={it.label} className="flex items-center gap-3">
            <div className="w-32 shrink-0 truncate text-sm text-muted">{it.label}</div>
            <Bar pct={widths[i]} tone={it.tone ?? "muted"} className="flex-1" />
            <div className="w-20 shrink-0 text-right text-sm tabular-nums">
              <CountUp value={it.value} />
              {total !== undefined && total > 0 && (
                <span className="ml-1 text-xs text-faint">{Math.round((it.value / total) * 100)}%</span>
              )}
            </div>
          </li>
        ))}
      </ul>
    </div>
  );
}
