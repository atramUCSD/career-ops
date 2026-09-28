"use client";

import { useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import { SlidersHorizontal } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { CadenceSettings } from "@/components/followups/cadence-settings";
import { cn } from "@/lib/cn";
import { ChipList, Label, Panel, SaveBar, postJson } from "./motion-bits";

const TIERS = [
  { id: "economy", label: "Economy", hint: "cheapest and fastest, good for scanning lots of offers quickly" },
  { id: "standard", label: "Standard", hint: "balanced cost and quality (default if you're not sure)" },
  { id: "premium", label: "Premium", hint: "most capable model, best for offers you really care about" },
] as const;

const FIT: Record<string, "good" | "info" | "muted"> = { primary: "good", secondary: "info", adjacent: "muted" };

const obj = (v: unknown): Record<string, unknown> => (v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : {});
const str = (v: unknown) => (typeof v === "string" ? v : typeof v === "number" ? String(v) : "");

type Draft = { roles: string[]; targetRange: string; walkAway: string; currency: string; language: string; spendTier: string };

function fromDoc(doc: Record<string, unknown>): Draft {
  const primary = obj(doc.target_roles).primary;
  const comp = obj(doc.compensation);
  return {
    roles: Array.isArray(primary) ? primary.filter((r): r is string => typeof r === "string") : [],
    targetRange: str(comp.target_range),
    walkAway: str(comp.minimum),
    currency: str(comp.currency),
    language: str(obj(doc.language).output) || "en",
    spendTier: str(doc.spend_tier) || "standard",
  };
}

export function PreferencesPanel({ prefs }: { prefs: Record<string, unknown> | null }) {
  const router = useRouter();
  const doc = prefs ?? {};
  const initial = useMemo(() => fromDoc(prefs ?? {}), [prefs]);
  const [draft, setDraft] = useState(initial);
  const [busy, setBusy] = useState(false);
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const dirty = JSON.stringify(draft) !== JSON.stringify(initial);
  const set = <K extends keyof Draft>(k: K, v: Draft[K]) => {
    setSaved(false);
    setDraft((d) => ({ ...d, [k]: v }));
  };

  const archetypes = (Array.isArray(obj(doc.target_roles).archetypes) ? (obj(doc.target_roles).archetypes as unknown[]) : []).map(obj);
  const loc = obj(doc.location);
  const basedIn = [loc.city, loc.country].map(str).filter(Boolean).join(", ") || str(obj(doc.candidate).location);
  const visa = [str(loc.visa_status), loc.needs_sponsorship === true ? "needs sponsorship" : loc.needs_sponsorship === false ? "no sponsorship needed" : ""]
    .filter(Boolean)
    .join(" · ");

  async function save() {
    setBusy(true);
    setError(null);
    // Only changed fields: the writer skips empty text rather than clearing it,
    // so sending an untouched blank would be a no-op at best.
    const patch = Object.fromEntries(Object.entries(draft).filter(([k, v]) => JSON.stringify(v) !== JSON.stringify(initial[k as keyof Draft])));
    try {
      await postJson("/api/profile", patch);
      setSaved(true);
      router.refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  const text = (k: "targetRange" | "walkAway" | "currency" | "language", label: string, width: string, placeholder = "") => (
    <input
      value={draft[k]}
      aria-label={label}
      placeholder={placeholder}
      onChange={(e) => set(k, e.target.value)}
      className={cn("rounded-md border border-border bg-background px-3 py-2 text-sm", width)}
    />
  );

  return (
    <Panel icon={SlidersHorizontal} title="Preferences" hint="config/profile.yml">
      <Label code="target_roles.primary">Target roles</Label>
      <ChipList label="Target roles" values={draft.roles} onChange={(v) => set("roles", v)} />

      {archetypes.length > 0 && (
        <div className="mt-5">
          <Label code="target_roles.archetypes">Archetypes</Label>
          <ul className="divide-y divide-border rounded-xl border border-border text-sm">
            {archetypes.map((a, i) => (
              <li key={`${str(a.name)}-${i}`} className="flex items-center gap-3 px-4 py-2">
                <span className="flex-1 text-foreground">{str(a.name)}</span>
                {str(a.level) && <span className="text-xs text-faint">{str(a.level)}</span>}
                {str(a.fit) && <Badge tone={FIT[str(a.fit)] ?? "muted"}>{str(a.fit)}</Badge>}
              </li>
            ))}
          </ul>
          <p className="mt-1.5 text-xs text-faint">Edited by hand or with the assistant; scoring reads them from modes/_profile.md too.</p>
        </div>
      )}

      <div className="mt-5 grid gap-5 sm:grid-cols-2">
        <div>
          <Label code="compensation">Compensation</Label>
          <div className="flex flex-wrap items-center gap-2">
            {text("targetRange", "Target range", "w-36", "e.g. 140000-170000")}
            {text("currency", "Currency", "w-16", "USD")}
          </div>
          <div className="mt-2 flex items-center gap-2">
            <span className="text-xs text-muted">Walk away below</span>
            {text("walkAway", "Walk-away minimum", "w-32")}
          </div>
        </div>
        <div className="space-y-4">
          <div>
            <Label code="location">Based in</Label>
            <p className="text-sm text-foreground">{basedIn || <span className="text-faint">Not set</span>}</p>
            {str(loc.timezone) && <p className="text-xs text-faint">{str(loc.timezone)}</p>}
            {visa && <p className="text-xs text-muted">{visa}</p>}
          </div>
          <div>
            <Label code="language.output">Writes in</Label>
            {text("language", "Output language code", "w-24", "en")}
          </div>
        </div>
      </div>

      <div className="mt-5">
        <Label code="spend_tier">Model spend</Label>
        <div role="radiogroup" aria-label="Model spend" className="inline-flex rounded-lg border border-border bg-background p-0.5">
          {TIERS.map((t) => (
            <button
              key={t.id}
              type="button"
              role="radio"
              aria-checked={draft.spendTier === t.id}
              onClick={() => set("spendTier", t.id)}
              className={cn(
                "rounded-md px-3 py-1.5 text-sm transition-colors max-sm:min-h-[44px]",
                draft.spendTier === t.id ? "bg-brand text-brand-foreground" : "text-muted hover:text-foreground",
              )}
            >
              {t.label}
            </button>
          ))}
        </div>
        <p className="mt-1.5 text-xs text-faint">{TIERS.find((t) => t.id === draft.spendTier)?.hint}</p>
      </div>

      <SaveBar
        note="Writes config/profile.yml and keeps a .bak copy."
        dirty={dirty}
        busy={busy}
        error={error}
        saved={saved}
        onSave={save}
        onDiscard={() => setDraft(initial)}
        label="Save preferences"
      />

      <CadenceSettings />
    </Panel>
  );
}
