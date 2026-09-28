"use client";

import { useMemo, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { AlertTriangle, Check, Plus, RefreshCw, Route, X } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import type { HomeData } from "@/lib/home/home-data";
import { Bar, ChipList, CountUp, Panel, SaveBar, postJson } from "./motion-bits";

type Lanes = Exclude<HomeData["lanes"], null | { error: string }>;

// config/lanes.yml: which titles each evaluation lane claims. A lane keyword
// the title filter never lets through is dead weight, so drift is shown on the
// chip itself and in one fix-it box.
export function LanesPanel({ lanes, positives }: { lanes: Lanes; positives: string[] }) {
  const router = useRouter();
  const initial = useMemo(() => Object.fromEntries(lanes.list.map((l) => [l.id, l.title_keywords])), [lanes]);
  const [draft, setDraft] = useState(initial);
  const [busy, setBusy] = useState(false);
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [fixing, setFixing] = useState(false);
  const [fixError, setFixError] = useState<string | null>(null);
  const [rechecking, recheck] = useTransition();
  const edited = Object.keys(draft).filter((id) => JSON.stringify(draft[id]) !== JSON.stringify(initial[id]));
  const max = Math.max(1, ...lanes.list.map((l) => l.pending));

  const missing = [...new Set(lanes.list.flatMap((l) => Object.entries(l.drifted).filter(([, why]) => why === "missing").map(([kw]) => kw)))];
  const blocked = [...new Set(lanes.list.flatMap((l) => Object.entries(l.drifted).filter(([, why]) => why === "blocked").map(([kw]) => kw)))];

  async function save() {
    setBusy(true);
    setError(null);
    try {
      await postJson("/api/lanes", { lanes: Object.fromEntries(edited.map((id) => [id, draft[id]])) });
      setSaved(true);
      router.refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  async function addToTitleFilter() {
    setFixing(true);
    setFixError(null);
    try {
      await postJson("/api/portals", { filters: { title_filter: { positive: [...positives, ...missing] } } });
      router.refresh();
    } catch (e) {
      setFixError(e instanceof Error ? e.message : String(e));
    } finally {
      setFixing(false);
    }
  }

  return (
    <Panel icon={Route} title="Lanes" hint="config/lanes.yml" className="scroll-mt-6">
      {(missing.length > 0 || blocked.length > 0) && (
        <div role="alert" className="mb-5 rounded-xl border border-warn/40 bg-warn-soft px-4 py-3 text-sm">
          <div className="flex items-start gap-2.5">
            <AlertTriangle className="mt-0.5 size-4 shrink-0 text-warn" />
            <div className="flex-1 space-y-1.5">
              {missing.length > 0 && (
                <p className="text-foreground">
                  {missing.length === 1 ? "One lane keyword is" : `${missing.length} lane keywords are`} not in the title filter, so scans
                  never find those roles: <span className="font-medium">{missing.join(", ")}</span>.
                </p>
              )}
              {blocked.length > 0 && (
                <p className="text-foreground">
                  Blocked by an Exclude keyword in the title filter: <span className="font-medium">{blocked.join(", ")}</span>.
                </p>
              )}
              {fixError && <p className="text-xs text-bad-text">{fixError}</p>}
            </div>
            {missing.length > 0 && (
              <button
                type="button"
                onClick={addToTitleFilter}
                disabled={fixing}
                className="inline-flex shrink-0 items-center gap-1 rounded-md bg-surface px-2.5 py-1 text-xs font-medium text-foreground ring-1 ring-border hover:ring-warn/60 disabled:opacity-50"
              >
                <Plus className="size-3" /> {fixing ? "Adding…" : "Add to title filter"}
              </button>
            )}
          </div>
        </div>
      )}

      <div className="grid gap-3 md:grid-cols-2">
        {lanes.list.map((lane) => {
          const drift = Object.keys(lane.drifted).length;
          return (
            <article key={lane.id} className="rounded-xl border border-border bg-background/60 p-4">
              <header className="flex items-start gap-2">
                <div className="min-w-0 flex-1">
                  <h3 className="truncate font-medium text-foreground">{lane.archetype}</h3>
                  <code className="font-mono text-[11px] text-faint">{lane.id}</code>
                </div>
                {drift ? <Badge tone="warn">{`${drift} drifted`}</Badge> : <Badge tone="good">In sync</Badge>}
              </header>
              <div className="mt-3">
                <ChipList
                  label={`${lane.archetype} title keywords`}
                  tone="muted"
                  values={draft[lane.id] ?? []}
                  toneOf={(kw) => (lane.drifted[kw] ? "warn" : undefined)}
                  titleOf={(kw) =>
                    lane.drifted[kw] === "missing" ? "Not in the title filter" : lane.drifted[kw] === "blocked" ? "Blocked by an Exclude keyword" : undefined
                  }
                  onChange={(v) => {
                    setSaved(false);
                    setDraft((d) => ({ ...d, [lane.id]: v }));
                  }}
                />
              </div>
              {!!(lane.jd_gate?.positive?.length || lane.jd_gate?.negative?.length) && (
                <dl className="mt-3 space-y-1 text-xs">
                  {!!lane.jd_gate?.positive?.length && (
                    <div className="flex gap-1.5">
                      <dt className="shrink-0 text-faint">Needs one of</dt>
                      <dd className="text-muted">{lane.jd_gate.positive.join(", ")}</dd>
                    </div>
                  )}
                  {!!lane.jd_gate?.negative?.length && (
                    <div className="flex gap-1.5">
                      <dt className="shrink-0 text-faint">Rejects</dt>
                      <dd className="text-muted">{lane.jd_gate.negative.join(", ")}</dd>
                    </div>
                  )}
                </dl>
              )}
              <footer className="mt-4 space-y-1.5">
                <div className="flex justify-between text-xs">
                  <span className="text-faint">
                    {lane.max_evaluations ? `Up to ${lane.max_evaluations} evaluations per run` : "No evaluation cap"}
                  </span>
                  <span className="text-foreground">
                    <CountUp value={lane.pending} /> pending
                  </span>
                </div>
                <Bar pct={(lane.pending / max) * 100} className="bg-brand/70" />
              </footer>
            </article>
          );
        })}
      </div>

      <h3 className="mt-6 mb-2 text-[11px] font-semibold uppercase tracking-[0.18em] text-muted">Archetypes registered for evaluation</h3>
      <ul className="grid gap-x-6 gap-y-1.5 text-sm sm:grid-cols-2">
        {lanes.sites.map((s) => (
          <li key={s.site} className="flex items-start gap-2">
            {s.ok ? <Check aria-label="In sync" className="mt-0.5 size-4 shrink-0 text-good" /> : <X aria-label="Out of sync" className="mt-0.5 size-4 shrink-0 text-warn" />}
            <span className="min-w-0">
              <code className="font-mono text-[13px]">{s.site}</code>
              {!s.ok && s.note && <span className="block text-xs text-muted">{s.note}</span>}
            </span>
          </li>
        ))}
      </ul>
      <button
        type="button"
        onClick={() => recheck(() => router.refresh())}
        disabled={rechecking}
        className="mt-3 inline-flex items-center gap-1 text-xs text-muted hover:text-foreground"
      >
        <RefreshCw className={rechecking ? "size-3 animate-spin" : "size-3"} /> Re-check
      </button>

      <SaveBar
        note="Writes title_keywords only. Comments in lanes.yml are kept."
        dirty={edited.length > 0}
        busy={busy}
        error={error}
        saved={saved}
        onSave={save}
        onDiscard={() => setDraft(initial)}
        label="Save lanes"
      />
    </Panel>
  );
}
