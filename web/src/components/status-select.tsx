"use client";

import { useId, useState } from "react";
import { useRouter } from "next/navigation";
import { Check } from "lucide-react";
import { Select } from "@/components/ui/field";
import { CANONICAL_STATES } from "@/lib/format";

// Status writeback control. Updates the existing tracker row (status cell) via
// /api/status — never adds rows. Reverts on failure; confirms with the
// terminal-popup animation.
export function StatusSelect({ n, current }: { n: string; current: string }) {
  const [status, setStatus] = useState(current);
  const [saved, setSaved] = useState(false);
  const [busy, setBusy] = useState(false);
  const router = useRouter();
  const id = useId();

  async function onChange(e: React.ChangeEvent<HTMLSelectElement>) {
    const next = e.target.value;
    const prev = status;
    setStatus(next);
    setBusy(true);
    try {
      const res = await fetch("/api/status", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ n, status: next }),
      });
      if (!res.ok) throw new Error("write failed");
      setSaved(true);
      setTimeout(() => setSaved(false), 2000);
      router.refresh();
    } catch {
      setStatus(prev); // revert on failure
    } finally {
      setBusy(false);
    }
  }

  const known = (CANONICAL_STATES as readonly string[]).includes(status);
  return (
    <span className="inline-flex items-center gap-2">
      {/* Inline label beside the control, so Select's stacked label prop does not fit here. */}
      <label htmlFor={id} className="text-xs text-muted">
        Status
      </label>
      <Select
        id={id}
        size="sm"
        value={status}
        onChange={onChange}
        disabled={busy}
        aria-busy={busy || undefined}
        className="w-auto max-sm:min-h-11"
      >
        {!known && <option value={status}>{status}</option>}
        {CANONICAL_STATES.map((s) => (
          <option key={s} value={s}>
            {s}
          </option>
        ))}
      </Select>
      <span role="status" className="inline-flex">
        {saved && (
          <span className="animate-terminal-popup inline-flex items-center gap-1 text-xs font-medium text-brand-text">
            <Check aria-hidden className="size-3" /> saved
          </span>
        )}
      </span>
    </span>
  );
}
