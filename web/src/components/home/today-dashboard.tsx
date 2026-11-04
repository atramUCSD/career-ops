"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { ArrowRight, Bell, ChevronRight, CircleHelp, Eye, Settings, Sparkles } from "lucide-react";
import { motion } from "motion/react";
import { DURATION, EASE_OUT } from "@/components/ui/motion";
import { HeroGlow } from "@/components/hero-glow";
import { Badge } from "@/components/ui/badge";
import { cn } from "@/lib/cn";
import type { Application } from "@/lib/career-ops";
import type { HomeData } from "@/lib/home/home-data";
import { QuickEvaluate } from "@/components/quick-evaluate";
import { scoreNum } from "@/lib/format";
import { pickAwaitingDecision } from "@/lib/home/awaiting.mjs";
import { displayCounts, mayClaimAllClear, missingSourceLabel, resolveHeroState } from "@/lib/home/hero-state.mjs";
import { CountUp } from "@/components/ui/charts";
import { when, type AlertsView } from "./digest-panel";
import { PreviewDialog, failed, type Preview } from "./settings-panels";
import { SETTINGS_SECTIONS } from "@/lib/home/settings-sections";

// The three hero actions keep their pill shape (DESIGN.md section 5 exception).
const HERO_LINK =
  "inline-flex items-center gap-2 rounded-full px-5 py-2.5 text-sm font-medium focus-ring transition-colors duration-150 ease-out max-sm:min-h-11";

// Home: the day's queue up top (supply: fresh scan matches; demand: follow-ups
// due), then one row into /config for the settings that used to stack below it
// and made Home ~17 phone screens of mostly set-once controls.
export function TodayDashboard({ applications, inBetween, home }: { applications: Application[]; inBetween: boolean; home: HomeData }) {
  const router = useRouter();
  const [due, setDue] = useState(0);
  const [overdue, setOverdue] = useState(0);
  const [freshCount, setFreshCount] = useState(0);
  const [preview, setPreview] = useState<Preview | { error: string } | null>(null);
  const [showPreview, setShowPreview] = useState(false);
  // Counts start at 0: hide the headline until the first follow-ups/whats-new pair settles so its text never swaps.
  const [loaded, setLoaded] = useState(false);
  const [errors, setErrors] = useState({ followups: false, fresh: false });
  const [followupsEnabled, setFollowupsEnabled] = useState(true);
  const dateLabel = useMemo(() => new Date().toLocaleDateString("en-US", { weekday: "long", month: "short", day: "numeric" }), []);

  const refetch = useCallback(() => {
    // Each resolves to whether its source failed. A failure leaves the old count in
    // state; displayCounts() zeroes it so the headline never prints a stale figure.
    const json = (r: Response) => {
      if (!r.ok) throw new Error(r.statusText);
      return r.json();
    };
    const followups = fetch("/api/followups")
      .then(json)
      .then((d) => {
        // The cadence route reports engine failures as 200 with available:false: unknown, not empty.
        if (d.available === false) throw new Error("follow-ups unavailable");
        // /api/followups already filters to urgent/overdue: both are due now (#86).
        setDue((d.metadata?.overdue ?? 0) + (d.metadata?.urgent ?? 0));
        setOverdue(d.metadata?.overdue ?? 0);
        setFollowupsEnabled(d.followupsEnabled !== false);
        return false;
      })
      .catch(() => true);
    const whatsNew = fetch("/api/whats-new")
      .then(json)
      .then((d) => {
        const count = Number(d.count);
        setFreshCount(Number.isFinite(count) ? Math.max(0, Math.trunc(count)) : Array.isArray(d.offers) ? d.offers.length : 0);
        return false;
      })
      .catch(() => true);
    Promise.all([followups, whatsNew]).then(([followupsError, freshError]) => {
      setErrors({ followups: followupsError, fresh: freshError });
      setLoaded(true);
    });
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
  const flags = { followupsError: errors.followups, freshError: errors.fresh };
  // "All caught up" only when every source answered (lib/home/hero-state.mjs).
  const heroState = resolveHeroState({ followupsLoading: !loaded, freshLoading: !loaded, ...flags, overdue: due, newThisWeek: freshCount, awaitingCount: awaiting.length });
  const allClear = mayClaimAllClear(heroState);
  const shown = displayCounts({ ...flags, overdue: due, newThisWeek: freshCount });
  const missing = missingSourceLabel(flags);
  const setup = failed(home.checklist) ? null : home.checklist;

  return (
    <div className="mx-auto max-w-6xl space-y-8 px-4 py-6 max-sm:pb-24 sm:px-6 sm:py-8">
      <section className="dot-bg relative overflow-hidden rounded-2xl border border-border bg-surface/40 px-7 py-10 md:px-10 md:py-12">
        <HeroGlow settle />
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
            {heroState === "unavailable" ? (
              <>Some updates are unavailable.</>
            ) : allClear ? (
              <>You&apos;re all caught up.</>
            ) : (
              <>
                {shown.newThisWeek > 0 && (
                  <>
                    <CountUp value={shown.newThisWeek} className="text-brand" /> new match{shown.newThisWeek === 1 ? "" : "es"} this week.{" "}
                  </>
                )}
                {shown.overdue > 0 && (
                  <>
                    <CountUp value={shown.overdue} className="text-brand" /> follow-up{shown.overdue === 1 ? "" : "s"} due today.
                  </>
                )}
                {shown.newThisWeek === 0 && shown.overdue === 0 && (
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
            {missing ? (
              <>
                {missing} could not be read, so this may be missing work.{" "}
                <button type="button" onClick={refetch} className="rounded-sm font-medium text-brand-text hover:underline focus-ring">
                  Retry
                </button>
              </>
            ) : alerts?.enabled && alerts.to && next ? (
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
            ) : followupsEnabled ? (
              "Your action queue for today: discovery and follow-ups, in one place."
            ) : (
              "Your action queue for today, in one place."
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
          {/* The instrument slab: one of the view's glass surfaces (DESIGN.md 5a). The
              settled shader behind it is why it can blur without costing frames. */}
          <div className="glass relative mt-8 grid divide-y divide-border overflow-hidden rounded-2xl sm:grid-cols-3 sm:divide-x sm:divide-y-0">
            {[
              { href: "/followups", Icon: Bell, value: loaded ? <CountUp value={due} /> : "–", label: "Follow-ups due", hint: overdue ? `${overdue} overdue` : "A nudge beats silence" },
              { href: "/pipeline", Icon: CircleHelp, value: <CountUp value={awaiting.length} />, label: "Awaiting your decision", hint: "Scored: apply or skip" },
              {
                href: "/explore?view=fresh",
                Icon: Sparkles,
                value: fresh === null ? "–" : <CountUp value={fresh} />,
                label: "New since last digest",
                hint: alerts?.lastRun ? `Last sent ${when(alerts.lastRun)}` : "No digest sent yet",
              },
            ].map(({ href, Icon, value, label, hint }) => (
              <Link key={href} href={href} className="flex flex-col p-5 focus-ring-inset transition-colors duration-150 ease-out hover:bg-surface-hover">
                <Icon aria-hidden className="size-5 text-brand-text" />
                <span className="mt-3 text-4xl font-semibold leading-none tabular-nums">{value}</span>
                <span className="mt-2 text-sm text-foreground">{label}</span>
                <span className="text-xs text-muted">{hint}</span>
              </Link>
            ))}
          </div>
        </div>
      </section>

      <Link
        href="/config"
        className="flex items-center gap-3 rounded-2xl border border-border bg-surface px-5 py-4 focus-ring transition-colors duration-150 ease-out hover:border-brand/40"
      >
        <Settings aria-hidden className="size-4 shrink-0 text-brand" />
        <span className="min-w-0 flex-1">
          <span className="block text-sm font-medium text-foreground">Settings for {home.active.label}</span>
          <span className="block truncate text-xs text-muted">{SETTINGS_SECTIONS.map((x) => x.label).join(", ")}</span>
        </span>
        {setup && setup.ready < setup.total && (
          <Badge tone="warn">
            Setup {setup.ready}/{setup.total}
          </Badge>
        )}
        <ChevronRight aria-hidden className="size-4 shrink-0 text-muted" />
      </Link>

      {/* Mounted only while open so the digest iframe (remote images and all) loads on demand, as before. */}
      {showPreview && <PreviewDialog preview={preview} onClose={() => setShowPreview(false)} />}
    </div>
  );
}
