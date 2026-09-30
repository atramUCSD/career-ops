"use client";

import { useRef } from "react";
import { ArrowRight, Sparkles } from "lucide-react";
import { CostBadge } from "@/components/cost/cost-badge";
import { Button } from "@/components/ui/button";

const EXAMPLES = [
  "AI infra roles at climate startups, remote EU",
  "Forward-deployed engineer at Series A devtools, US-remote",
  "Head of Applied AI at healthtech, posted this week",
];

// The "magic" natural-language box: a soft contained halo at rest that intensifies
// on focus (erupts into the full-viewport hunt on submit). Effect CSS co-located
// per the Tailwind v4 stale-CSS HMR gotcha.
const STYLE = `
.co-aibox{position:relative;border-radius:1rem;border:1px solid var(--control-border);background:color-mix(in srgb, var(--bg) 55%, transparent)}
.co-aibox::before{content:"";position:absolute;inset:-1px;border-radius:1rem;padding:1px;background:radial-gradient(70% 140% at 28% -10%, color-mix(in srgb,var(--brand) 45%,transparent), transparent 62%);-webkit-mask:linear-gradient(#000 0 0) content-box,linear-gradient(#000 0 0);-webkit-mask-composite:xor;mask-composite:exclude;opacity:.45;transition:opacity .3s;pointer-events:none}
.co-aibox:focus-within::before{opacity:1}
.co-aibox textarea{width:100%;resize:none;background:transparent;border:none;outline:none;font-size:16px;line-height:1.5;color:inherit}
.co-aibox textarea::placeholder{color:var(--faint)}
@media(prefers-reduced-motion:reduce){.co-aibox::before{transition:none}}
`;

export function AiSearchBox({
  intent,
  onIntent,
  onSubmit,
  cliConfigured,
  cliName,
  onRunScan,
}: {
  intent: string;
  onIntent: (s: string) => void;
  onSubmit: () => void;
  cliConfigured: boolean;
  cliName?: string;
  onRunScan: () => void;
}) {
  const ref = useRef<HTMLTextAreaElement>(null);
  const grow = () => {
    const t = ref.current;
    if (t) {
      t.style.height = "auto";
      t.style.height = `${Math.min(t.scrollHeight, 160)}px`;
    }
  };

  return (
    <div>
      <style>{STYLE}</style>
      <div className="co-aibox field-focus-within p-4">
        <div className="mb-2 flex items-center gap-2 text-xs font-medium text-brand">
          <Sparkles aria-hidden className="size-3.5" /> Describe the role — an AI hunts the open web for it
        </div>
        <textarea
          ref={ref}
          aria-label="Describe the role"
          rows={2}
          value={intent}
          onChange={(e) => {
            onIntent(e.target.value);
            grow();
          }}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !e.shiftKey) {
              e.preventDefault();
              if (intent.trim()) onSubmit();
            }
          }}
          placeholder="“AI infra at climate startups, remote EU, not staff-level” — plain language, your words"
        />
        <div className="mt-3 flex flex-wrap items-center justify-between gap-3">
          <span className="text-xs text-muted">
            {cliConfigured ? (
              <>
                Reads the public web with <span className="text-foreground">{cliName || "your CLI"}</span> — it costs your tokens.
              </>
            ) : (
              "Connect an AI CLI in Config to use AI search."
            )}
          </span>
          <Button disabled={!intent.trim()} onClick={onSubmit} className="gap-2 font-semibold">
            Search the open web
            <CostBadge kind="spend" size="xs" />
            <ArrowRight aria-hidden className="size-4" />
          </Button>
        </div>
      </div>

      <div className="mt-3 flex flex-wrap items-center gap-2">
        {EXAMPLES.map((ex) => (
          <Button
            key={ex}
            variant="secondary"
            size="sm"
            onClick={() => onIntent(ex)}
            className="h-auto min-h-7 py-1 text-left font-normal whitespace-normal text-muted hover:border-brand/40 hover:text-brand-text"
          >
            {ex}
          </Button>
        ))}
        <Button variant="ghost" size="sm" onClick={onRunScan} className="ml-auto font-normal text-muted">
          or run the free Scan instead →
        </Button>
      </div>
    </div>
  );
}
