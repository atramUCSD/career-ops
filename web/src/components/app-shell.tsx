"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { MotionConfig, motion } from "motion/react";
import { cn } from "@/lib/cn";
import { CoMark } from "@/components/co-mark";
import { AssistantConsole } from "@/components/assistant-console";
import { MobileNav } from "@/components/mobile-nav";
import { ThemeToggle } from "@/components/theme-toggle";
import { BackToTop } from "@/components/back-to-top";
import { JobsProvider } from "@/components/jobs/job-store";
import { PipelineProvider } from "@/components/pipeline/pipeline-provider";
import { ApplyProvider } from "@/components/apply/apply-provider";
import { ExploreProvider } from "@/components/explore/explore-provider";
import { FirstScoreView } from "@/components/explore/first-score-view";
import { BetaBanner } from "@/components/beta/beta-banner";
import { WorkerPills } from "@/components/jobs/worker-pills";
import { UsageMeter } from "@/components/usage-meter";
import { ProfilePicker } from "@/components/profile-picker";
import { layoutMove } from "@/components/ui/motion";
import { instrumentSerif } from "@/lib/fonts";
import { NAV_ITEMS, isActivePath } from "@/lib/nav-items";

export function AppShell({ children }: { children: React.ReactNode }) {
  const pathname = usePathname();
  return (
    // One switch for every motion visual: transforms go instant under reduced motion.
    <MotionConfig reducedMotion="user">
    <JobsProvider>
      <PipelineProvider>
      <ApplyProvider>
      <ExploreProvider>
      <MobileNav />
      <div className="flex min-h-screen">
        <aside className="sticky top-0 hidden h-screen w-60 shrink-0 flex-col overflow-y-auto border-r border-border bg-surface/30 p-4 md:flex">
          <Link href="/" className="mb-8 flex items-center gap-2.5 rounded-md px-1 focus-ring-inset">
            <CoMark size={32} />
            <span className={`${instrumentSerif.className} relative -top-px text-2xl font-normal tracking-tight text-landing`}>
              career-ops
            </span>
          </Link>
          <nav className="flex flex-col gap-1">
            {NAV_ITEMS.map(({ href, label, icon: Icon, chip }) => {
              const active = isActivePath(href, pathname);
              return (
                <Link
                  key={href}
                  href={href}
                  aria-current={active ? "page" : undefined}
                  className={cn(
                    "relative flex items-center gap-3 rounded-md px-3 py-2 text-sm focus-ring-inset transition-colors duration-150 ease-out",
                    active ? "text-brand-text" : "text-muted hover:bg-surface-hover hover:text-foreground",
                  )}
                >
                  {/* One indicator shared by every item, so it slides to the new route instead of blinking. */}
                  {active && (
                    <motion.span
                      layoutId="nav-active"
                      aria-hidden
                      className="absolute inset-0 rounded-md bg-brand-soft"
                      transition={layoutMove}
                    />
                  )}
                  <Icon className="relative size-4" />
                  <span className="relative">{label}</span>
                  {chip && (
                    <span className="eyebrow relative ml-auto rounded-md border border-brand/30 bg-brand-soft px-1.5 py-0.5 text-2xs font-bold text-brand-text">
                      {chip}
                    </span>
                  )}
                </Link>
              );
            })}
          </nav>

          <WorkerPills />

          <div className="mt-auto space-y-3 pt-4">
            <ProfilePicker />
            <UsageMeter />
            <ThemeToggle className="w-full" />
            <BetaBanner rail />
            <p className={`${instrumentSerif.className} px-1 text-sm text-faint`}>local-first · v0</p>
          </div>
        </aside>
        <main className="flex-1 overflow-x-hidden md:pb-16">{children}</main>
        <AssistantConsole />
        <BackToTop />
        <FirstScoreView />
        <BetaBanner />
      </div>
      </ExploreProvider>
      </ApplyProvider>
      </PipelineProvider>
    </JobsProvider>
    </MotionConfig>
  );
}
