"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { ArrowRight, Bell, CircleHelp, Eye, Sparkles, X } from "lucide-react";
import { instrumentSerif } from "@/lib/fonts";
import { HeroGlow } from "@/components/hero-glow";
import { StatCard } from "@/components/ui/stat-card";
import type { Application } from "@/lib/career-ops";
import type { HomeData } from "@/lib/home/home-data";
import { QuickEvaluate } from "@/components/quick-evaluate";
import { scoreNum } from "@/lib/format";
import { pickAwaitingDecision } from "@/lib/home/awaiting.mjs";
import { CountUp } from "./motion-bits";
import { ProfileCards } from "./profile-cards";
import { DigestPanel, when, type AlertsView } from "./digest-panel";
import { SetupPanel } from "./setup-panel";
import { FiltersPanel } from "./filters-panel";
import { LanesPanel } from "./lanes-panel";
import { PreferencesPanel } from "./preferences-panel";

type Preview = { subject: string; html: string; to: string; quiet: boolean; counts: { fresh: number }; lastRun: string | null };

const failed = (v: unknown): v is { error: string } => !!v && typeof v === "object" && "error" in v;

// Home: the day's queue up top (supply: fresh scan matches; demand: follow-ups
// due), then the control center for the active profile. Every panel edits the
// same user-layer file the CLI reads, through the routes that keep a .bak.
export function TodayDashboard({ applications, inBetween, home }: { applications: Application[]; inBetween: boolean; home: HomeData }) {
  const router = useRouter();
  const [due, setDue] = useState(0);
  const [overdue, setOverdue] = useState(0);
  const [freshCount, setFreshCount] = useState(0);
  const [preview, setPreview] = useState<Preview | { error: string } | null>(null);
  const [showPreview, setShowPreview] = useState(false);
  const dateLabel = useMemo(() => new Date().toLocaleDateString("en-US", { weekday: "long", month: "short", day: "numeric" }), []);

  const refetch = useCallback(() => {
    fetch("/api/followups")
      .then((r) => r.json())
      .then((d) => {
        // /api/followups already filters to urgent/overdue: both are due now (#86).
        setDue((d.metadata?.overdue ?? 0) + (d.metadata?.urgent ?? 0));
        setOverdue(d.metadata?.overdue ?? 0);
      })
      .catch(() => {});
    fetch("/api/whats-new")
      .then((r) => r.json())
      .then((d) => {
        const count = Number(d.count);
        setFreshCount(Number.isFinite(count) ? Math.max(0, Math.trunc(count)) : Array.isArray(d.offers) ? d.offers.length : 0);
      })
      .catch(() => {});
    // Composing the digest reads the whole pipeline (~1s), so it loads after the page.
    fetch("/api/alerts")
      .then((r) => r.json())
      .then(setPreview)
      .catch((e) => setPreview({ error: String(e) }));
  }, []);

  useEffect(() => {
    refetch();
    // A worker just wrote a tracker row: refresh the server props and the queue.
    const onDone = () => {
      router.refresh();
      refetch();
    };
    window.addEventListener("co-job-done", onDone);
    return () => window.removeEventListener("co-job-done", onDone);
  }, [refetch, router]);

  // Ordering lives in lib/home/awaiting.mjs so it can be tested (#3529).
  const awaiting = useMemo(() => pickAwaitingDecision(applications, scoreNum), [applications]);
  const alerts = failed(home.alerts) ? null : (home.alerts as unknown as AlertsView);
  const fresh = preview && !failed(preview) ? preview.counts.fresh : null;
  const next = when(home.schedule?.nextRun ?? null);
  const allClear = freshCount === 0 && due === 0 && awaiting.length === 0;
  const positives = useMemo(() => {
    const t = failed(home.filters) || !home.filters ? null : (home.filters.title_filter as { positive?: unknown } | undefined);
    return Array.isArray(t?.positive) ? t.positive.filter((s): s is string => typeof s === "string") : [];
  }, [home.filters]);

  return (
    <div className="mx-auto max-w-6xl px-6 py-10 max-sm:pb-24">
      <section className="dot-bg relative overflow-hidden rounded-2xl border border-border bg-surface/40 px-7 py-10 md:px-10 md:py-12">
        <HeroGlow />
        {/* Readability scrim between the animated glow (z-0) and the copy (z-10). */}
        <div aria-hidden className="pointer-events-none absolute inset-0 z-[1] bg-surface/55 backdrop-blur-[2px] dark:bg-background/45" />
        <div className="relative z-10">
          <p className="font-mono text-xs uppercase tracking-[0.2em] text-muted">
            <span className="text-faint">//</span> today · <span className="tabular-nums">{dateLabel}</span>
          </p>
          <h1 className={`${instrumentSerif.className} mt-3 text-4xl leading-[1.05] text-landing md:text-5xl`}>
            {allClear ? (
              <>You&apos;re all caught up.</>
            ) : (
              <>
                {freshCount > 0 && (
                  <>
                    <CountUp value={freshCount} className="text-brand" /> new match{freshCount === 1 ? "" : "es"} this week.{" "}
                  </>
                )}
                {due > 0 && (
                  <>
                    <CountUp value={due} className="text-brand" /> follow-up{due === 1 ? "" : "s"} due today.
                  </>
                )}
                {freshCount === 0 && due === 0 && (
                  <>
                    <CountUp value={awaiting.length} className="text-brand" /> role{awaiting.length === 1 ? "" : "s"} awaiting your call.
                  </>
                )}
              </>
            )}
          </h1>
          <p className="mt-4 max-w-2xl text-sm text-muted">
            {alerts?.enabled && alerts.to && next ? (
              <>
                The next digest goes to <span className="text-foreground">{alerts.to}</span> {next}.
                {fresh !== null && (
                  <>
                    {" "}
                    <span className="text-foreground tabular-nums">{fresh}</span> new role{fresh === 1 ? "" : "s"} clear the {alerts.min_match}% match
                    floor so far.
                  </>
                )}
              </>
            ) : allClear ? (
              "I'll keep scanning in the background and surface anything that fits."
            ) : (
              "Your action queue for today: discovery and follow-ups, in one place."
            )}
          </p>
          <div className="mt-6 flex flex-wrap gap-2.5">
            <Link href="/explore" className="inline-flex items-center gap-2 rounded-full bg-brand px-5 py-2.5 text-sm font-medium text-brand-foreground transition hover:bg-brand-200 max-sm:min-h-[44px]">
              Find new roles <ArrowRight className="size-4" />
            </Link>
            <Link href="/pipeline" className="inline-flex items-center gap-2 rounded-full border border-border px-5 py-2.5 text-sm font-medium text-foreground transition hover:border-brand/40 hover:text-brand max-sm:min-h-[44px]">
              Open pipeline
            </Link>
            {alerts && (
              <button
                type="button"
                onClick={() => setShowPreview(true)}
                className="inline-flex items-center gap-2 rounded-full px-4 py-2.5 text-sm font-medium text-muted transition hover:text-foreground max-sm:min-h-[44px]"
              >
                <Eye className="size-4" /> Preview digest
              </button>
            )}
          </div>
          {inBetween && <QuickEvaluate />}
        </div>
      </section>

      <div className="mt-6 grid gap-3 sm:grid-cols-3">
        <StatCard
          href="/followups"
          icon={Bell}
          value={<CountUp value={due} />}
          label="Follow-ups due"
          hint={overdue ? `${overdue} overdue` : "A nudge beats silence"}
          featured
        />
        <StatCard href="/pipeline" icon={CircleHelp} value={<CountUp value={awaiting.length} />} label="Awaiting your decision" hint="Scored: apply or skip" corner="bl" />
        <StatCard
          href="/explore?view=fresh"
          icon={Sparkles}
          value={fresh === null ? "–" : <CountUp value={fresh} />}
          label="New since last digest"
          hint={alerts?.lastRun ? `Last sent ${when(alerts.lastRun)}` : "No digest sent yet"}
          corner="tr"
        />
      </div>

      <ProfileCards profiles={home.profiles} active={home.active} />

      <div className="mt-6 grid items-start gap-6 lg:grid-cols-[3fr_2fr]">
        {alerts ? (
          <DigestPanel
            key={JSON.stringify(alerts)}
            alerts={alerts}
            schedule={home.schedule}
            gmailMissing={home.gmailMissing}
            onPreview={() => setShowPreview(true)}
          />
        ) : (
          <Broken title="Email digest" error={(home.alerts as { error: string }).error} />
        )}
        <SetupPanel checklist={home.checklist} schedule={home.schedule} gmailMissing={home.gmailMissing} checkedAt={home.checkedAt} />
      </div>

      <div className="mt-6">
        {failed(home.filters) ? (
          <Broken title="Scan filters" error={home.filters.error} />
        ) : (
          <FiltersPanel key={JSON.stringify(home.filters)} filters={home.filters} funnel={home.funnel} />
        )}
      </div>

      {home.lanes && (
        <div id="lanes" className="mt-6 scroll-mt-6">
          {failed(home.lanes) ? (
            <Broken title="Lanes" error={home.lanes.error} />
          ) : (
            <LanesPanel key={JSON.stringify(home.lanes)} lanes={home.lanes} positives={positives} />
          )}
        </div>
      )}

      <div className="mt-6">
        {failed(home.prefs) ? <Broken title="Preferences" error={home.prefs.error} /> : <PreferencesPanel key={JSON.stringify(home.prefs)} prefs={home.prefs} />}
      </div>

      {showPreview && <PreviewDialog preview={preview} onClose={() => setShowPreview(false)} />}
    </div>
  );
}

/** A file that exists but does not parse: say which and why rather than showing defaults over it. */
function Broken({ title, error }: { title: string; error: string }) {
  return (
    <section role="alert" className="rounded-2xl border border-bad/40 bg-bad-soft p-6">
      <h2 className="text-sm font-semibold uppercase tracking-[0.16em] text-bad-text">{title}</h2>
      <p className="mt-2 text-sm text-foreground">{error}</p>
      <p className="mt-1 text-xs text-muted">Fix the file by hand; nothing here writes over it while it is broken.</p>
    </section>
  );
}

function PreviewDialog({ preview, onClose }: { preview: Preview | { error: string } | null; onClose: () => void }) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);
  return (
    <div className="fixed inset-0 z-50 grid place-items-center bg-black/50 p-4" onClick={onClose}>
      <div
        role="dialog"
        aria-modal="true"
        aria-label="Digest preview"
        onClick={(e) => e.stopPropagation()}
        className="flex h-[85vh] w-full max-w-3xl flex-col overflow-hidden rounded-2xl border border-border bg-surface shadow-2xl"
      >
        <header className="flex items-start gap-3 border-b border-border px-5 py-3">
          <div className="min-w-0 flex-1">
            <p className="truncate text-sm font-medium text-foreground">{preview && !failed(preview) ? preview.subject : "Digest preview"}</p>
            {preview && !failed(preview) && (
              <p className="truncate text-xs text-faint">
                To {preview.to || "no one yet"}
                {preview.quiet && " · would be skipped: nothing new"}
              </p>
            )}
          </div>
          <button type="button" autoFocus onClick={onClose} aria-label="Close preview" className="rounded p-1 text-muted hover:text-foreground">
            <X className="size-4" />
          </button>
        </header>
        {!preview ? (
          <p className="p-6 text-sm text-muted">Composing…</p>
        ) : failed(preview) ? (
          <p role="alert" className="p-6 text-sm text-bad-text">
            {preview.error}
          </p>
        ) : (
          // No allow-scripts: the digest embeds posting titles from job boards.
          <iframe
            title="Digest preview"
            sandbox="allow-popups allow-popups-to-escape-sandbox"
            srcDoc={`<base target="_blank">${preview.html}`}
            className="min-h-0 flex-1 bg-white"
          />
        )}
      </div>
    </div>
  );
}
