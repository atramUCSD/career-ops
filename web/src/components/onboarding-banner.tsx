"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { Sparkles, X, Settings } from "lucide-react";
import { Button, buttonVariants } from "@/components/ui/button";

type Doctor = { available: boolean; onboardingNeeded: boolean; missing: string[]; warnings: string[] };

export function hasCli(): boolean {
  try {
    return !!JSON.parse(localStorage.getItem("career-ops:config") || "{}").cliId;
  } catch {
    return false;
  }
}

const LABELS: Record<string, string> = {
  "cv.md": "your CV",
  "config/profile.yml": "your profile — target roles, comp, location",
  "modes/_profile.md": "your personalization",
  "portals.yml": "the companies to scan",
};

// Detect (via the core's doctor.mjs) whether setup is incomplete, and offer to
// finish it CONVERSATIONALLY — the assistant asks in plain language and writes
// the canonical files (no YAML to edit). This is the #1 adoption barrier.
export function OnboardingBanner() {
  const [d, setD] = useState<Doctor | null>(null);
  const [dismissed, setDismissed] = useState(false);
  const [cli, setCli] = useState(true); // assume until read (avoid CTA flash)

  useEffect(() => {
    setCli(hasCli());
    fetch("/api/doctor")
      .then((r) => r.json())
      .then(setD)
      .catch(() => {});
  }, []);

  if (dismissed || !d || !d.onboardingNeeded) return null;
  const items = d.missing.map((m) => LABELS[m] ?? m);
  const kickoff =
    `Help me finish setting up career-ops. I still need to add ${items.join(", ")} — walk me through just those, conversationally, and write the files for me. Don't ask me for anything that's already set up (for example, don't ask for my CV if it's already saved).`;

  return (
    <div className="dot-bg relative mb-6 overflow-hidden rounded-2xl border border-brand/30 bg-gradient-to-br from-brand/10 via-surface/40 to-transparent p-5">
      <Button
        variant="ghost"
        size="icon-sm"
        onClick={() => setDismissed(true)}
        className="absolute top-2 right-2 text-muted"
        aria-label="Dismiss"
      >
        <X aria-hidden className="size-4" />
      </Button>
      <h2 className="font-display text-xl text-landing">Let&apos;s finish setting you up</h2>
      <p className="mt-1.5 max-w-xl text-sm text-muted">
        career-ops works best when it knows you. We still need {items.join(", ")}.{" "}
        <span className="text-foreground">No YAML to edit</span> — answer in plain language and the assistant writes it
        for you.
      </p>
      {cli ? (
        <Button
          onClick={() => window.dispatchEvent(new CustomEvent("co-assistant", { detail: { message: kickoff } }))}
          className="mt-4"
        >
          <Sparkles aria-hidden className="size-4" /> Set me up with the assistant
        </Button>
      ) : (
        // The assistant needs a CLI to run — without one the kickoff would silently
        // drop. Send them to connect one first.
        <Link
          href="/config"
          className={buttonVariants({ className: "mt-4" })}
        >
          <Settings aria-hidden className="size-4" /> Connect your AI CLI to get started
        </Link>
      )}
    </div>
  );
}
