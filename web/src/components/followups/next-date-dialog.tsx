"use client";

import { useId, useState } from "react";
import { Pin, PinOff } from "lucide-react";
import { localISODate, type CadenceEntry } from "@/lib/followups";
import { Button } from "@/components/ui/button";
import { Dialog } from "@/components/ui/dialog";
import { Input } from "@/components/ui/field";

/** Local today + N days, as YYYY-MM-DD. */
function plusDays(n: number): string {
  const d = new Date();
  d.setDate(d.getDate() + n);
  return localISODate(d);
}

// Pin a custom NEXT follow-up date for one application — overrides the
// computed cadence (even revives a cold one) until a follow-up is logged after
// the pin, which resumes the normal schedule. POST/DELETE /api/followups/override.
export function NextDateDialog({
  entry,
  onClose,
  onChanged,
}: {
  entry: CadenceEntry;
  onClose: () => void;
  onChanged: () => void;
}) {
  const today = localISODate();
  const [date, setDate] = useState(() =>
    entry.nextFollowupDate && entry.nextFollowupDate > today ? entry.nextFollowupDate : plusDays(3),
  );
  const [busy, setBusy] = useState<"set" | "clear" | null>(null);
  const [error, setError] = useState<string | null>(null);
  const formId = useId();

  const call = async (method: "POST" | "DELETE", body: Record<string, unknown>, kind: "set" | "clear") => {
    setBusy(kind);
    setError(null);
    try {
      const res = await fetch("/api/followups/override", {
        method,
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      const j = (await res.json().catch(() => ({}))) as { error?: string };
      if (!res.ok) {
        setError(typeof j.error === "string" ? j.error : "Could not update the pin.");
        setBusy(null);
        return;
      }
      onChanged();
      onClose();
    } catch {
      setError("Could not update the pin.");
      setBusy(null);
    }
  };

  return (
    <Dialog
      open
      onClose={onClose}
      size="sm"
      title="Pin next follow-up"
      description={
        <>
          {entry.company} · {entry.role} <span className="text-faint">(#{entry.num})</span>
        </>
      }
      footer={
        <>
          {entry.nextOverride && (
            <Button
              type="button"
              variant="danger-ghost"
              loading={busy === "clear"}
              disabled={busy !== null}
              onClick={() => void call("DELETE", { appNum: entry.num }, "clear")}
              className="mr-auto"
              title={`Currently pinned to ${entry.nextOverride}`}
            >
              {busy !== "clear" && <PinOff aria-hidden className="size-3.5" />} Clear pin
            </Button>
          )}
          <Button variant="ghost" type="button" onClick={onClose} className="text-muted">
            Cancel
          </Button>
          <Button type="submit" form={formId} loading={busy === "set"} disabled={busy !== null}>
            {busy !== "set" && <Pin aria-hidden className="size-3.5" />} Pin date
          </Button>
        </>
      }
    >
      <form
        id={formId}
        onSubmit={(e) => {
          e.preventDefault();
          void call("POST", { appNum: entry.num, date }, "set");
        }}
        className="space-y-3"
      >
        <Input
          label="Next follow-up date"
          type="date"
          required
          value={date}
          min={today}
          onChange={(e) => setDate(e.target.value)}
        />
        <div className="flex gap-2" role="group" aria-label="Quick picks">
          {[3, 7, 14].map((n) => {
            const on = date === plusDays(n);
            return (
              <Button
                key={n}
                type="button"
                size="sm"
                variant={on ? "soft" : "secondary"}
                aria-pressed={on}
                onClick={() => setDate(plusDays(n))}
              >
                +{n} days
              </Button>
            );
          })}
        </div>
        <p className="text-xs leading-relaxed text-faint">
          Overrides the computed schedule until you log a follow-up, which resumes the normal cadence.
        </p>
        {error && (
          <p role="alert" className="text-xs text-bad-text">
            {error}
          </p>
        )}
      </form>
    </Dialog>
  );
}
