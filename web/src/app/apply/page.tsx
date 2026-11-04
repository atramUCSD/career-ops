import { Send } from "lucide-react";
import { ApplyView } from "@/components/apply-view";
import { ApplyBackdropMount } from "@/components/apply/apply-backdrop-mount";

export const dynamic = "force-dynamic";

export default function ApplyPage() {
  return (
    <div className="relative">
      {/* full-viewport blurred form wallpaper (behind everything) */}
      <ApplyBackdropMount />
      {/* At the 55% default, frost over a bright form shot drops text-muted under
          4.5:1 in dark mode (4.21 measured); 70% clears it everywhere (5.29). */}
      <div className="relative z-10 mx-auto max-w-3xl px-4 py-6 sm:px-6 sm:py-8 max-sm:pb-24 [--glass-fill:color-mix(in_srgb,var(--surface)_70%,transparent)]">
        <div className="flex items-center gap-3">
          <Send aria-hidden className="size-6 text-brand" />
          <h1 className="font-display text-2xl tracking-tight text-landing">Apply</h1>
        </div>
        <p className="mt-1.5 max-w-xl text-sm text-muted">
          career-ops reads the real application form on your machine and re-renders it here in plain language, pre-filled
          from your CV. You verify every answer — then it fills the real form behind the scenes and you submit it yourself.
          It never submits for you.
        </p>
        <div className="mt-6">
          <ApplyView />
        </div>
      </div>
    </div>
  );
}
