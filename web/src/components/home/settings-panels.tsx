"use client";

import { useMemo, useState } from "react";
import { Card } from "@/components/ui/card";
import { Dialog } from "@/components/ui/dialog";
import type { HomeData } from "@/lib/home/home-data";
import { ProfileCards } from "./profile-cards";
import { DigestPanel, type AlertsView } from "./digest-panel";
import { SetupPanel } from "./setup-panel";
import { FiltersPanel } from "./filters-panel";
import { LanesPanel } from "./lanes-panel";
import { PreferencesPanel } from "./preferences-panel";

export type Preview = { subject: string; html: string; to: string; quiet: boolean; counts: { fresh: number }; lastRun: string | null };

export const failed = (v: unknown): v is { error: string } => !!v && typeof v === "object" && "error" in v;

// The control center for the active profile, on /config. Every panel edits the
// same user-layer file the CLI reads, through the routes that keep a .bak.
export function SettingsPanels({ home }: { home: HomeData }) {
  const [preview, setPreview] = useState<Preview | { error: string } | null>(null);
  const [showPreview, setShowPreview] = useState(false);
  const alerts = failed(home.alerts) ? null : (home.alerts as unknown as AlertsView);
  const positives = useMemo(() => {
    const t = failed(home.filters) || !home.filters ? null : (home.filters.title_filter as { positive?: unknown } | undefined);
    return Array.isArray(t?.positive) ? t.positive.filter((s): s is string => typeof s === "string") : [];
  }, [home.filters]);

  // Composing the digest reads the whole pipeline (~1s): only when asked for here.
  function openPreview() {
    setShowPreview(true);
    if (preview && !failed(preview)) return;
    setPreview(null);
    fetch("/api/alerts")
      .then((r) => r.json())
      .then(setPreview)
      .catch((e) => setPreview({ error: String(e) }));
  }

  return (
    <>
      <div id="profiles" className="scroll-mt-6 max-md:scroll-mt-24">
        <ProfileCards profiles={home.profiles} active={home.active} />
      </div>

      <div id="digest" className="grid scroll-mt-6 max-md:scroll-mt-24 items-start gap-4 lg:grid-cols-[3fr_2fr]">
        {alerts ? (
          <DigestPanel
            key={JSON.stringify(alerts)}
            alerts={alerts}
            schedule={home.schedule}
            gmailMissing={home.gmailMissing}
            onPreview={openPreview}
          />
        ) : (
          <Broken title="Email digest" error={(home.alerts as { error: string }).error} />
        )}
        <SetupPanel checklist={home.checklist} schedule={home.schedule} gmailMissing={home.gmailMissing} checkedAt={home.checkedAt} />
      </div>

      <div id="filters" className="scroll-mt-6 max-md:scroll-mt-24">
        {failed(home.filters) ? (
          <Broken title="Scan filters" error={home.filters.error} />
        ) : (
          <FiltersPanel key={JSON.stringify(home.filters)} filters={home.filters} funnel={home.funnel} />
        )}
      </div>

      {home.lanes && (
        <div id="lanes" className="scroll-mt-6 max-md:scroll-mt-24">
          {failed(home.lanes) ? (
            <Broken title="Lanes" error={home.lanes.error} />
          ) : (
            <LanesPanel key={JSON.stringify(home.lanes)} lanes={home.lanes} positives={positives} />
          )}
        </div>
      )}

      <div id="preferences" className="scroll-mt-6 max-md:scroll-mt-24">
        {failed(home.prefs) ? <Broken title="Preferences" error={home.prefs.error} /> : <PreferencesPanel key={JSON.stringify(home.prefs)} prefs={home.prefs} />}
      </div>

      {showPreview && <PreviewDialog preview={preview} onClose={() => setShowPreview(false)} />}
    </>
  );
}

/** A file that exists but does not parse: say which and why rather than showing defaults over it. */
function Broken({ title, error }: { title: string; error: string }) {
  return (
    <Card as="section" tone="bad" role="alert">
      <h2 className="eyebrow text-sm font-semibold text-bad-text">{title}</h2>
      <p className="mt-2 text-sm text-foreground">{error}</p>
      <p className="mt-1 text-xs text-muted">Fix the file by hand; nothing here writes over it while it is broken.</p>
    </Card>
  );
}

export function PreviewDialog({ preview, onClose }: { preview: Preview | { error: string } | null; onClose: () => void }) {
  const ok = preview && !failed(preview) ? preview : null;
  return (
    <Dialog
      open
      onClose={onClose}
      size="xl"
      title={<span className="block truncate">{ok ? ok.subject : "Digest preview"}</span>}
      description={
        ok ? (
          <span className="block truncate">
            To {ok.to || "no one yet"}
            {ok.quiet && " · would be skipped: nothing new"}
          </span>
        ) : undefined
      }
    >
      {!preview ? (
        <p className="text-sm text-muted">Composing…</p>
      ) : failed(preview) ? (
        <p role="alert" className="text-sm text-bad-text">
          {preview.error}
        </p>
      ) : (
        // No allow-scripts: the digest embeds posting titles from job boards.
        <iframe
          title="Digest preview"
          sandbox="allow-popups allow-popups-to-escape-sandbox"
          srcDoc={`<base target="_blank">${preview.html}`}
          className="block size-full rounded-xl border border-border bg-white"
        />
      )}
    </Dialog>
  );
}
