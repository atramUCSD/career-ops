"use client";

// Stand-in for the setup wizard: the real ring, real footprints, three glass
// surfaces (stepper, rail, active stage) and controls as heavy as the stages
// will carry, so the section 8 numbers hold for the build that ships.

import { useEffect, useMemo, useRef, useState } from "react";
import { radialPositions } from "@/lib/camera-path.mjs";
import { OVERVIEW, Stage, World } from "@/components/ui/camera";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/field";
import { cn } from "@/lib/cn";

const STAGES = [
  ["you", "You"],
  ["what", "What"],
  ["where", "Where"],
  ["who", "Who"],
  ["picky", "How picky"],
  ["tell", "Tell me"],
  ["when", "When"],
] as const;
type Id = (typeof STAGES)[number][0] | typeof OVERVIEW;

const LOGOS = "Anthropic Figma Linear Vercel Stripe Notion Ramp Plaid Retool Airtable Webflow Framer Discord Datadog Snowflake Databricks Asana Canva Miro Loom Rippling Gusto Brex Mercury".split(" ");
const HIST = [2, 4, 7, 11, 16, 22, 27, 31, 30, 26, 21, 17, 13, 9, 6, 4, 3, 2, 1, 1];

export function CameraLab({ r: R }: { r: number }) {
  const POSITIONS = useMemo(
    () => radialPositions(STAGES.map(([id]) => id), R) as Record<string, [number, number]>,
    [R],
  );
  const RING = STAGES.slice(1).map(([id]) => POSITIONS[id]);
  const [active, setActive] = useState<Id>("you");
  const status = useRef<HTMLParagraphElement>(null);

  useEffect(() => {
    (window as unknown as { __camera: unknown }).__camera = { go: (id: Id) => setActive(id) };
  }, []);

  const next = (id: Id) => {
    const i = STAGES.findIndex(([s]) => s === id);
    setActive(i === STAGES.length - 1 ? OVERVIEW : STAGES[i + 1][0]);
  };
  const onSettle = (id: string) => {
    const i = STAGES.findIndex(([s]) => s === id);
    const label = i < 0 ? "Review" : `Step ${i + 1} of ${STAGES.length}: ${STAGES[i][1]}`;
    // Imperative on purpose: a state update here would be a second commit at settle.
    document.title = `${label} · camera lab`;
    if (status.current) status.current.textContent = label;
  };
  const form = (id: Id) => ({
    onSubmit: (e: React.FormEvent) => {
      e.preventDefault();
      next(id);
    },
  });

  return (
    <div className="dot-bg fixed inset-0 bg-background">
      {/* inset: the stepper (top-4, about 56px tall) and the w-60 rail, each with a 16px gap. */}
      <World positions={POSITIONS} hop={R} active={active} overviewPad={[1000, 760]} inset={[72, 272, 16, 16]} onSettle={onSettle}>
        {/* Spokes and ring: the moving backdrop the glass has to blur. */}
        <svg aria-hidden className="absolute overflow-visible" style={{ left: 0, top: 0 }} width={1} height={1}>
          {RING.map(([x, y], i) => {
            const [nx, ny] = RING[(i + 1) % RING.length];
            return (
              <g key={i} className="stroke-brand/30" strokeWidth={2} strokeDasharray="6 10">
                <line x1={0} y1={0} x2={x} y2={y} />
                <line x1={x} y1={y} x2={nx} y2={ny} />
              </g>
            );
          })}
        </svg>

        <Stage id="you" title="Start with your CV" className="w-xl">
          <form {...form("you")} className="mt-6 space-y-4">
            <div className="grid h-48 place-items-center rounded-xl border border-dashed border-control-border text-sm text-muted">
              Drop a PDF or paste text
            </div>
            <Button type="submit">Continue</Button>
          </form>
        </Stage>

        <Stage id="what" title="What you want to do" className="w-lg">
          <form {...form("what")} className="mt-6 space-y-4">
            <div className="flex flex-wrap gap-2">
              {"Design engineer, Frontend engineer, Product designer, Design systems, Prototyper, UX engineer, Creative technologist".split(", ").map((r, i) => (
                <span key={r} className={cn("rounded-md border px-2 py-0.5 text-sm", i < 3 ? "border-brand/30 bg-brand-soft text-brand-text" : "border-border text-muted")}>
                  {r}
                </span>
              ))}
            </div>
            <Input label="Minimum base" defaultValue="150000" inputMode="numeric" />
            <Input label="Target base" defaultValue="185000" inputMode="numeric" />
            <Input label="Currency" defaultValue="USD" />
            <Button type="submit">Continue</Button>
          </form>
        </Stage>

        <Stage id="where" title="Where" className="w-sm">
          <form {...form("where")} className="mt-6 space-y-4">
            <Input label="Cities" defaultValue="San Diego, San Francisco" />
            <Button type="submit">Continue</Button>
          </form>
        </Stage>

        {/* w-2xl is the footprint cap (DESIGN.md 7a): at w-4xl this stage alone
            made every flight to or from it GPU-bound at DPR 2. */}
        <Stage id="who" title="Who you would work for" className="w-2xl">
          <form {...form("who")} className="mt-6 space-y-4">
            <ul className="grid grid-cols-6 gap-3">
              {LOGOS.map((n) => (
                <li key={n} className="grid aspect-square place-items-center rounded-md border border-border bg-surface-muted text-sm font-semibold text-foreground">
                  {n.slice(0, 2)}
                </li>
              ))}
            </ul>
            <Button type="submit">Continue</Button>
          </form>
        </Stage>

        <Stage id="picky" title="How picky" className="w-xl">
          <form {...form("picky")} className="mt-6 space-y-4">
            <div aria-hidden className="flex h-28 items-end gap-1">
              {HIST.map((h, i) => (
                <div key={i} className={cn("flex-1 rounded-sm", i >= 8 ? "bg-brand" : "bg-faint/50")} style={{ height: `${(h / 31) * 100}%` }} />
              ))}
            </div>
            <input type="range" min={1} max={5} step={0.1} defaultValue={3.8} aria-label="Minimum score" className="w-full accent-brand" />
            <Button type="submit">Continue</Button>
          </form>
        </Stage>

        <Stage id="tell" title="Tell me" className="w-lg">
          <form {...form("tell")} className="mt-6 space-y-4">
            <Input label="Email" type="email" defaultValue="me@example.com" />
            <Input label="Digest" defaultValue="Daily at 07:00" />
            <Input label="Calendar" defaultValue="Primary" />
            <Button type="submit">Continue</Button>
          </form>
        </Stage>

        <Stage id="when" title="When" className="w-lg">
          <form {...form("when")} className="mt-6 space-y-4">
            <svg viewBox="-110 -110 220 220" className="mx-auto size-56" aria-hidden>
              <circle r={100} className="fill-none stroke-border" strokeWidth={2} />
              {Array.from({ length: 24 }, (_, h) => {
                const a = (h / 24) * 2 * Math.PI;
                return <line key={h} x1={88 * Math.sin(a)} y1={-88 * Math.cos(a)} x2={100 * Math.sin(a)} y2={-100 * Math.cos(a)} className={h === 7 || h === 19 ? "stroke-brand" : "stroke-faint"} strokeWidth={h % 6 ? 1 : 3} />;
              })}
            </svg>
            <Button type="submit">Review</Button>
          </form>
        </Stage>
      </World>

      <nav aria-label="Setup steps" className="glass fixed top-4 left-1/2 flex -translate-x-1/2 gap-1 rounded-2xl p-1.5">
        {STAGES.map(([id, label]) => (
          <Button key={id} variant="ghost" size="sm" aria-current={active === id ? "step" : undefined} onClick={() => setActive(id)} className="aria-[current=step]:bg-brand-soft aria-[current=step]:text-brand-text">
            {label}
          </Button>
        ))}
        <Button variant="ghost" size="sm" aria-current={active === OVERVIEW ? "step" : undefined} onClick={() => setActive(OVERVIEW)} className="aria-[current=step]:bg-brand-soft aria-[current=step]:text-brand-text">
          Review
        </Button>
      </nav>

      <aside className="glass fixed top-24 right-4 bottom-4 w-60 rounded-2xl p-4 text-sm text-muted">
        <p className="eyebrow text-2xs font-semibold">Camera lab</p>
        <p className="mt-2">R = {R}</p>
        <p ref={status} role="status" className="mt-2 text-foreground" />
      </aside>
    </div>
  );
}
