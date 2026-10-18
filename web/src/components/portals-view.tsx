"use client";

import { useMemo, useState } from "react";
import Link from "next/link";
import { Loader2, Radar, Wrench } from "lucide-react";
import { CompanyLogo } from "@/components/company-logo";
import { useJobs, type Job } from "@/components/jobs/job-store";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { cn } from "@/lib/cn";
import type { WatchedCompany } from "@/lib/portals-config.mjs";

type Company = { name: string; status: string; detail: string };
type Result = { available: boolean; configured: boolean; companies: Company[]; error?: string };

const TONE: Record<string, { dot: string; label: string; tone: "good" | "warn" | "bad" | "muted" }> = {
  live: { dot: "bg-good", label: "live", tone: "good" },
  empty: { dot: "bg-warn", label: "live · empty", tone: "warn" },
  broken: { dot: "bg-bad", label: "broken", tone: "bad" },
  skipped: { dot: "bg-faint", label: "no ATS", tone: "muted" },
};
const ORDER: Record<string, number> = { broken: 0, empty: 1, live: 2, skipped: 3 };

export function PortalsView({ watched }: { watched: WatchedCompany[] }) {
  const [res, setRes] = useState<Result | null>(null);
  const [loading, setLoading] = useState(false);
  const { jobs, startJob } = useJobs();

  // map the agentic "fix-portal" workers to the company they're repairing
  const fixByCompany = useMemo(() => {
    const m = new Map<string, (typeof jobs)[number]>();
    for (const j of jobs) {
      if (j.kind !== "fix-portal" || !j.input) continue;
      const ex = m.get(j.input);
      if (!ex || j.startedAt > ex.startedAt) m.set(j.input, j);
    }
    return m;
  }, [jobs]);

  function check() {
    setLoading(true);
    fetch("/api/portals/verify")
      .then((r) => r.json())
      .then(setRes)
      .catch(() => setRes({ available: false, configured: false, companies: [] }))
      .finally(() => setLoading(false));
  }

  const companies = res?.companies ?? [];
  const broken = companies.filter((c) => c.status === "broken");
  const liveN = companies.filter((c) => c.status === "live" || c.status === "empty").length;
  const sorted = [...companies].sort((a, b) => (ORDER[a.status] ?? 9) - (ORDER[b.status] ?? 9));

  return (
    <div>
      <div className="flex flex-wrap items-center gap-3">
        <Button type="button" onClick={check} loading={loading}>
          {!loading && <Radar aria-hidden className="size-4" />}
          Check portal health
        </Button>
        {loading && <span className="text-xs text-faint">Probing each company&apos;s ATS… (~30–60s)</span>}
      </div>

        {!res && watched.length > 0 && <WatchedList watched={watched} />}

        {res && !res.available && !res.error && (
          <Card inset className="mt-4 border-dashed bg-surface/30 text-sm text-muted">
          <code className="text-foreground">verify-portals.mjs</code> not found — this needs a complete career-ops
          checkout (the web orchestrates the core&apos;s validator).
        </Card>
      )}
      {res && !res.available && res.error && (
        <p className="mt-4 rounded-xl border border-bad/30 bg-bad-soft p-4 text-sm text-muted">
          <span className="font-medium text-bad-text">The portal check did not finish</span> — no
          portal was verified, so none is shown as healthy. Try again, or run{" "}
          <code className="text-foreground">node verify-portals.mjs</code> to see why.{" "}
          <code className="break-all font-mono text-xs text-faint">{res.error}</code>
        </p>
      )}
      {res && res.available && !res.configured && (
        <Card inset className="mt-4 border-dashed bg-surface/30 text-sm text-muted">
          No <code className="text-foreground">portals.yml</code> yet — ask the assistant to set up the companies to scan.
        </Card>
      )}

      {res && res.configured && (
        <div className="mt-6">
          <p className="text-sm text-muted">
            <span className="tabular-nums text-brand-text">{liveN}</span> live ·{" "}
            <span className="tabular-nums text-bad-text">{broken.length}</span> broken ·{" "}
            <span className="tabular-nums">{companies.length}</span> tracked
          </p>
          {broken.length > 0 && (
            <Card inset tone="bad" className="mt-3 text-sm">
              <span className="font-medium text-bad-text">
                {broken.length} {broken.length === 1 ? "company silently drops" : "companies silently drop"} from every
                scan
              </span>{" "}
              <span className="text-muted">
                — their careers link is broken. Fix the <code>careers_url</code> in <code>portals.yml</code> (or ask the
                assistant to repair them).
              </span>
            </Card>
          )}
          <ul className="mt-4 divide-y divide-border rounded-xl border border-border bg-surface/40">
            {sorted.map((c) => {
              const t = TONE[c.status] ?? TONE.skipped;
              return (
                <li key={c.name} className="flex items-center gap-3 px-4 py-3">
                  <CompanyLogo name={c.name} size={20} />
                  <span aria-hidden className={cn("size-1.5 shrink-0 rounded-full", t.dot)} />
                  <span className="min-w-0 truncate text-sm font-medium">{c.name}</span>
                  <span className="truncate font-mono max-sm:hidden text-xs text-faint">{c.detail}</span>
                  <div className="ml-auto flex shrink-0 items-center gap-2">
                    {c.status === "broken" && <FixAffordance company={c.name} job={fixByCompany.get(c.name)} onFix={() => startJob({ title: `Fix · ${c.name}`, subtitle: "repair portal slug", kind: "fix-portal", input: c.name, page: "/portals" })} />}
                    <Badge tone={t.tone} className="text-2xs">
                      {t.label}
                    </Badge>
                  </div>
                </li>
              );
            })}
          </ul>
        </div>
      )}
    </div>
  );
}

function FixAffordance({ company, job, onFix }: { company: string; job?: Job; onFix: () => void }) {
  if (job?.status === "running")
    return (
      <Link href={`/jobs/${job.id}`} className="inline-flex items-center gap-1 rounded-md text-xs font-medium text-brand-text focus-ring max-sm:min-h-11">
        <Loader2 aria-hidden className="size-3 motion-safe:animate-spin" /> Fixing…
      </Link>
    );
  if (job?.status === "done")
    return (
      <Link href={`/jobs/${job.id}`} className="inline-flex items-center rounded-md text-xs font-medium text-brand-text focus-ring max-sm:min-h-11">
        repaired · re-check
      </Link>
    );
  return (
    <Button
      type="button"
      variant="secondary"
      size="sm"
      onClick={onFix}
      title={`Have the agent repair ${company}'s portal slug`}
      aria-label={`Fix ${company}`}
    >
      <Wrench aria-hidden className="size-3" /> Fix
    </Button>
  );
}

function WatchedList({ watched }: { watched: WatchedCompany[] }) {
  const scanned = watched.filter((c) => c.enabled).length;
  return (
    <div className="mt-5">
      <p className="text-sm text-muted">
        <span className="tabular-nums text-foreground">{scanned}</span> scanned ·{" "}
        <span className="tabular-nums">{watched.length - scanned}</span> paused · run a health check to see which boards
        still answer
      </p>
      <ul className="mt-4 divide-y divide-border overflow-hidden rounded-2xl border border-border bg-surface/40">
        {watched.map((c, i) => (
          <li key={`${i}-${c.name}`} className={cn("flex items-center gap-3 px-4 py-2.5", !c.enabled && "opacity-60")}>
            <CompanyLogo name={c.name} size={20} />
            <span className="shrink-0 text-sm font-medium">{c.name}</span>
            <span className="truncate font-mono text-xs text-faint">{c.host}</span>
            {!c.enabled && (
              <span className="ml-auto shrink-0 rounded bg-surface-hover px-1.5 py-0.5 text-2xs font-semibold text-muted">
                paused
              </span>
            )}
          </li>
        ))}
      </ul>
    </div>
  );
}
