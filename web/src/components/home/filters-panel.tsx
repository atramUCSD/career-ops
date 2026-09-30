"use client";

import { useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import { Filter } from "lucide-react";
import type { Funnel } from "@/lib/home/home-data";
import { cn } from "@/lib/cn";
import { Card } from "@/components/ui/card";
import { CountUp, SegmentBar, type Tone } from "@/components/ui/charts";
import { Field, Input, Switch } from "@/components/ui/field";
import { ChipList, SaveBar, postJson, type ChipTone } from "./motion-bits";

type Draft = {
  title_filter: { positive: string[]; negative: string[]; seniority_boost: string[] };
  location_filter: { block_hard: string[]; always_allow: string[]; block: string[]; allow: string[]; strict: boolean };
  salary_filter: { min: number | null; max: number | null; currency: string };
  max_posting_age_days: number | null;
};

const list = (v: unknown) => (Array.isArray(v) ? v.filter((s): s is string => typeof s === "string") : []);
const num = (v: unknown) => (Number.isInteger(v) && (v as number) >= 0 ? (v as number) : null);
const obj = (v: unknown): Record<string, unknown> => (v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : {});

const changed = (next: object, prev: object) =>
  Object.fromEntries(
    Object.entries(next).filter(([k, v]) => v !== null && JSON.stringify(v) !== JSON.stringify((prev as Record<string, unknown>)[k])),
  );

function fromDoc(doc: Record<string, unknown>): Draft {
  const t = obj(doc.title_filter);
  const l = obj(doc.location_filter);
  const s = obj(doc.salary_filter);
  return {
    title_filter: { positive: list(t.positive), negative: list(t.negative), seniority_boost: list(t.seniority_boost) },
    location_filter: {
      block_hard: list(l.block_hard),
      always_allow: list(l.always_allow),
      block: list(l.block),
      allow: list(l.allow),
      strict: l.strict === true,
    },
    salary_filter: { min: num(s.min), max: num(s.max), currency: typeof s.currency === "string" ? s.currency : "USD" },
    max_posting_age_days: num(doc.max_posting_age_days),
  };
}

// The funnel's tones: where postings were dropped, then the ones that got through.
const TONES: Record<string, { bar: Tone; dot: string }> = {
  title: { bar: "bad", dot: "bg-bad" },
  location: { bar: "warn", dot: "bg-warn" },
  salary: { bar: "info", dot: "bg-info" },
  age: { bar: "muted", dot: "bg-muted/60" },
  known: { bar: "muted", dot: "bg-border" },
  other: { bar: "muted", dot: "bg-faint/50" },
  new: { bar: "brand", dot: "bg-brand" },
};

const LOCATION: { key: keyof Omit<Draft["location_filter"], "strict">; title: string; hint: string; tone: ChipTone }[] = [
  { key: "block_hard", title: "Block hard", hint: "Dropped even when an allow term also matches.", tone: "bad" },
  { key: "always_allow", title: "Always allow", hint: "Kept regardless of the block list below.", tone: "brand" },
  { key: "block", title: "Block", hint: "Dropped unless always-allowed.", tone: "bad" },
  { key: "allow", title: "Allow", hint: "When set, only these pass, plus titles that say remote.", tone: "brand" },
];

export function FiltersPanel({ filters, funnel }: { filters: Record<string, unknown> | null; funnel: Funnel | null }) {
  const router = useRouter();
  const initial = useMemo(() => fromDoc(filters ?? {}), [filters]);
  const [draft, setDraft] = useState(initial);
  const [busy, setBusy] = useState(false);
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const dirty = JSON.stringify(draft) !== JSON.stringify(initial);
  const edit = (fn: (d: Draft) => Draft) => {
    setSaved(false);
    setDraft(fn);
  };

  async function save() {
    setBusy(true);
    setError(null);
    // Only what changed goes out, so keys the user never set stay unset. A
    // cleared number is left as it was: the patch writer can set, not delete.
    const age = draft.max_posting_age_days;
    const filters = {
      title_filter: changed(draft.title_filter, initial.title_filter),
      location_filter: changed(draft.location_filter, initial.location_filter),
      salary_filter: changed(draft.salary_filter, initial.salary_filter),
      ...(age !== null && age !== initial.max_posting_age_days && { max_posting_age_days: age }),
    };
    try {
      await postJson("/api/portals", { filters });
      setSaved(true);
      router.refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  const numberInput = (value: number | null, onChange: (v: number | null) => void, label: string, width = "w-28") => (
    <Input
      type="number"
      min={0}
      value={value ?? ""}
      aria-label={label}
      onChange={(e) => onChange(e.target.value === "" ? null : Math.max(0, Math.trunc(Number(e.target.value))))}
      className={cn("tabular-nums", width)}
    />
  );

  return (
    <Card icon={Filter} title="Scan filters" hint="portals.yml">
      {funnel && funnel.found > 0 && (
        <Card inset className="mb-6 bg-background/60">
          <div className="mb-3 flex items-baseline justify-between text-xs text-faint">
            <span className="eyebrow font-semibold text-muted">Last scan</span>
            <span>
              <CountUp value={funnel.found} className="text-foreground" /> seen ·{" "}
              {new Date(funnel.at).toLocaleString("en-US", { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" })}
            </span>
          </div>
          <SegmentBar parts={funnel.segments.map((s) => ({ ...s, tone: TONES[s.key]?.bar ?? "muted" }))} />
          <dl className="mt-3 grid grid-cols-3 gap-x-4 gap-y-2 sm:grid-cols-7">
            {funnel.segments.map((s) => (
              <div key={s.key}>
                <dt className="flex items-center gap-1.5 text-2xs text-faint">
                  <span aria-hidden className={cn("size-2 rounded-full", TONES[s.key]?.dot)} />
                  {s.key === "new" ? "Passed" : s.label}
                </dt>
                <dd className={cn("text-sm font-semibold", s.key === "new" ? "text-brand-text" : "text-foreground")}>
                  <CountUp value={s.count} />
                </dd>
              </div>
            ))}
          </dl>
        </Card>
      )}

      <Field compact label="Title keywords" meta="title_filter">
      <div className="space-y-3">
        {(
          [
            ["positive", "Include", "brand"],
            ["negative", "Exclude", "bad"],
            ["seniority_boost", "Boost seniority", "boost"],
          ] as const
        ).map(([key, title, tone]) => (
          <div key={key} className="grid gap-1.5 sm:grid-cols-[8rem_1fr]">
            <span className="pt-0.5 text-xs text-muted">{title}</span>
            <ChipList
              label={title}
              tone={tone}
              values={draft.title_filter[key]}
              onChange={(v) => edit((d) => ({ ...d, title_filter: { ...d.title_filter, [key]: v } }))}
            />
          </div>
        ))}
      </div>
      </Field>

      <div className="mt-6 grid gap-5 sm:grid-cols-2">
        <Field compact label="Salary" meta="salary_filter" hint="Postings without a listed salary still pass.">
          <div className="flex flex-wrap items-center gap-2">
            {numberInput(draft.salary_filter.min, (v) => edit((d) => ({ ...d, salary_filter: { ...d.salary_filter, min: v } })), "Minimum salary")}
            <span className="text-faint">to</span>
            {numberInput(draft.salary_filter.max, (v) => edit((d) => ({ ...d, salary_filter: { ...d.salary_filter, max: v } })), "Maximum salary")}
            <Input
              value={draft.salary_filter.currency}
              maxLength={3}
              aria-label="Currency"
              onChange={(e) => edit((d) => ({ ...d, salary_filter: { ...d.salary_filter, currency: e.target.value.toUpperCase() } }))}
              className="w-16 px-2 uppercase"
            />
          </div>
        </Field>
        <Field compact label="Max posting age" meta="max_posting_age_days">
          <div className="flex items-center gap-2">
            {numberInput(draft.max_posting_age_days, (v) => edit((d) => ({ ...d, max_posting_age_days: v })), "Maximum posting age in days", "w-20")}
            <span className="text-sm text-muted">days</span>
          </div>
        </Field>
      </div>

      <div className="mt-6">
        <Field compact label="Location, in the order it is checked" meta="location_filter" hint="Terms match whole words, case-insensitive.">
        <ol className="divide-y divide-border rounded-xl border border-border">
          <li className="flex items-center gap-3 px-4 py-3">
            <span className="grid size-5 shrink-0 place-items-center rounded-full bg-surface-muted text-2xs font-semibold text-muted">1</span>
            <div className="flex-1">
              <div className="text-sm text-foreground">No location given</div>
              <div className="text-xs text-faint">
                {draft.location_filter.strict ? "Strict: dropped whenever a location list is set." : "Kept: some boards never list one."}
              </div>
            </div>
            <span className="text-xs text-muted">Strict</span>
            <Switch
              checked={draft.location_filter.strict}
              onChange={(v) => edit((d) => ({ ...d, location_filter: { ...d.location_filter, strict: v } }))}
              label="Strict location matching"
            />
          </li>
          {LOCATION.map((row, i) => (
            <li key={row.key} className="flex gap-3 px-4 py-3">
              <span className="grid size-5 shrink-0 place-items-center rounded-full bg-surface-muted text-2xs font-semibold text-muted">{i + 2}</span>
              <div className="min-w-0 flex-1 space-y-1.5">
                <div>
                  <div className="text-sm text-foreground">{row.title}</div>
                  <div className="text-xs text-faint">{row.hint}</div>
                </div>
                <ChipList
                  label={row.title}
                  tone={row.tone}
                  values={draft.location_filter[row.key]}
                  onChange={(v) => edit((d) => ({ ...d, location_filter: { ...d.location_filter, [row.key]: v } }))}
                />
              </div>
            </li>
          ))}
        </ol>
        </Field>
      </div>

      <SaveBar
        note="Saved filters apply from the next scan. Comments in portals.yml are kept."
        dirty={dirty}
        busy={busy}
        error={error}
        saved={saved}
        onSave={save}
        onDiscard={() => setDraft(initial)}
        label="Save filters"
      />
    </Card>
  );
}
