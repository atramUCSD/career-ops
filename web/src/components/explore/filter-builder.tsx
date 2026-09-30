"use client";

import { useState } from "react";
import { X, Ban, Clock, MapPin, ChevronDown, SlidersHorizontal } from "lucide-react";
import { cn } from "@/lib/cn";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Field } from "@/components/ui/field";
import { ATS_LABEL, ATS_SOURCES, cleanChips, type AtsSource, type ExploreFilters } from "@/lib/explore";

const RECENCY = [
  { label: "24h", days: 1 },
  { label: "3d", days: 3 },
  { label: "7d", days: 7 },
  { label: "14d", days: 14 },
  { label: "30d", days: 30 },
];

const STYLE = `
.co-fb__chip{display:inline-flex;align-items:center;gap:.375rem;border-radius:999px;padding:.125rem .5rem;font-size:.875rem;line-height:1.2;border:1px solid transparent}
.co-fb__chip button{display:inline-flex;align-items:center;opacity:.6;transition:opacity .15s}
.co-fb__chip button:hover{opacity:1}
.co-fb__chip.inc{color:var(--brand-text);background:color-mix(in srgb,var(--brand) 11%,transparent);border-color:color-mix(in srgb,var(--brand) 26%,transparent)}
.co-fb__field{display:flex;flex-wrap:wrap;gap:.375rem;align-items:center;min-height:2.25rem;padding:.25rem .375rem;border-radius:.375rem}
.co-fb__field input{flex:1;min-width:7rem;background:transparent;border:none;outline:none;font-size:.875rem;color:inherit}
.co-fb__field input::placeholder{color:var(--faint)}
@media (max-width:639px){.co-fb__chip button{align-items:center;justify-content:center;min-width:32px;min-height:32px;margin:-.5rem -.5rem -.5rem -.25rem}.co-fb__field{min-height:44px;row-gap:.75rem}.co-fb__field input{min-height:32px}}
`;

function KeywordField({
  values,
  tone,
  placeholder,
  ariaLabel,
  onChange,
}: {
  values: string[];
  tone: "inc" | "exc";
  placeholder: string;
  ariaLabel: string;
  onChange: (v: string[]) => void;
}) {
  const [draft, setDraft] = useState("");
  // Split only on UNAMBIGUOUS item separators (comma / newline / semicolon) — never
  // bare spaces, which are legitimate inside multi-word entries ("AI platform",
  // "New York", "Costa Rica"). A space-only paste stays one chip on purpose (#1147).
  const commit = (text: string) => {
    const parts = text.split(/[,\n;\t\r]+/);
    const next = cleanChips([...values, ...parts]);
    onChange(next);
    setDraft("");
  };
  return (
    <div className="co-fb__field border border-control-border bg-surface field-focus-within">
      {values.map((v) => (
        <span key={v} className={cn("co-fb__chip", tone === "inc" ? "inc" : "border-border bg-surface-muted text-muted")}>
          {tone === "exc" && <Ban aria-hidden className="size-3 opacity-70" />}
          {v}
          <button type="button" aria-label={`Remove ${v}`} onClick={() => onChange(values.filter((x) => x !== v))} className="rounded-full focus-ring">
            <X aria-hidden className="size-3" />
          </button>
        </span>
      ))}
      <input
        aria-label={ariaLabel}
        value={draft}
        onChange={(e) => {
          const val = e.target.value;
          if (/[,\n;\t\r]$/.test(val)) commit(val);
          else setDraft(val);
        }}
        onKeyDown={(e) => {
          if (e.key === "Enter" && draft.trim()) {
            e.preventDefault();
            commit(draft);
          } else if (e.key === "Backspace" && !draft && values.length) {
            onChange(values.slice(0, -1));
          }
        }}
        onPaste={(e) => {
          e.preventDefault();
          const text = e.clipboardData.getData("text");
          const merged = draft + text;
          // Only commit to chips when the paste contains item separators.
          // A plain-text paste (e.g. pasting "-EMEA" after typing "Remote")
          // stays in the input field so the user can keep editing.
          if (/[,;\n\t\r]/.test(text)) commit(merged);
          else setDraft(merged);
        }}
        onBlur={() => draft.trim() && commit(draft)}
        placeholder={values.length ? "" : placeholder}
      />
    </div>
  );
}

export function FilterBuilder({
  filters,
  onChange,
  seededFrom = [],
}: {
  filters: ExploreFilters;
  onChange: (f: ExploreFilters) => void;
  seededFrom?: string[];
}) {
  const [advanced, setAdvanced] = useState(false);
  const set = (patch: Partial<ExploreFilters>) => onChange({ ...filters, ...patch });
  const toggleAts = (a: AtsSource) => {
    const has = filters.ats.includes(a);
    const next = has ? filters.ats.filter((x) => x !== a) : [...filters.ats, a];
    set({ ats: next.length ? next : filters.ats });
  };

  return (
    <div className="space-y-4">
      <style>{STYLE}</style>

      <Field label="Roles to find" hint={filters.positive.length === 0 ? "empty = every fresh posting" : undefined}>
        <KeywordField values={filters.positive} tone="inc" placeholder="AI platform, ML infrastructure, staff engineer…" ariaLabel="Roles to find" onChange={(v) => set({ positive: v })} />
        {seededFrom.length > 0 && filters.positive.length > 0 && (
          <p className="mt-1.5 text-xs text-faint">Seeded from your {seededFrom.join(" + ")} — edit freely.</p>
        )}
      </Field>

      <Field label="Exclude">
        <KeywordField values={filters.negative} tone="exc" placeholder="manager, sales, contract…" ariaLabel="Exclude" onChange={(v) => set({ negative: v })} />
      </Field>

      <Field
        label={
          <span className="inline-flex items-center gap-1.5">
            <MapPin aria-hidden className="size-3.5 text-muted" /> City or location
          </span>
        }
        hint="matches any city, region, country, or Remote"
      >
        <KeywordField
          values={filters.allow}
          tone="inc"
          placeholder="Toronto, New York, Remote…"
          ariaLabel="City or location"
          onChange={(v) => set({ allow: v })}
        />
      </Field>

      <div className="flex flex-wrap items-start gap-x-8 gap-y-4">
        <div className="min-w-[18rem] max-sm:min-w-0">
          <Field
            label={
              <span className="inline-flex items-center gap-1.5">
                <Clock aria-hidden className="size-3.5 text-muted" /> Posted within
              </span>
            }
            hint="postings published in this window"
          >
            <div role="group" aria-label="Posted within" className="inline-flex rounded-xl border border-border bg-surface p-0.5">
              {RECENCY.map((r) => (
                <button
                  key={r.days}
                  type="button"
                  aria-pressed={filters.sinceDays === r.days}
                  onClick={() => set({ sinceDays: r.days })}
                  className={cn(
                    "rounded-md h-7 px-2 text-xs font-medium focus-ring transition-colors duration-150 ease-out max-sm:min-h-11",
                    filters.sinceDays === r.days ? "bg-brand-soft text-brand-text" : "text-muted hover:text-foreground",
                  )}
                >
                  {r.label}
                </button>
              ))}
            </div>
          </Field>
        </div>

        <Field label="Sources" hint={filters.ats.length === 0 ? "pick at least one" : undefined}>
          <div role="group" aria-label="Sources" className="flex flex-wrap gap-1.5">
            {ATS_SOURCES.map((a) => {
              const on = filters.ats.includes(a);
              return (
                <Button
                  key={a}
                  type="button"
                  size="sm"
                  variant={on ? "soft" : "secondary"}
                  aria-pressed={on}
                  onClick={() => toggleAts(a)}
                  className={cn(!on && "text-muted hover:text-foreground")}
                >
                  {ATS_LABEL[a]}
                </Button>
              );
            })}
          </div>
        </Field>
      </div>

      <Button
        type="button"
        variant="ghost"
        size="sm"
        aria-expanded={advanced}
        onClick={() => setAdvanced((v) => !v)}
        className="-ml-2 text-muted"
      >
        <SlidersHorizontal aria-hidden className="size-3.5" />
        More location controls &amp; scan depth
        <ChevronDown aria-hidden className={cn("size-3.5 motion-safe:transition-transform motion-safe:duration-200 motion-safe:ease-out", advanced && "rotate-180")} />
      </Button>

      {advanced && (
        <Card inset className="space-y-4">
          <div className="grid gap-4 sm:grid-cols-2">
            <Field label="Always include" hint="rescues a multi-location posting">
              <KeywordField values={filters.alwaysAllow} tone="inc" placeholder="Toronto…" ariaLabel="Always include" onChange={(v) => set({ alwaysAllow: v })} />
            </Field>
            <Field label="Exclude locations" hint="unless Always include also matches">
              <KeywordField values={filters.block} tone="exc" placeholder="India…" ariaLabel="Exclude locations" onChange={(v) => set({ block: v })} />
            </Field>
          </div>
          <Field label="Never include" hint="hard reject — overrides Always include">
            <KeywordField values={filters.blockHard} tone="exc" placeholder="USA, Brazil…" ariaLabel="Never include" onChange={(v) => set({ blockHard: v })} />
          </Field>
          <Field label="Scan depth" hint={`${filters.limitPerAts} companies / source`}>
            <input
              type="range"
              aria-label="Scan depth"
              min={50}
              max={500}
              step={50}
              value={filters.limitPerAts}
              onChange={(e) => set({ limitPerAts: Number(e.target.value) })}
              className="w-full rounded-md accent-brand focus-ring"
            />
          </Field>
        </Card>
      )}
    </div>
  );
}
