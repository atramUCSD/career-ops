"use client";

import { Loader2, Wand2, Asterisk, Paperclip, Sparkles, ArrowUpRight, ShieldCheck, RotateCcw, FileCheck2, AlertTriangle, Terminal, Check, ScanLine, PenLine, CheckCircle2, Info, ExternalLink, MousePointerClick, ArrowLeft, ClipboardCheck } from "lucide-react";
import { useRouter } from "next/navigation";
import { AnimatePresence, motion } from "motion/react";
import type { ApplyIssue, DriveStep } from "@/lib/apply/issue";
import { useApply } from "@/components/apply/apply-provider";
import { needsLeaveConfirmation, resolveReturnPath } from "@/lib/apply/exit.mjs";
import type { ApplyField } from "@/lib/apply/extract";
import { cn } from "@/lib/cn";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Field, Input, Select, Textarea } from "@/components/ui/field";
import { listItem } from "@/components/ui/motion";
import { Fragment, useEffect, useRef, useState } from "react";

// Co-located UI animations (HMR-proof vs Tailwind v4's stale globals.css):
// field cascade-in, per-field "just drafted" flash, skeleton shimmer, hero orb.
const STYLE = `
@keyframes co-rise{from{opacity:0;transform:translateY(10px)}to{opacity:1;transform:translateY(0)}}
.co-rise{animation:co-rise .55s var(--ease-out) both}
.co-flash{position:relative;border-radius:.375rem}
.co-flash::after{content:"";position:absolute;inset:-3px;border-radius:inherit;pointer-events:none;border:2px solid color-mix(in srgb,var(--brand) 55%,transparent);opacity:0;animation:co-flash-ring 1.15s ease both}
@keyframes co-flash-ring{0%{opacity:0;transform:scale(.96)}22%{opacity:1;transform:scale(1)}100%{opacity:0;transform:scale(1.02)}}
@keyframes co-shim{to{transform:translateX(100%)}}
.co-skel{position:relative;overflow:hidden;background:color-mix(in srgb,var(--fg) 5%, transparent);border-radius:.375rem}
@media (prefers-reduced-motion: no-preference){.co-skel::after{content:"";position:absolute;inset:0;transform:translateX(-100%);background:linear-gradient(90deg,transparent,color-mix(in srgb,var(--fg) 7%,transparent),transparent);animation:co-shim 1.6s linear infinite}}
@keyframes co-orb{0%,100%{transform:scale(1);opacity:.55}50%{transform:scale(1.35);opacity:.9}}
.co-orb{animation:co-orb 2.4s ease-in-out infinite}
@keyframes co-spin{to{transform:rotate(360deg)}}
.co-ring{animation:co-spin 3s linear infinite}
@media (prefers-reduced-motion: reduce){.co-rise,.co-flash::after,.co-skel,.co-orb,.co-ring{animation:none}}
`;

// Inline errors enter and leave with the shared block preset; the parent must be `relative` for popLayout.
function InlineError({ children }: { children: React.ReactNode }) {
  return <AnimatePresence initial={false} mode="popLayout">{children}</AnimatePresence>;
}

// The form-proxy UI: the real employer form is opened headlessly on the user's
// machine and re-rendered here in plain language, pre-filled from their CV. The
// user verifies every answer, then we fill the real form behind the scenes and
// bring it to the front for them to submit. We never submit.
export function ApplyView() {
  const a = useApply();
  const [input, setInput] = useState("");

  if (a.status === "idle" || a.status === "error") {
    return (
      <div className="relative">
        <div className="flex max-w-2xl items-center gap-2 rounded-full border border-control-border bg-surface/70 py-1.5 pl-4 pr-1.5 transition-colors duration-150 ease-out field-focus-within">
          <input
            aria-label="Application form URL"
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && a.open(input.trim())}
            placeholder="Paste an application form URL (Ashby, Lever, Greenhouse…)"
            className="min-w-0 flex-1 bg-transparent py-1.5 text-sm outline-none placeholder:text-faint"
          />
          <Button onClick={() => a.open(input.trim())} className="shrink-0 rounded-full px-4">
            <Wand2 aria-hidden className="size-4" /> Read form
          </Button>
        </div>
        <InlineError>
          {a.error && (
            <motion.div key="error" {...listItem} className="mt-4 max-w-2xl">
              <Card inset tone="warn" role="alert">
                <div className="flex items-start gap-2">
                  <AlertTriangle aria-hidden className="mt-0.5 size-4 shrink-0 text-warn" />
                  <div className="min-w-0">
                    <p className="text-sm text-warn">{a.error}</p>
                    {a.url && /^https?:\/\//.test(a.url) && (
                      <a href={a.url} target="_blank" rel="noreferrer" className="mt-2 inline-flex items-center gap-1 rounded-md text-xs font-medium text-brand-text focus-ring hover:underline">
                        Open the form directly <ExternalLink aria-hidden className="size-3" />
                      </a>
                    )}
                  </div>
                </div>
              </Card>
            </motion.div>
          )}
        </InlineError>
        {/* A session that failed still has a row and an origin behind it, so the
            way back and the way to record it must survive the failure. */}
        {a.status === "error" && <ApplyExitBar />}
      </div>
    );
  }

  const opening = a.status === "opening";
  const driving = a.status === "driving";
  const prefilling = a.status === "prefilling";
  const filling = a.status === "filling";
  const done = a.status === "done";
  const busy = opening || driving;
  const phase = busy ? 0 : prefilling ? 1 : 2;

  return (
    <div className="relative mx-auto max-w-2xl">
      <style>{STYLE}</style>

      {/* journey: Read → Draft → Review */}
      <PhaseRail phase={phase} />

      {!busy && (
        <div className="co-rise mb-4 flex items-baseline justify-between gap-3">
          <h2 className="font-display text-xl text-landing">{a.title || "Application"}</h2>
          <Button variant="ghost" size="sm" onClick={a.reset} aria-label="Start a new application" className="text-muted">
            <RotateCcw aria-hidden className="size-3" /> new
          </Button>
        </div>
      )}

      {/* opening: big magic hero + skeleton fields (no layout jump when real ones arrive) */}
      {opening && (
        <>
          <ProcessingHero title="Reading your form…" subtitle="Opening the real application on your machine and reading every field." />
          <FieldSkeleton />
        </>
      )}

      {/* driving: watch the agent reach the form live (it navigates, never submits) */}
      {driving && <DrivePanel steps={a.driveSteps} />}

      <InlineError>
        {a.error && (
          <motion.div key="error" {...listItem} className="mb-3">
            {/* bg-warn/10, not -soft: keeps the glass over the backdrop */}
            <Card inset tone="warn" role="alert" className="flex items-start gap-1.5 bg-warn/10 text-sm text-warn backdrop-blur-sm">
              <AlertTriangle aria-hidden className="mt-0.5 size-4 shrink-0" /> {a.error}
            </Card>
          </motion.div>
        )}
      </InlineError>

      {!busy && (
        <div className="co-rise">
          <ApplyIssues issues={a.issues} />
          {/* drafting banner while the planner writes the answers */}
          {prefilling && (
            <div role="status" className="mb-4 flex items-center gap-3 rounded-xl border border-brand/30 bg-brand-soft/60 p-4 backdrop-blur-sm">
              <span aria-hidden className="relative grid size-8 shrink-0 place-items-center">
                <span className="co-orb absolute inset-0 rounded-full bg-brand/40 blur-[6px]" />
                <Sparkles className="size-4 text-brand" />
              </span>
              <div className="min-w-0">
                <div className="text-sm font-medium text-foreground">Drafting your answers…</div>
                <RotatingStatus />
              </div>
              <Loader2 aria-hidden className="ml-auto size-4 shrink-0 text-brand motion-safe:animate-spin" />
            </div>
          )}

          <div className="mb-4 flex flex-wrap items-center gap-2">
            <Button variant="soft" onClick={a.prefill} loading={prefilling} disabled={filling}>
              {!prefilling && <Sparkles aria-hidden className="size-4" />}
              {prefilling ? "Drafting from your CV…" : "Pre-fill from my CV"}
            </Button>
            <span className="text-xs text-muted">…or ask the corner assistant to write/revise any answer.</span>
          </div>

          {(prefilling || a.prefillLog.length > 0) && (
            <details className="mb-4 rounded-xl border border-border bg-surface/60 backdrop-blur-sm" open={false}>
              <summary className="flex cursor-pointer select-none items-center gap-1.5 rounded-xl px-3 py-1.5 text-xs font-medium text-muted focus-ring max-sm:min-h-11">
                <Terminal aria-hidden className="size-3.5" /> Pre-fill diagnostics
                {prefilling && <Loader2 aria-hidden className="size-3 text-brand motion-safe:animate-spin" />}
                <span className="ml-auto text-faint">{a.prefillLog.length} steps</span>
              </summary>
              <div className="max-h-52 overflow-y-auto border-t border-border px-3 py-2">
                <ol className="space-y-0.5 font-mono text-2xs leading-relaxed text-muted">
                  {a.prefillLog.map((l, i) => (
                    <li key={i} className={l.startsWith("✗") ? "text-warn" : ""}>
                      {l}
                    </li>
                  ))}
                  {prefilling && <li className="text-faint">…</li>}
                </ol>
              </div>
            </details>
          )}

          {/* the questions — float on the blurred form image, cascade in, each
              flashes brand-orange the instant its drafted answer lands */}
          <Card elevated className="space-y-1 border-border/70 bg-surface/80 p-2 backdrop-blur-md sm:p-3">
            {a.fields.map((f, i) => (
              <div key={f.id} className="co-rise rounded-xl px-3 py-2.5" style={{ animationDelay: `${Math.min(i * 45, 700)}ms` }}>
                <FieldRow
                  field={f}
                  value={a.answers[f.id] ?? ""}
                  needs={!!a.meta[f.id]?.needsConfirmation}
                  index={i}
                  drafting={prefilling}
                  onChange={(v) => a.setAnswer(f.id, v)}
                />
              </div>
            ))}
          </Card>

          <div className="mt-5 flex flex-wrap items-center gap-3">
            <Button size="lg" onClick={a.fill} loading={filling} disabled={prefilling}>
              {!filling && <ArrowUpRight aria-hidden className="size-4" />}
              {filling ? "Filling the real form…" : "Fill the real form & review"}
            </Button>
            <Button
              variant="secondary"
              size="lg"
              onClick={a.agentFill}
              disabled={filling || prefilling}
              title="Let the AI drive the real form and fill it field-by-field (for tricky / multi-step forms). It never submits."
            >
              <MousePointerClick aria-hidden className="size-4" /> Let the AI fill it
            </Button>
            <p className="inline-flex items-center gap-1.5 text-xs text-muted">
              <ShieldCheck aria-hidden className="size-3.5 text-brand-text" /> Never submits — you click Submit yourself.
            </p>
          </div>

          {/* agent filling the form live (full-agent escalation) */}
          {filling && a.driveSteps.length > 0 && <div className="mt-6"><DrivePanel steps={a.driveSteps} filling /></div>}

          {(filling || done) && a.steps.length > 0 && (
            <section className="co-rise mt-6" aria-labelledby="apply-behind">
              <h3 id="apply-behind" className="eyebrow mb-3 text-xs font-semibold text-muted">Behind the scenes</h3>
              <div className="flex gap-2 overflow-x-auto pb-2">
                {a.steps.map((s, i) => (
                  <figure key={i} className="shrink-0">
                    {s.thumb ? (
                      // eslint-disable-next-line @next/next/no-img-element
                      <img src={s.thumb} alt="" className="h-24 w-36 rounded-xl border border-border object-cover" />
                    ) : (
                      <div className="flex h-24 w-36 items-center justify-center rounded-xl border border-dashed border-border text-faint">…</div>
                    )}
                    <figcaption className={cn("mt-1 w-36 truncate text-2xs", s.ok ? "text-faint" : "text-warn")}>{s.label || "field"}</figcaption>
                  </figure>
                ))}
              </div>
            </section>
          )}
          {done && (
            <Card inset tone="good" role="status" className="co-rise mt-4 flex items-start gap-2.5 bg-good/10 text-sm backdrop-blur-sm">
              <CheckCircle2 aria-hidden className="mt-0.5 size-5 shrink-0 text-brand-text" />
              <div>
                <span className="font-medium text-brand-text">The real form is now in front, pre-filled.</span>{" "}
                <span className="text-muted">Review it and click Submit yourself — career-ops never submits for you.</span>
              </div>
            </Card>
          )}
        </div>
      )}

      {/* the way out: back out of the form, or record that you sent it */}
      <ApplyExitBar />
    </div>
  );
}

// ── Leaving the page: back out, or record that you applied ─────────────────
// You submit the real form yourself on the employer's site, so the moment you
// apply happens outside career-ops — this is where you tell the tracker about
// it. The write goes through /api/status, the same route the tracker's own
// status control uses, so there is only ever one writer to the table.
function ApplyExitBar() {
  const a = useApply();
  const router = useRouter();
  const [confirming, setConfirming] = useState(false);
  const [marking, setMarking] = useState(false);
  const [error, setError] = useState("");
  // The status write outlives this bar when the user navigates while it is in
  // flight. The write still lands; what must not happen is dragging them back
  // off whatever page they moved on to once it returns.
  // Set on mount as well as cleared on unmount: React re-runs an effect after
  // its cleanup (StrictMode does this on every mount in development), so a
  // cleanup-only flag latches false while the bar is still on screen.
  const onPage = useRef(true);
  useEffect(() => {
    onPage.current = true;
    return () => {
      onPage.current = false;
    };
  }, []);

  // reset() also closes the headless form session on the user's machine —
  // navigating away without it strands the browser this page opened. The
  // destination is read before reset() clears the origin it comes from.
  //
  // The staleness check comes FIRST, before reset(). By the time a late status
  // response gets here the user may have started a different application, and
  // reset() is not addressed to a particular session: it would close whichever
  // one is open now, taking a form the user is in the middle of with it.
  // Leaving that session alone is the same outcome as navigating away from the
  // page by any other route.
  function leave() {
    if (!onPage.current) return;
    const target = resolveReturnPath(a.from);
    a.reset();
    router.push(target);
    router.refresh();
  }

  async function markApplied() {
    setMarking(true);
    setError("");
    try {
      const res = await fetch("/api/status", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ n: a.n, status: "Applied" }),
      });
      if (!res.ok) {
        const d = await res.json().catch(() => ({}));
        if (!onPage.current) return; // moved on already; the row is unchanged
        setError(d.error || "Couldn't mark it applied — the tracker row is unchanged.");
        setMarking(false);
        return;
      }
      leave();
    } catch {
      if (!onPage.current) return; // moved on already
      // The route writes the tracker before it answers, so a connection that
      // drops on the way back leaves the write's fate genuinely unknown —
      // claiming the row is untouched here would be a guess.
      setError("Couldn't confirm the update — check the row in your tracker before relying on it.");
      setMarking(false);
    }
  }

  if (confirming) {
    return (
      <Card inset tone="warn" role="group" aria-labelledby="apply-leave" className="co-rise mt-8 bg-warn/10 backdrop-blur-sm">
        <p id="apply-leave" className="text-sm font-medium text-foreground">Leave this application?</p>
        <p className="mt-1 text-xs text-muted">Your drafted answers live only on this page. Going back discards them and closes the form.</p>
        <div className="mt-3 flex flex-wrap gap-2">
          <Button variant="warn" size="sm" onClick={leave}>
            <ArrowLeft aria-hidden className="size-3.5" /> Leave and discard
          </Button>
          <Button variant="secondary" size="sm" onClick={() => setConfirming(false)}>
            Stay here
          </Button>
        </div>
      </Card>
    );
  }

  return (
    <div className="relative mt-8 border-t border-border/70 pt-5">
      <div className="flex flex-wrap items-center gap-3">
        <Button variant="secondary" onClick={() => (needsLeaveConfirmation({ status: a.status, answers: a.answers }) ? setConfirming(true) : leave())}>
          <ArrowLeft aria-hidden className="size-4" /> Back
        </Button>
        {a.n && (
          <Button variant="soft" onClick={markApplied} loading={marking} title={`Set tracker row #${a.n} to Applied and go back`}>
            {!marking && <ClipboardCheck aria-hidden className="size-4" />}
            {marking ? "Updating your tracker…" : "Mark applied"}
          </Button>
        )}
        {a.n && <span className="text-xs text-muted">Click this once you have submitted the real form yourself.</span>}
      </div>
      <InlineError>
        {error && (
          <motion.p key="error" {...listItem} role="alert" className="mt-2 text-xs text-bad-text">
            {error}
          </motion.p>
        )}
      </InlineError>
    </div>
  );
}

// ── Watch the agent reach the form live (it navigates, never submits) ───────
const DRIVE_VERB: Record<string, string> = { click: "Clicked", type: "Typed into", select: "Selected", scroll: "Scrolled", "parse-error": "Thinking…", stuck: "Stuck", reached_form: "Reached the form" };
function DrivePanel({ steps, filling }: { steps: DriveStep[]; filling?: boolean }) {
  const last = steps[steps.length - 1];
  return (
    <div className="co-rise">
      <div role="status" className="flex flex-col items-center gap-3 py-7 text-center">
        <span aria-hidden className="relative grid size-14 place-items-center">
          <span className="co-orb absolute inset-0 rounded-full bg-brand/30 blur-lg" />
          <span className="co-ring absolute inset-0 rounded-full border-2 border-brand/30 border-t-brand" />
          <MousePointerClick className="size-6 text-brand" />
        </span>
        <div className="font-display text-2xl text-landing">{filling ? "AI is filling the form…" : "Reaching your form…"}</div>
        <p className="max-w-sm text-sm text-muted">{filling ? "The AI is driving the real form field-by-field on your machine — it never submits; you review and submit." : "The AI is navigating the real application on your machine to reach the form — it never submits."}</p>
      </div>
      {last?.thumb ? (
        // eslint-disable-next-line @next/next/no-img-element
        <img src={last.thumb} alt="Latest view of the real form" className="w-full rounded-xl border border-border" />
      ) : (
        <div aria-hidden className="co-skel h-56 w-full rounded-xl" />
      )}
      {steps.length > 0 && (
        <ol className="mt-3 space-y-1.5 rounded-xl border border-border/70 bg-surface/70 p-3 backdrop-blur-sm">
          {steps.map((s, i) => (
            <li key={i} className={cn("flex items-center gap-2 text-xs", i === steps.length - 1 ? "text-foreground" : "text-muted")}>
              <span className="grid size-5 shrink-0 place-items-center rounded-full bg-brand-soft text-2xs font-semibold text-brand-text">{s.turn}</span>
              <span className="shrink-0 font-medium">{DRIVE_VERB[s.action] ?? s.action}</span>
              <span className="truncate text-faint">{s.detail}</span>
              {s.note && <span className="shrink-0 text-warn">· {s.note}</span>}
            </li>
          ))}
        </ol>
      )}
    </div>
  );
}

// ── Issues the interpreter surfaced — never fail mute ───────────────────────
function ApplyIssues({ issues }: { issues: ApplyIssue[] }) {
  if (!issues.length) return null;
  const warns = issues.filter((i) => i.level === "warn" || i.level === "block");
  const infos = issues.filter((i) => i.level === "info");
  return (
    <div className="mb-4 space-y-2">
      {warns.length > 0 && (
        <Card inset tone="warn" as="section" aria-labelledby="apply-issues" className="bg-warn/10 backdrop-blur-sm">
          <h3 id="apply-issues" className="mb-1.5 flex items-center gap-1.5 text-sm font-medium text-warn">
            <AlertTriangle aria-hidden className="size-4" /> A few things to check
          </h3>
          <ul className="space-y-1 text-xs text-warn">
            {warns.map((i, k) => (
              <li key={k} className="flex gap-1.5">
                <span aria-hidden className="mt-px">•</span> {i.message}
              </li>
            ))}
          </ul>
        </Card>
      )}
      {infos.map((i, k) => (
        <div key={k} className="flex items-center gap-1.5 text-xs text-muted">
          <Info aria-hidden className="size-3.5 shrink-0 text-faint" /> {i.message}
        </div>
      ))}
    </div>
  );
}

// ── Journey rail: Reading → Drafting → Review ───────────────────────────────
function PhaseRail({ phase }: { phase: number }) {
  const steps = [
    { label: "Reading form", icon: ScanLine },
    { label: "Drafting answers", icon: PenLine },
    { label: "Review & submit", icon: CheckCircle2 },
  ];
  return (
    <div className="mb-6 flex items-center gap-2.5">
      {steps.map((s, i) => {
        const Icon = s.icon;
        const state = i < phase ? "done" : i === phase ? "active" : "todo";
        return (
          <Fragment key={i}>
            <div className="flex items-center gap-2" aria-current={state === "active" ? "step" : undefined}>
              <span
                aria-hidden
                className={cn(
                  "relative grid size-6 place-items-center rounded-full border transition-colors duration-150 ease-out",
                  state === "done" && "border-brand bg-brand text-brand-foreground",
                  state === "active" && "border-brand text-brand",
                  state === "todo" && "border-border text-faint",
                )}
              >
                {state === "done" ? <Check className="size-3.5" /> : <Icon className="size-3.5" />}
                {state === "active" && <span className="absolute inset-0 -z-10 rounded-full bg-brand/30 motion-safe:animate-ping" />}
              </span>
              {/* the label stays for screen readers where it is hidden on narrow screens */}
              <span className={cn("text-xs font-medium max-sm:sr-only", i <= phase ? "text-foreground" : "text-faint")}>{s.label}</span>
            </div>
            {i < steps.length - 1 && (
              <span aria-hidden className="relative h-px flex-1 overflow-hidden rounded-full bg-border">
                <span
                  className={cn(
                    "absolute inset-0 origin-left bg-brand motion-safe:transition-transform motion-safe:duration-300 motion-safe:ease-out",
                    i < phase ? "scale-x-100" : "scale-x-0",
                  )}
                />
              </span>
            )}
          </Fragment>
        );
      })}
    </div>
  );
}

// Honest, calming rotation of what the planner is actually doing, so the (~1-2min)
// draft doesn't feel stalled. Crossfades every ~2.8s.
const DRAFT_MSGS = [
  "Reading your CV…",
  "Reading the role and company…",
  "Matching your experience to each question…",
  "Writing every answer in your own voice…",
  "Flagging anything that needs your call…",
];
function RotatingStatus() {
  const [i, setI] = useState(0);
  useEffect(() => {
    const t = setInterval(() => setI((n) => (n + 1) % DRAFT_MSGS.length), 2800);
    return () => clearInterval(t);
  }, []);
  return (
    <div key={i} className="co-rise truncate text-xs text-muted">
      {DRAFT_MSGS[i]}
    </div>
  );
}

function ProcessingHero({ title, subtitle }: { title: string; subtitle: string }) {
  return (
    <div role="status" className="co-rise flex flex-col items-center gap-3 py-14 text-center">
      <span aria-hidden className="relative grid size-16 place-items-center">
        <span className="co-orb absolute inset-0 rounded-full bg-brand/30 blur-lg" />
        <span className="co-ring absolute inset-0 rounded-full border-2 border-brand/30 border-t-brand" />
        <Sparkles className="size-7 text-brand" />
      </span>
      <div className="font-display text-3xl text-landing">{title}</div>
      <p className="max-w-sm text-sm text-muted">{subtitle}</p>
    </div>
  );
}

function FieldSkeleton() {
  return (
    <div aria-hidden className="co-rise space-y-3 rounded-2xl border border-border/70 bg-surface/70 p-5 backdrop-blur-md" style={{ animationDelay: "120ms" }}>
      {[64, 80, 48, 72, 56].map((w, i) => (
        <div key={i} className="space-y-2">
          <div className="co-skel h-3" style={{ width: `${w}px` }} />
          <div className="co-skel h-9 w-full" />
        </div>
      ))}
    </div>
  );
}

function FieldRow({
  field: f,
  value,
  needs,
  index,
  drafting,
  onChange,
}: {
  field: ApplyField;
  value: string;
  needs: boolean;
  index: number;
  drafting: boolean;
  onChange: (v: string) => void;
}) {
  // Flash brand-orange the moment a drafted answer first lands (empty → value).
  const prev = useRef(value);
  const [flash, setFlash] = useState(false);
  useEffect(() => {
    if (!prev.current && value) {
      setFlash(true);
      // outlast the staggered animation-delay (≤900ms) + the 1.15s flash
      const t = setTimeout(() => setFlash(false), 2300);
      prev.current = value;
      return () => clearTimeout(t);
    }
    prev.current = value;
  }, [value]);

  // Glass over the backdrop; a field the user must answer keeps the warn edge.
  const control = cn("bg-surface/60", needs && "border-warn/50");
  const label = (
    <span className="inline-flex items-center gap-1">
      {f.label || <span className="text-faint">Untitled field</span>}
      {f.required && (
        <>
          <Asterisk aria-hidden className="size-3 text-brand" />
          <span className="sr-only">(required)</span>
        </>
      )}
      {needs && <span className="ml-1 rounded-md bg-warn/15 px-1.5 py-0.5 text-2xs font-semibold text-warn">you confirm</span>}
    </span>
  );
  const placeholder = needs ? "You fill this one." : "…";
  // While the planner is drafting, an empty answer shimmers like it's being
  // written; it flashes into the real value the instant the draft lands.
  const writing = drafting && !value && f.type !== "file";
  return (
    <div className={flash ? "co-flash" : ""} style={flash ? { animationDelay: `${Math.min(index * 70, 900)}ms` } : undefined}>
      {writing ? (
        <Field label={label}>
          <div aria-hidden className={cn("co-skel", f.type === "textarea" ? "h-20" : "h-9")} />
        </Field>
      ) : f.type === "textarea" ? (
        <Textarea label={label} rows={3} maxLength={f.maxLength} value={value} onChange={(e) => onChange(e.target.value)} placeholder={placeholder} className={cn(control, "resize-none")} />
      ) : (f.type === "select" || f.type === "radio") && f.options && f.options.length > 0 ? (
        <Select label={label} value={value} onChange={(e) => onChange(e.target.value)} className={control}>
          <option value="">Choose…</option>
          {f.options.map((o, i) => (
            <option key={i} value={o}>
              {o}
            </option>
          ))}
        </Select>
      ) : f.type === "checkbox" ? (
        <Field label={label}>
          <label className="flex items-center gap-2 text-sm text-muted max-sm:min-h-11">
            <input type="checkbox" checked={value === "true" || value === "yes"} onChange={(e) => onChange(e.target.checked ? "true" : "")} className="size-4 accent-brand focus-ring" /> {f.label || "Yes"}
          </label>
        </Field>
      ) : f.type === "file" ? (
        <Field label={label}>
          {/resume|résumé|\bcv\b|curriculum|currículum|lebenslauf/i.test(f.label || "") ? (
            <Card inset tone="good" className="flex items-center gap-2 px-3 py-2 text-sm text-brand-text">
              <FileCheck2 aria-hidden className="size-4 shrink-0" /> Your tailored CV (PDF) will be attached automatically — you can swap it on the real form.
            </Card>
          ) : (
            <div className="flex items-center gap-2 rounded-xl border border-dashed border-border px-3 py-2 text-sm text-muted">
              <Paperclip aria-hidden className="size-4 shrink-0" /> Attach this file yourself on the real form at the handoff.
            </div>
          )}
        </Field>
      ) : (
        <Input label={label} type={["email", "tel", "url", "number", "date"].includes(f.type) ? f.type : "text"} maxLength={f.maxLength} value={value} onChange={(e) => onChange(e.target.value)} placeholder={placeholder} className={control} />
      )}
    </div>
  );
}
