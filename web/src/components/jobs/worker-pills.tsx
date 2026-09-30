"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { AnimatePresence, motion } from "motion/react";
import { X, History } from "lucide-react";
import { useJobs } from "@/components/jobs/job-store";
import { WorkerCard } from "@/components/jobs/worker-card";
import { Button, buttonVariants } from "@/components/ui/button";
import { layoutMove, listItem } from "@/components/ui/motion";
import { cn } from "@/lib/cn";

// Collapsed "worker" pills in the sidebar — each the shared <WorkerCard> wrapped
// in a Link to its detail. Same component the assistant chat renders inline.
export function WorkerPills() {
  const { jobs, removeJob, clearFinished } = useJobs();
  const pathname = usePathname();
  if (jobs.length === 0) return null;
  const running = jobs.filter((j) => j.status === "running").length;
  const finished = jobs.length - running;

  return (
    <div className="mt-4 border-t border-border pt-3">
      <div className="mb-2 flex items-center gap-2 px-1">
        <span className="eyebrow text-2xs font-semibold text-muted">Workers</span>
        {running > 0 && <span className="text-2xs tabular-nums text-brand-text">{running} running</span>}
        <Link
          href="/jobs"
          className={cn(buttonVariants({ variant: "ghost", size: "icon-sm" }), "ml-auto text-faint")}
          title="History"
          aria-label="Worker history"
        >
          <History aria-hidden className="size-3.5" />
        </Link>
        {finished > 0 && (
          <Button
            variant="ghost"
            size="sm"
            onClick={clearFinished}
            title="Clear finished"
            className="h-auto px-1 text-2xs font-normal text-faint"
          >
            clear
          </Button>
        )}
      </div>
      <ul className="relative space-y-1.5">
        <AnimatePresence initial={false} mode="popLayout">
          {jobs.slice(0, 6).map((j) => {
            const active = pathname === `/jobs/${j.id}`;
            return (
              <motion.li key={j.id} {...listItem} layout="position" transition={{ ...listItem.transition, layout: layoutMove }}>
                {/* Stretched link: the dismiss button can't nest inside an <a>, so the link is an overlay sibling. */}
                <div
                  className={cn(
                    "group relative rounded-md border px-2.5 py-2 transition-colors duration-150 ease-out",
                    active ? "border-brand/50 bg-brand-soft" : "border-border bg-surface/60 hover:bg-surface-hover",
                  )}
                >
                  <Link
                    href={`/jobs/${j.id}`}
                    aria-label={`Open ${j.title}`}
                    aria-current={active ? "page" : undefined}
                    className="absolute inset-0 rounded-md focus-ring"
                  />
                  <WorkerCard
                    job={j}
                    variant="tray"
                    trailing={
                      // Raw button: a ui/Button's 44px mobile floor is too big for this tray. size-6 with -m-1.5
                      // gives a 24px target (WCAG 2.5.8) around the 12px glyph without moving the row.
                      <button
                        type="button"
                        onClick={() => removeJob(j.id)}
                        className="relative z-10 -m-1.5 grid size-6 place-items-center rounded-md text-faint opacity-0 focus-ring transition-opacity duration-150 ease-out group-hover:opacity-100 hover:text-foreground focus-visible:opacity-100 max-md:opacity-100"
                        aria-label={`Dismiss ${j.title}`}
                      >
                        <X aria-hidden className="size-3" />
                      </button>
                    }
                  />
                </div>
              </motion.li>
            );
          })}
        </AnimatePresence>
      </ul>
    </div>
  );
}
