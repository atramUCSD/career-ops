"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { ArrowRight, Bell, CircleHelp, Eye, Sparkles } from "lucide-react";
import { motion } from "motion/react";
import { DURATION, EASE_OUT } from "@/components/ui/motion";
import { HeroGlow } from "@/components/hero-glow";
import { Card } from "@/components/ui/card";
import { Dialog } from "@/components/ui/dialog";
import { StatCard } from "@/components/ui/stat-card";
import { cn } from "@/lib/cn";
import type { Application } from "@/lib/career-ops";
import type { HomeData } from "@/lib/home/home-data";
import { QuickEvaluate } from "@/components/quick-evaluate";
import { scoreNum } from "@/lib/format";
import { pickAwaitingDecision } from "@/lib/home/awaiting.mjs";
import { CountUp } from "@/components/ui/charts";
import { ProfileCards } from "./profile-cards";
import { DigestPanel, when, type AlertsView } from "./digest-panel";
import { SetupPanel } from "./setup-panel";
import { FiltersPanel } from "./filters-panel";
import { LanesPanel } from "./lanes-panel";
import { PreferencesPanel } from "./preferences-panel";

type Preview = { subject: string; html: string; to: string; quiet: boolean; counts: { fresh: number }; lastRun: string | null };

// The three hero actions keep their pill shape (DESIGN.md section 5 exception).
const HERO_LINK =
  "inline-flex items-center gap-2 rounded-full px-5 py-2.5 text-sm font-medium focus-ring transition-colors duration-150 ease-out max-sm:min-h-11";

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
  // Counts start at 0: hide the headline until the first follow-ups/whats-new pair settles so its text never swaps.
  const [loaded, setLoaded] = useState(false);
  const dateLabel = useMemo(() => new Date().toLocaleDateString("en-US", { weekday: "long", month: "short", day: "numeric" }), []);

  const refetch = useCallback(() => {
    const followups = fetch("/api/followups")
      .then((r) => r.json())
      .then((d) => {
        // /api/followups already filters to urgent/overdue: both are due now (#86).
        setDue((d.metadata?.overdue ?? 0) + (d.metadata?.urgent ?? 0));
        setOverdue(d.metadata?.overdue ?? 0);
      })
      .catch(() => {});
    const whatsNew = fetch("/api/whats-new")
      .then((r) => r.json())
      .then((d) => {
        const count = Number(d.count);
        setFreshCount(Number.isFinite(count) ? Math.max(0, Math.trunc(count)) : Array.isArray(d.offers) ? d.offers.length : 0);
      })
      .catch(() => {});
    Promise.allSettled([followups, whatsNew]).then(() => setLoaded(true));
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
    <div className="mx-auto max-w-6xl space-y-8 px-4 py-6 max-sm:pb-24 sm:px-6 sm:py-8">
      <div className="space-y-6">
      <section className="dot-bg relative overflow-hidden rounded-2xl border border-border bg-surface/40 px-7 py-10 md:px-10 md:py-12">
        <HeroGlow />
        {/* Readability scrim between the animated glow (z-0) and the copy (z-10). */}
        <div aria-hidden className="pointer-events-none absolute inset-0 z-[1] bg-surface/55 backdrop-blur-[2px] dark:bg-background/45" />
        <div className="relative z-10">
          <p className="eyebrow font-mono text-xs text-muted">
            <span className="text-faint">//</span> today · <span className="tabular-nums">{dateLabel}</span>
          </p>
          <h1 aria-busy={!loaded} className="mt-3 font-display text-4xl leading-[1.05] text-landing md:text-5xl">
            {!loaded ? (
              // Holds the headline's slot so a slow whats-new read shows as loading, not as a hole.
              <span aria-hidden className="block h-[1.05em] w-2/3 max-w-md rounded-md bg-surface-muted motion-safe:animate-pulse" />
            ) : (
            <motion.span initial={{ opacity: 0 }} animate={{ opacity: 1 }} transition={{ duration: DURATION.base, ease: EASE_OUT }}>
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
            </motion.span>
            )}
          </h1>
          <p className="mt-4 min-h-10 max-w-2xl text-sm text-muted">
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
            <Link href="/explore" className={cn(HERO_LINK, "bg-brand text-brand-foreground hover:bg-brand-200")}>
              Find new roles <ArrowRight aria-hidden className="size-4" />
            </Link>
            <Link href="/pipeline" className={cn(HERO_LINK, "border border-border text-foreground hover:border-brand/40 hover:text-brand-text")}>
              Open pipeline
            </Link>
            {alerts && (
              <button type="button" onClick={() => setShowPreview(true)} className={cn(HERO_LINK, "px-4 text-muted hover:text-foreground")}>
                <Eye aria-hidden className="size-4" /> Preview digest
              </button>
            )}
          </div>
          {inBetween && <QuickEvaluate />}
        </div>
      </section>

      <div className="grid gap-4 sm:grid-cols-3">
        <StatCard
          href="/followups"
          icon={Bell}
          value={loaded ? <CountUp value={due} /> : "–"}
          label="Follow-ups due"
          hint={overdue ? `${overdue} overdue` : "A nudge beats silence"}
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
      </div>

      <ProfileCards profiles={home.profiles} active={home.active} />

      <div className="grid items-start gap-4 lg:grid-cols-[3fr_2fr]">
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

      {failed(home.filters) ? (
        <Broken title="Scan filters" error={home.filters.error} />
      ) : (
        <FiltersPanel key={JSON.stringify(home.filters)} filters={home.filters} funnel={home.funnel} />
      )}

      {home.lanes && (
        <div id="lanes" className="scroll-mt-6">
          {failed(home.lanes) ? (
            <Broken title="Lanes" error={home.lanes.error} />
          ) : (
            <LanesPanel key={JSON.stringify(home.lanes)} lanes={home.lanes} positives={positives} />
          )}
        </div>
      )}

      {failed(home.prefs) ? <Broken title="Preferences" error={home.prefs.error} /> : <PreferencesPanel key={JSON.stringify(home.prefs)} prefs={home.prefs} />}

      {/* Mounted only while open so the digest iframe (remote images and all) loads on demand, as before. */}
      {showPreview && <PreviewDialog preview={preview} onClose={() => setShowPreview(false)} />}
    </div>
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

function PreviewDialog({ preview, onClose }: { preview: Preview | { error: string } | null; onClose: () => void }) {
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
