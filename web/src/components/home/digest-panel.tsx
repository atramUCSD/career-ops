"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { Eye, Mail, Send } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import type { Schedule } from "@/lib/home/home-data";
import { Label, Panel, SaveBar, Toggle, postJson } from "./motion-bits";

export type AlertsView = {
  enabled: boolean;
  to: string;
  min_match: number;
  max_rows: number;
  quiet_if_empty: boolean;
  attach_artifact: boolean;
  exists: boolean;
  lastRun: string | null;
};

const EDITABLE = ["enabled", "to", "min_match", "max_rows", "quiet_if_empty", "attach_artifact"] as const;
type Draft = Pick<AlertsView, (typeof EDITABLE)[number]>;
const pick = (a: AlertsView): Draft => Object.fromEntries(EDITABLE.map((k) => [k, a[k]])) as Draft;

/** "today at 7:00 PM" / "tomorrow at 7:00 AM" / "Mon, Oct 3 at 7:00 AM". */
export function when(iso: string | null): string | null {
  if (!iso) return null;
  const d = new Date(iso);
  const day = (x: Date) => new Date(x.getFullYear(), x.getMonth(), x.getDate()).getTime();
  const diff = Math.round((day(d) - day(new Date())) / 86_400_000);
  const time = d.toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit" });
  const date =
    diff === 0 ? "today" : diff === 1 ? "tomorrow" : diff === -1 ? "yesterday" : d.toLocaleDateString("en-US", { weekday: "short", month: "short", day: "numeric" });
  return `${date} at ${time}`;
}

export function DigestPanel({
  alerts,
  schedule,
  gmailMissing,
  onPreview,
}: {
  alerts: AlertsView;
  schedule: Schedule | null;
  gmailMissing: string[];
  onPreview: () => void;
}) {
  const router = useRouter();
  const [draft, setDraft] = useState<Draft>(() => pick(alerts));
  const [busy, setBusy] = useState(false);
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [action, setAction] = useState<{ busy?: string; message?: string; error?: boolean }>({});
  const dirty = EDITABLE.some((k) => draft[k] !== alerts[k]);
  const set = <K extends keyof Draft>(k: K, v: Draft[K]) => {
    setSaved(false);
    setDraft((d) => ({ ...d, [k]: v }));
  };

  async function save() {
    setBusy(true);
    setError(null);
    try {
      await postJson("/api/alerts", { config: draft });
      setSaved(true);
      router.refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  async function run(kind: "test" | "seed") {
    if (kind === "test" && !window.confirm(`Send a real test digest to ${alerts.to} now?`)) return;
    if (kind === "seed" && !window.confirm("Mark every current match as already sent? The next digest will only carry roles found after this.")) return;
    setAction({ busy: kind });
    try {
      const r = await postJson<{ message?: string }>("/api/alerts", { action: kind });
      setAction({ message: r.message || (kind === "test" ? "Test sent." : "Marked as seen.") });
      if (kind === "seed") router.refresh();
    } catch (e) {
      setAction({ message: e instanceof Error ? e.message : String(e), error: true });
    }
  }

  const next = when(schedule?.nextRun ?? null);
  const last = when(alerts.lastRun);
  const gmailOk = gmailMissing.length === 0;

  return (
    <Panel
      icon={Mail}
      title="Email digest"
      hint={alerts.exists ? "config/alerts.yml" : "not set up yet"}
      aside={<Toggle checked={draft.enabled} onChange={(v) => set("enabled", v)} label="Digest on" />}
    >
      <div className="grid gap-px overflow-hidden rounded-xl border border-border bg-border text-sm sm:grid-cols-2">
        <div className="bg-background/60 px-4 py-3">
          <div className="text-[11px] uppercase tracking-[0.14em] text-faint">Last sent</div>
          <div className="text-foreground">{last ?? "Not yet"}</div>
        </div>
        <div className="bg-background/60 px-4 py-3">
          <div className="text-[11px] uppercase tracking-[0.14em] text-faint">Next</div>
          <div className="text-foreground">{draft.enabled ? (next ?? "Not scheduled") : "Off"}</div>
        </div>
      </div>

      <div className="mt-5 grid gap-5 md:grid-cols-2">
        <div>
          <Label code="to">Send to</Label>
          <input
            type="text"
            inputMode="email"
            value={draft.to}
            onChange={(e) => set("to", e.target.value)}
            placeholder="name@example.com"
            aria-label="Send to"
            className="w-full rounded-md border border-border bg-background px-3 py-2 text-sm"
          />
          <p className="mt-1.5 text-xs text-faint">
            Sent from your own Gmail through OAuth.{" "}
            {gmailOk ? (
              <span className="text-brand-text">Connected.</span>
            ) : (
              <span className="text-warn">Not connected: {gmailMissing.join(", ")} unset in .env.</span>
            )}
          </p>
        </div>
        <div>
          <Label>Schedule</Label>
          <p className="rounded-md border border-border bg-background/60 px-3 py-2 text-sm text-foreground">
            {schedule?.times.length ? schedule.times.join(" · ") : "No scheduled task found"}
          </p>
          <p className="mt-1.5 text-xs text-faint">Set by the career-ops-alert task in Task Scheduler.</p>
        </div>
        <div>
          <Label code="min_match">Min match</Label>
          <div className="flex items-center gap-3">
            <input
              type="range"
              min={0}
              max={100}
              value={draft.min_match}
              onChange={(e) => set("min_match", Number(e.target.value))}
              aria-label="Minimum match percent"
              className="flex-1 accent-[var(--color-brand)]"
            />
            <span className="w-12 text-right text-sm font-semibold tabular-nums text-foreground">{draft.min_match}%</span>
          </div>
        </div>
        <div>
          <Label code="max_rows">Max rows</Label>
          <input
            type="number"
            min={1}
            max={100}
            value={draft.max_rows}
            onChange={(e) => set("max_rows", Math.trunc(Number(e.target.value)))}
            aria-label="Maximum rows"
            className="w-24 rounded-md border border-border bg-background px-3 py-2 text-sm tabular-nums"
          />
        </div>
      </div>

      <div className="mt-5 divide-y divide-border rounded-xl border border-border">
        {(
          [
            ["quiet_if_empty", "Skip when nothing is new", "No mail on a run that found nothing fresh."],
            ["attach_artifact", "Attach the pipeline page", "Adds the Corridor pipeline HTML to each digest."],
          ] as const
        ).map(([k, title, hint]) => (
          <div key={k} className="flex items-center gap-4 px-4 py-3">
            <div className="flex-1">
              <div className="text-sm text-foreground">{title}</div>
              <div className="text-xs text-faint">{hint}</div>
            </div>
            <Toggle checked={draft[k]} onChange={(v) => set(k, v)} label={title} />
          </div>
        ))}
      </div>

      <div className="mt-5 flex flex-wrap items-center gap-2">
        <button
          type="button"
          onClick={onPreview}
          className="inline-flex items-center gap-1.5 rounded-md border border-border px-3 py-1.5 text-sm hover:border-brand/50 max-sm:min-h-[44px]"
        >
          <Eye className="size-4" /> Preview
        </button>
        <button
          type="button"
          onClick={() => run("test")}
          disabled={!!action.busy || !alerts.to || !gmailOk || dirty}
          title={dirty ? "Save first: the test uses the saved settings" : undefined}
          className="inline-flex items-center gap-1.5 rounded-md border border-border px-3 py-1.5 text-sm hover:border-brand/50 disabled:opacity-40 max-sm:min-h-[44px]"
        >
          <Send className="size-4" /> {action.busy === "test" ? "Sending…" : "Send test"}
        </button>
        <button
          type="button"
          onClick={() => run("seed")}
          disabled={!!action.busy}
          className="rounded-md px-3 py-1.5 text-sm text-muted hover:text-foreground disabled:opacity-40 max-sm:min-h-[44px]"
        >
          {action.busy === "seed" ? "Marking…" : "Mark all seen"}
        </button>
        {action.message && (
          <span role="status" className={action.error ? "text-xs text-bad-text" : "text-xs text-muted"}>
            {action.message}
          </span>
        )}
      </div>

      <SaveBar
        note={
          <>
            Writes <code className="font-mono">config/alerts.yml</code>, comments kept.{" "}
            {!alerts.exists && <Badge tone="info">Creates the file</Badge>}
          </>
        }
        dirty={dirty}
        busy={busy}
        error={error}
        saved={saved}
        onSave={save}
        onDiscard={() => setDraft(pick(alerts))}
      />
    </Panel>
  );
}
