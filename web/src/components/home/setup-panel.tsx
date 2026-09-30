"use client";

import { useEffect, useState, useTransition } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { Check, CircleDashed, ListChecks, RefreshCw } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { hasCli } from "@/components/onboarding-banner";
import type { Checklist, Failed, Schedule } from "@/lib/home/home-data";
import { Button, buttonVariants } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { cn } from "@/lib/cn";
import { Bar } from "@/components/ui/charts";

const HEALTH: Record<Schedule["health"], { tone: "good" | "warn" | "bad" | "info"; label: string }> = {
  healthy: { tone: "good", label: "Healthy" },
  running: { tone: "info", label: "Running" },
  "not-run": { tone: "info", label: "Not run yet" },
  failing: { tone: "bad", label: "Last run failed" },
  disabled: { tone: "warn", label: "Disabled" },
};

const PERSONALIZE =
  "Personalize modes/_profile.md (and modes/_brief.md if it is still the template) for this profile from its cv.md and config/profile.yml. Show me the diff before writing.";

export function SetupPanel({
  checklist,
  schedule,
  gmailMissing,
  checkedAt,
}: {
  checklist: Checklist | Failed;
  schedule: Schedule | null;
  gmailMissing: string[];
  checkedAt: string;
}) {
  const router = useRouter();
  const [pending, start] = useTransition();
  const [cli, setCli] = useState(false);
  const [time, setTime] = useState("");
  useEffect(() => setCli(hasCli()), []);
  // Formatted on the client: the server's locale and timezone are not the viewer's.
  useEffect(() => setTime(new Date(checkedAt).toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit" })), [checkedAt]);

  const ok = !("error" in checklist);
  const health = schedule ? HEALTH[schedule.health] : null;

  return (
    <Card
      icon={ListChecks}
      title="Setup"
      aside={ok && <Badge tone={checklist.ready === checklist.total ? "good" : "warn"}>{`${checklist.ready} of ${checklist.total} ready`}</Badge>}
    >
      {ok ? (
        <>
          <Bar pct={(checklist.ready / checklist.total) * 100} tone={checklist.ready === checklist.total ? "good" : "brand"} />
          <ul className="mt-4 divide-y divide-border">
            {checklist.items.map((item) => (
              <li key={item.id} className="flex items-start gap-3 py-2.5">
                {item.ready ? (
                  <Check aria-label="Ready" className="mt-0.5 size-4 shrink-0 text-brand-text" />
                ) : (
                  <CircleDashed aria-label="Needs attention" className="mt-0.5 size-4 shrink-0 text-warn" />
                )}
                <div className="min-w-0 flex-1">
                  <code className="font-mono text-sm text-foreground">{item.label}</code>
                  <p className="text-xs text-muted">{item.detail}</p>
                </div>
                {item.action === "personalize" &&
                  (cli ? (
                    <Button
                      type="button"
                      variant="soft"
                      size="sm"
                      onClick={() => window.dispatchEvent(new CustomEvent("co-assistant", { detail: { message: PERSONALIZE } }))}
                      className="shrink-0"
                    >
                      Personalize
                    </Button>
                  ) : (
                    <Link href="/config" className={cn(buttonVariants({ variant: "soft", size: "sm" }), "shrink-0")}>
                      Connect a CLI
                    </Link>
                  ))}
                {item.action === "lanes" && (
                  <a href="#lanes" className={cn(buttonVariants({ variant: "secondary", size: "sm" }), "shrink-0")}>
                    Review
                  </a>
                )}
              </li>
            ))}
          </ul>
        </>
      ) : (
        <p role="alert" className="text-sm text-bad-text">
          {checklist.error}
        </p>
      )}

      <h3 className="eyebrow mt-6 mb-2 text-2xs font-semibold text-muted">Automation</h3>
      <ul className="divide-y divide-border rounded-xl border border-border text-sm">
        <li className="flex items-center gap-3 px-4 py-2.5">
          <div className="flex-1">
            <code className="font-mono text-sm">career-ops-alert</code>
            <p className="text-xs text-faint">{schedule?.times.length ? `Scan and digest at ${schedule.times.join(" and ")}` : "Scheduled scan and digest"}</p>
          </div>
          {health ? <Badge tone={health.tone}>{health.label}</Badge> : <Badge tone="muted">Not found</Badge>}
        </li>
        <li className="flex items-center gap-3 px-4 py-2.5">
          <div className="flex-1">
            <span>Gmail</span>
            <p className="text-xs text-faint">OAuth send access for the digest</p>
          </div>
          {gmailMissing.length === 0 ? <Badge tone="good">Connected</Badge> : <Badge tone="warn">Not connected</Badge>}
        </li>
      </ul>
      <p className="mt-3 text-xs text-faint">
        Checked {time || "just now"} ·{" "}
        {/* Inline in the sentence, so a text link rather than a Button box. */}
        <button
          type="button"
          onClick={() => start(() => router.refresh())}
          disabled={pending}
          className="inline-flex items-center gap-1 rounded-md text-foreground transition-colors duration-150 ease-out hover:text-brand-text focus-ring max-sm:min-h-11"
        >
          <RefreshCw aria-hidden className={pending ? "size-3 motion-safe:animate-spin" : "size-3"} /> Re-check
        </button>
      </p>
    </Card>
  );
}
