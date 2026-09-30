"use client";

import { useCallback, useEffect, useState } from "react";
import { Check, Loader2 } from "lucide-react";
import { PROFILE_CADENCE_KEYS, type ProfileCadenceKey } from "@/lib/followups";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Input } from "@/components/ui/field";

// Follow-up cadence knobs → config/profile.yml (followup_cadence). Server-
// persisted (unlike the localStorage engine prefs above) because the core
// followup-cadence.mjs reads the same keys — the CLI and the web must agree.

const FIELDS: { key: ProfileCadenceKey; label: string; hint: string }[] = [
  { key: "applied_first_days", label: "First follow-up", hint: "days after applying before the 1st nudge is due" },
  { key: "applied_subsequent_days", label: "Between follow-ups", hint: "days between nudges while Applied" },
  { key: "applied_max_followups", label: "Max follow-ups", hint: "after this many with no reply the lead goes cold" },
  { key: "responded_initial_days", label: "Reply window", hint: "answer a company response within this many days" },
  { key: "responded_subsequent_days", label: "Responded cadence", hint: "days between touches while in Responded" },
  { key: "interview_thankyou_days", label: "Thank-you note", hint: "due within this many days of reaching Interview" },
];

export function CadenceSettings() {
  const [values, setValues] = useState<Record<ProfileCadenceKey, string> | null>(null);
  const [loadError, setLoadError] = useState(false);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // On a failed load, do NOT fall back to defaults: the user would see 7/7/2/…
  // with no warning and a Save would overwrite their real profile.yml
  // overrides. Show an error + Retry instead.
  const load = useCallback(() => {
    setLoadError(false);
    fetch("/api/followups/cadence")
      .then((r) => {
        if (!r.ok) throw new Error(String(r.status));
        return r.json();
      })
      .then((d) => {
        // `effective` is already defaults+overrides, computed server-side from
        // the CORE's cadenceDefaults (#2369) — no local defaults table to merge
        // in. A key the core didn't supply renders empty rather than as an
        // invented number.
        const eff = (d?.effective ?? {}) as Partial<Record<ProfileCadenceKey, number>>;
        setValues(Object.fromEntries(
          PROFILE_CADENCE_KEYS.map((k) => [k, eff[k] === undefined ? "" : String(eff[k])]),
        ) as Record<ProfileCadenceKey, string>);
      })
      .catch(() => setLoadError(true));
  }, []);
  useEffect(load, [load]);

  const save = async () => {
    if (!values) return;
    const payload: Partial<Record<ProfileCadenceKey, number>> = {};
    for (const k of PROFILE_CADENCE_KEYS) {
      // Number(), not parseInt(): "3.5" and "7abc" must be rejected, not truncated.
      const raw = values[k].trim();
      const n = raw === "" ? Number.NaN : Number(raw);
      if (!Number.isInteger(n) || n < 0) {
        setError(`"${FIELDS.find((f) => f.key === k)?.label}" must be a whole number ≥ 0.`);
        return;
      }
      payload[k] = n;
    }
    setSaving(true);
    setError(null);
    try {
      const res = await fetch("/api/followups/cadence", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
      const j = await res.json().catch(() => ({}));
      if (!res.ok) {
        setError(typeof j.error === "string" ? j.error : "Could not save.");
      } else {
        setSaved(true);
        setTimeout(() => setSaved(false), 2000);
      }
    } catch {
      setError("Could not save.");
    }
    setSaving(false);
  };

  return (
    <section>
      <h2 className="mt-8 mb-3 eyebrow text-xs font-semibold text-muted">Follow-up cadence</h2>
      <Card inset>
        <p className="text-xs leading-relaxed text-faint">
          When the <span className="text-muted">Follow-ups</span> tracker nudges you. Saved to{" "}
          <span className="font-mono text-muted">config/profile.yml</span> — the CLI uses the same values.
        </p>
        {loadError ? (
          <div className="mt-3 text-sm text-muted">
            <p role="alert" className="text-bad-text">
              Couldn&apos;t read your current cadence settings — not showing defaults, to avoid overwriting real values in{" "}
              <span className="font-mono">config/profile.yml</span>.
            </p>
            <Button type="button" variant="secondary" size="sm" onClick={load} className="mt-2">
              Retry
            </Button>
          </div>
        ) : values === null ? (
          <div className="mt-3 flex items-center gap-2 text-sm text-muted">
            <Loader2 aria-hidden className="size-4 motion-safe:animate-spin" /> Loading…
          </div>
        ) : (
          <>
            <div className="mt-4 grid gap-4 sm:grid-cols-2">
              {FIELDS.map((f) => (
                <Input
                  key={f.key}
                  label={f.label}
                  hint={f.hint}
                  type="number"
                  min={0}
                  step={1}
                  value={values[f.key]}
                  onChange={(e) => setValues((v) => (v ? { ...v, [f.key]: e.target.value } : v))}
                  className="w-24 tabular-nums"
                />
              ))}
            </div>
            {error && (
              <p role="alert" className="mt-3 text-xs text-bad-text">
                {error}
              </p>
            )}
            <Button type="button" variant="secondary" size="sm" onClick={save} loading={saving} className="mt-4">
              {saved && <Check aria-hidden className="size-3.5 text-brand-text" />}
              {saved ? "Saved" : "Save cadence"}
            </Button>
          </>
        )}
      </Card>
    </section>
  );
}
