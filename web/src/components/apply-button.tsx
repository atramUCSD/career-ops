"use client";

import { useRouter } from "next/navigation";
import { Send, Lock } from "lucide-react";
import { useJobs } from "@/components/jobs/job-store";
import { useApply } from "@/components/apply/apply-provider";
import { Button } from "@/components/ui/button";

// The "Apply" CTA. Brand fill only when the score is at/above the apply line
// and legitimacy is not caution (#4206). Enabled ONLY when the tailored CV
// for THIS offer is ready (the tracker's PDF column is ✅, or a pdf worker for
// this #n just finished). On click it opens the apply form-proxy for the offer
// (where the user reviews and submits it themselves — never auto-submit).
export function ApplyButton({
  n,
  url,
  company,
  pdfReady,
  quiet = false,
}: {
  n: string;
  url?: string;
  company: string;
  pdfReady: boolean;
  quiet?: boolean;
}) {
  const router = useRouter();
  const { jobs } = useJobs();
  const apply = useApply();

  const pdfJobDone = jobs.some((j) => j.kind === "pdf" && j.input === n && j.status === "done");
  const hasUrl = !!url && /^https?:\/\//i.test(url);
  const ready = (pdfReady || pdfJobDone) && hasUrl;

  if (!ready) {
    return (
      <Button
        type="button"
        variant="secondary"
        size="sm"
        disabled
        title={!hasUrl ? "No application URL on this report" : "Generate the tailored CV (PDF) first to apply"}
        // pointer-events stay on so the title explains why it is locked
        className="cursor-not-allowed disabled:pointer-events-auto"
      >
        <Lock aria-hidden className="size-3.5" /> Apply
      </Button>
    );
  }
  return (
    <Button
      type="button"
      variant={quiet ? "secondary" : "primary"}
      size="sm"
      onClick={() => {
        // n + from ride along so the Apply page can mark this row Applied,
        // return the user to the page they left, and resolve THIS report's own
        // tailored CV rather than the newest one for the company. Read straight
        // off the handler's own location: usePathname() drops the query and
        // hash, which is where the list filter and the row anchor live.
        const { pathname, search, hash } = window.location;
        apply.open(url!, { prefill: true, company, n, from: `${pathname}${search}${hash}` });
        router.push("/apply");
      }}
      title={
        quiet
          ? "Apply — below the apply line or caution; opens the form pre-filled, you review and submit yourself"
          : "Apply — opens the form pre-filled, you review and submit yourself"
      }
    >
      <Send aria-hidden className="size-3.5" /> Apply
    </Button>
  );
}
