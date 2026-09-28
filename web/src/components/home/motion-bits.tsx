"use client";

import { useEffect, useRef, useState } from "react";
import { animate, motion, useInView, useReducedMotion } from "motion/react";
import { Plus, X } from "lucide-react";
import { cn } from "@/lib/cn";

// Home's shared pieces. Motion is transform and opacity only, ease-out, no
// springs: numbers settle, they do not bounce.

const EASE = { duration: 0.6, ease: "easeOut" } as const;

/**
 * A number that counts to its new value when it changes. The first render is
 * the final value, so server HTML, screen readers and a reduced-motion
 * viewer all read the real number without waiting on an animation.
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
    const controls = animate(from, value, { ...EASE, onUpdate: (v) => (node.textContent = Math.round(v).toLocaleString()) });
    return () => controls.stop();
  }, [value, reduce]);
  return (
    <span ref={ref} className={cn("tabular-nums", className)}>
      {value.toLocaleString()}
    </span>
  );
}

/** A proportion bar that grows from the left the first time it scrolls into view. */
export function Bar({ pct, className, track = "bg-surface-hover" }: { pct: number; className?: string; track?: string }) {
  const ref = useRef<HTMLDivElement>(null);
  const seen = useInView(ref, { once: true });
  return (
    <div ref={ref} className={cn("h-1.5 w-full overflow-hidden rounded-full", track)}>
      <motion.div
        className={cn("h-full origin-left rounded-full", className)}
        initial={{ scaleX: 0 }}
        animate={{ scaleX: seen ? Math.min(100, Math.max(pct, 0)) / 100 : 0 }}
        transition={EASE}
      />
    </div>
  );
}

/** Segmented progress: `done` of `total` steps, filling left to right. */
export function Steps({ done, total, tone = "bg-brand" }: { done: number; total: number; tone?: string }) {
  const ref = useRef<HTMLDivElement>(null);
  const seen = useInView(ref, { once: true });
  return (
    <div ref={ref} className="flex gap-1" role="img" aria-label={`${done} of ${total} ready`}>
      {Array.from({ length: total }, (_, i) => (
        <div key={i} className="h-1 flex-1 overflow-hidden rounded-full bg-surface-hover">
          <motion.div
            className={cn("h-full origin-left rounded-full", tone)}
            initial={{ scaleX: 0 }}
            animate={{ scaleX: seen && i < done ? 1 : 0 }}
            transition={{ ...EASE, delay: i * 0.04 }}
          />
        </div>
      ))}
    </div>
  );
}

/**
 * Parts of one whole laid end to end. Each segment is a flex item scaled in
 * from the left, staggered, so the bar reads as the funnel draining.
 */
export function SegmentBar({ parts }: { parts: { key: string; count: number; tone: string; label: string }[] }) {
  const ref = useRef<HTMLDivElement>(null);
  const seen = useInView(ref, { once: true });
  const total = parts.reduce((n, p) => n + p.count, 0) || 1;
  return (
    <div ref={ref} className="flex h-2 w-full gap-0.5 overflow-hidden rounded-full" aria-hidden>
      {parts
        .filter((p) => p.count > 0)
        .map((p, i) => (
          <motion.div
            key={p.key}
            title={`${p.label}: ${p.count.toLocaleString()}`}
            className={cn("h-full min-w-1 origin-left first:rounded-l-full last:rounded-r-full", p.tone)}
            style={{ flexGrow: p.count / total, flexBasis: 0 }}
            initial={{ scaleX: 0 }}
            animate={{ scaleX: seen ? 1 : 0 }}
            transition={{ ...EASE, delay: i * 0.04 }}
          />
        ))}
    </div>
  );
}

export function Toggle({
  checked,
  onChange,
  label,
  disabled,
}: {
  checked: boolean;
  onChange: (v: boolean) => void;
  label: string;
  disabled?: boolean;
}) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={label}
      disabled={disabled}
      onClick={() => onChange(!checked)}
      className="relative h-6 w-11 shrink-0 rounded-full focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand/50 disabled:opacity-50"
    >
      <span className={cn("absolute inset-0 rounded-full transition-colors", checked ? "bg-brand" : "bg-border")} />
      <span
        className={cn(
          "absolute top-0.5 left-0 size-5 rounded-full bg-white shadow transition-transform",
          checked ? "translate-x-[1.375rem]" : "translate-x-0.5",
        )}
      />
    </button>
  );
}

export function Panel({
  icon: Icon,
  title,
  hint,
  aside,
  className,
  children,
}: {
  icon: React.ComponentType<{ className?: string }>;
  title: string;
  hint?: string;
  aside?: React.ReactNode;
  className?: string;
  children: React.ReactNode;
}) {
  return (
    <section className={cn("rounded-2xl border border-border bg-surface p-6", className)}>
      <div className="mb-5 flex flex-wrap items-center gap-x-2.5 gap-y-1">
        <Icon className="size-4 text-brand" />
        <h2 className="text-sm font-semibold uppercase tracking-[0.16em] text-foreground">{title}</h2>
        {hint && <span className="text-xs text-faint">{hint}</span>}
        {aside && <div className="ml-auto flex items-center gap-2">{aside}</div>}
      </div>
      {children}
    </section>
  );
}

export function Label({ children, code }: { children: React.ReactNode; code?: string }) {
  return (
    <div className="mb-2 flex items-baseline justify-between gap-3">
      <span className="text-[11px] font-semibold uppercase tracking-[0.18em] text-muted">{children}</span>
      {code && <code className="font-mono text-[11px] text-faint">{code}</code>}
    </div>
  );
}

const CHIP = {
  brand: "bg-brand-soft text-brand-text",
  bad: "bg-bad-soft text-bad-text",
  boost: "bg-boost-soft text-boost-text",
  muted: "bg-surface-hover text-foreground",
  warn: "bg-warn-soft text-warn ring-1 ring-warn/40 ring-dashed",
} as const;
export type ChipTone = keyof typeof CHIP;

/** An editable list of short strings: remove with the ×, add with the + field. */
export function ChipList({
  values,
  onChange,
  tone = "brand",
  label,
  toneOf,
  titleOf,
}: {
  values: string[];
  onChange: (next: string[]) => void;
  tone?: ChipTone;
  label: string;
  toneOf?: (v: string) => ChipTone | undefined;
  titleOf?: (v: string) => string | undefined;
}) {
  const [adding, setAdding] = useState(false);
  const [draft, setDraft] = useState("");
  const commit = () => {
    const v = draft.trim();
    if (v && !values.some((x) => x.toLowerCase() === v.toLowerCase())) onChange([...values, v]);
    setDraft("");
    setAdding(false);
  };
  return (
    <ul className="flex flex-wrap gap-1.5" aria-label={label}>
      {values.map((v) => (
        <li
          key={v}
          title={titleOf?.(v)}
          className={cn("inline-flex items-center gap-1 rounded-md py-0.5 pr-1 pl-2 text-[13px]", CHIP[toneOf?.(v) ?? tone])}
        >
          {v}
          <button
            type="button"
            aria-label={`Remove ${v}`}
            onClick={() => onChange(values.filter((x) => x !== v))}
            className="rounded p-0.5 opacity-70 hover:opacity-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand/50"
          >
            <X className="size-3" />
          </button>
        </li>
      ))}
      <li>
        {adding ? (
          <input
            autoFocus
            value={draft}
            aria-label={`Add to ${label}`}
            onChange={(e) => setDraft(e.target.value)}
            onBlur={commit}
            onKeyDown={(e) => {
              if (e.key === "Enter") {
                e.preventDefault();
                commit();
              }
              if (e.key === "Escape") {
                setDraft("");
                setAdding(false);
              }
            }}
            className="w-36 rounded-md border border-brand/50 bg-surface px-2 py-0.5 text-[13px] focus:outline-none"
          />
        ) : (
          <button
            type="button"
            onClick={() => setAdding(true)}
            className="inline-flex items-center gap-1 rounded-md border border-dashed border-border px-2 py-0.5 text-[13px] text-muted hover:border-brand/50 hover:text-foreground"
          >
            <Plus className="size-3" /> Add
          </button>
        )}
      </li>
    </ul>
  );
}

/** POST JSON and return the body, throwing the server's error message. */
export async function postJson<T = Record<string, unknown>>(url: string, body: unknown): Promise<T> {
  const r = await fetch(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(j.error || `HTTP ${r.status}`);
  return j as T;
}

export function SaveBar({
  note,
  dirty,
  busy,
  error,
  saved,
  onSave,
  onDiscard,
  label = "Save changes",
}: {
  note: React.ReactNode;
  dirty: boolean;
  busy: boolean;
  error: string | null;
  saved: boolean;
  onSave: () => void;
  onDiscard?: () => void;
  label?: string;
}) {
  return (
    <div className="mt-6 flex flex-wrap items-center gap-3 border-t border-border pt-4">
      <p className={cn("mr-auto text-xs", error ? "text-bad-text" : "text-faint")} role={error ? "alert" : "status"}>
        {error ?? (saved && !dirty ? "Saved. A .bak copy of the previous file sits beside it." : note)}
      </p>
      {onDiscard && dirty && (
        <button type="button" onClick={onDiscard} className="px-2 py-1.5 text-sm text-muted hover:text-foreground">
          Discard
        </button>
      )}
      <button
        type="button"
        onClick={onSave}
        disabled={!dirty || busy}
        className="rounded-md bg-brand px-3 py-1.5 text-sm font-medium text-brand-foreground transition-colors hover:bg-brand-200 disabled:opacity-40 max-sm:min-h-[44px]"
      >
        {busy ? "Saving…" : label}
      </button>
    </div>
  );
}
