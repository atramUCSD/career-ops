"use client";

import { useEffect, useRef, useState } from "react";
import { Check, Loader2 } from "lucide-react";
import { ApplyBackdrop } from "@/components/apply/apply-backdrop";
import { Bar } from "@/components/ui/charts";
import { instrumentSerif } from "@/lib/fonts";
import { ATS_LABEL, ATS_SOURCES, type AtsSource } from "@/lib/explore";
import { useExplore, type SourceState } from "./explore-provider";

const STYLE = `
.co-disc{position:relative;z-index:1;display:flex;min-height:0;flex-direction:column;align-items:center;justify-content:flex-start;text-align:center;gap:1rem;padding:1.5rem 1rem 0.5rem}
.co-disc__counter{font-variant-numeric:tabular-nums;line-height:1;font-size:clamp(4rem,13vw,8rem)}
.co-src{display:flex;flex-wrap:wrap;justify-content:center;gap:.6rem}
.co-src__chip{display:flex;align-items:center;gap:.5rem;border-radius:.75rem;border:1px solid var(--border);padding:.5rem .8rem;min-width:9.5rem;background:color-mix(in srgb, var(--bg) 70%, transparent);transition:opacity .3s,border-color .3s}
.co-src__chip[data-state="queued"]{opacity:.4;border-style:dashed}
.co-src__chip[data-state="active"]{border-color:color-mix(in srgb,var(--brand) 45%,transparent)}
.co-src__orb{position:relative;width:.55rem;height:.55rem;border-radius:50%;background:var(--brand)}
.co-src__orb::after{content:"";position:absolute;inset:-.25rem;border-radius:50%;border:1px solid var(--brand);animation:co-orb 1.4s ease-out infinite}
.co-disc__skel{display:grid;grid-template-columns:repeat(auto-fill,minmax(15rem,1fr));gap:.7rem;width:100%;max-width:46rem;margin-top:.5rem}
.co-disc__skelcard{height:4.4rem;border-radius:.75rem;border:1px solid var(--border);background:color-mix(in srgb, var(--bg) 60%, transparent);overflow:hidden;position:relative}
.co-disc__skelcard::after{content:"";position:absolute;inset:0;background:linear-gradient(90deg,transparent,color-mix(in srgb, var(--fg) 8%, transparent),transparent);transform:translateX(-100%);animation:co-shimmer 1.5s infinite}
.co-ledger{display:inline-flex;align-items:center;gap:.5rem;border-radius:.375rem;border:1px solid color-mix(in srgb, var(--good) 30%, transparent);background:color-mix(in srgb, var(--good) 10%, transparent);color:var(--brand-text);padding:.35rem .85rem;font-size:.875rem;font-weight:600}
@keyframes co-orb{0%{transform:scale(.6);opacity:.7}100%{transform:scale(2);opacity:0}}
@keyframes co-shimmer{100%{transform:translateX(100%)}}
@media (prefers-reduced-motion: reduce){.co-src__orb::after,.co-disc__skelcard::after{animation:none}}
`;

export function useCountUp(target: number): number {
  const [val, setVal] = useState(target);
  const raf = useRef(0);
  useEffect(() => {
    const tick = () => {
      setVal((v) => {
        const diff = target - v;
        if (Math.abs(diff) < 0.5) return target;
        raf.current = requestAnimationFrame(tick);
        return v + diff * 0.18;
      });
    };
    raf.current = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf.current);
  }, [target]);
  return Math.round(val);
}

function SourceChip({ ats, s }: { ats: AtsSource; s?: SourceState }) {
  const state = s?.state ?? "queued";
  const pct = s?.total ? Math.min(100, Math.round(((s.done ?? 0) / s.total) * 100)) : state === "swept" || state === "noisy" ? 100 : 0;
  return (
    <div className="co-src__chip" data-state={state === "noisy" ? "active" : state}>
      {state === "active" ? (
        <span aria-hidden className="co-src__orb" />
      ) : state === "swept" || state === "noisy" ? (
        <Check aria-hidden className="size-3.5 text-brand-text" />
      ) : (
        <span aria-hidden className="size-2.5 rounded-full border border-current opacity-40" />
      )}
      <span className="text-sm font-medium text-foreground">{ATS_LABEL[ats]}</span>
      <div className="ml-auto flex flex-col items-end gap-1">
        {state === "noisy" && <span className="text-2xs text-faint">~{s?.unreachable} skipped</span>}
        <Bar pct={pct} size="sm" className="w-14" />
      </div>
    </div>
  );
}

export function DiscoveringState() {
  const { sources, matchCount, companiesScanned, status, phase } = useExplore();
  const shown = useCountUp(matchCount);
  const companies = useCountUp(companiesScanned);

  return (
    <>
      <ApplyBackdrop intense={phase !== "revealing"} />
      <div className="co-disc">
        <style>{STYLE}</style>

        <div className="co-ledger">
          <span aria-hidden className="size-1.5 rounded-full bg-good" />
          0 tokens · $0.00 {companies > 0 && <span className="opacity-70">· {companies.toLocaleString()} companies</span>}
        </div>

        <div>
          <div className={`${instrumentSerif.className} co-disc__counter text-foreground`}>{shown}</div>
          <p className="mt-1 text-sm text-muted">
            {phase === "revealing" ? "fresh roles found — free" : matchCount > 0 ? "fresh roles and counting…" : "scanning the network…"}
          </p>
        </div>

        <div className="co-src">
          {ATS_SOURCES.map((a) => (
            <SourceChip key={a} ats={a} s={sources[a]} />
          ))}
        </div>

        <p className="flex items-center gap-2 text-sm text-faint">
          <Loader2 aria-hidden className="size-3.5 motion-safe:animate-spin" />
          {status || "Casting the net across the ATS network…"}
        </p>
      </div>
    </>
  );
}
