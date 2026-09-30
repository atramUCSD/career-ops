"use client";

import { useState } from "react";
import { AnimatePresence, motion } from "motion/react";
import { Plus, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { listItem } from "@/components/ui/motion";
import { cn } from "@/lib/cn";

// Home's settings-panel pieces with no ui/ primitive: the chip editor, the
// save bar and the JSON POST helper.

// Every chip carries a border so the dashed warn chip is the same size as the rest.
const CHIP = {
  brand: "border-transparent bg-brand-soft text-brand-text",
  bad: "border-transparent bg-bad-soft text-bad-text",
  boost: "border-transparent bg-boost-soft text-boost-text",
  muted: "border-transparent bg-surface-muted text-foreground",
  warn: "border-dashed border-warn/40 bg-warn-soft text-warn",
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
    <ul className="relative flex flex-wrap gap-1.5" aria-label={label}>
      <AnimatePresence initial={false} mode="popLayout">
        {values.map((v) => (
        <motion.li
          key={v}
          {...listItem}
          title={titleOf?.(v)}
          className={cn("inline-flex items-center gap-1 rounded-md border py-0.5 pr-1 pl-2 text-sm", CHIP[toneOf?.(v) ?? tone])}
        >
          {v}
          <button
            type="button"
            aria-label={`Remove ${v}`}
            onClick={() => onChange(values.filter((x) => x !== v))}
            className="rounded-md p-0.5 opacity-70 transition-opacity duration-150 ease-out hover:opacity-100 focus-ring"
          >
            <X aria-hidden className="size-3" />
          </button>
        </motion.li>
        ))}
      </AnimatePresence>
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
            className="w-36 rounded-md border border-control-border bg-surface px-2 py-0.5 text-sm field-focus"
          />
        ) : (
          <button
            type="button"
            onClick={() => setAdding(true)}
            className="inline-flex items-center gap-1 rounded-md border border-dashed border-border px-2 py-0.5 text-sm text-muted transition-colors duration-150 ease-out hover:border-brand/50 hover:text-foreground focus-ring"
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
        <Button variant="ghost" onClick={onDiscard} className="text-muted">
          Discard
        </Button>
      )}
      <Button onClick={onSave} disabled={!dirty || busy} loading={busy}>
        {busy ? "Saving…" : label}
      </Button>
    </div>
  );
}
