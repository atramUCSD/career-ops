"use client";

// The setup wizard (plan Phase 4): seven stages on the camera world, a stepper,
// and a rail that holds the task list and, at the overview, the review and
// Apply. The route is the state: /setup/<stage> flies to a stage, /setup zooms
// out. Each stage is a native form, so Enter continues; errors are checked
// before the camera moves and stop it with a GOV.UK error summary. Nothing
// reaches the user's files until Apply, except a CV saved through CvIngest.

import { useEffect, useMemo, useRef, useState, useSyncExternalStore, type FormEvent, type ReactNode } from "react";
import Link from "next/link";
import { useRouter, useSelectedLayoutSegment } from "next/navigation";
import { radialPositions } from "@/lib/camera-path.mjs";
import { addRole, baseFrom, bins, draftFrom, formFrom, passing, REMOTE, setEmail, stageLabel, STAGES, STAGE_IDS, status, validate } from "@/lib/setup-wizard.mjs";
import type { Schedule } from "@/lib/home/home-data";
import { OVERVIEW, Stage, World } from "@/components/ui/camera";
import { Badge } from "@/components/ui/badge";
import { Button, buttonVariants } from "@/components/ui/button";
import { Field, Input, Select, Switch } from "@/components/ui/field";
import { ChipList, postJson } from "@/components/home/motion-bits";
import { HEALTH } from "@/components/home/setup-panel";
import { CvIngest } from "@/components/cv/cv-ingest";
import { cn } from "@/lib/cn";

type Form = ReturnType<typeof baseFrom>;
type Setup = Record<string, any>;
type Change = { path: (string | number)[]; before: unknown; after: unknown };
type Diff = Record<string, any>;
type Applied = { ok: boolean; landed: string[]; failed?: { target: string; error: string }; added?: Record<string, any>; draftKept?: string; error?: string };
type Board = { name: string; status: "live" | "empty" | "broken" | "skipped" | "unknown"; detail?: string };

const R = 900;
const WIDTH: Record<string, string> = { you: "w-xl", what: "w-2xl", where: "w-lg", who: "w-2xl", picky: "w-xl", tell: "w-lg", when: "w-lg" };
const FILES: Record<string, string> = {
  portals: "portals.yml",
  alerts: "config/alerts.yml",
  profile: "config/profile.yml",
  personalization: "modes/_profile.md",
  lanes: "config/lanes.yml",
};
const BOARD_TONE: Partial<Record<Board["status"], "good" | "warn">> = { live: "good", broken: "warn" };
// 400% zoom on a 1280px screen is 320 CSS px wide; 200% on a 720px-tall one is 360 tall.
const FLAT = "(max-width: 40rem), (max-height: 30rem)";

const subscribe = (cb: () => void) => {
  const m = matchMedia(FLAT);
  m.addEventListener("change", cb);
  return () => m.removeEventListener("change", cb);
};
const message = (e: unknown) => (e instanceof Error ? e.message : String(e));
const show = (v: unknown) => (v === undefined ? "(none)" : Array.isArray(v) ? v.join(", ") || "(empty)" : String(v));
const hrefOf = (id: string) => (id === OVERVIEW ? "/setup" : `/setup/${id}`);
// discover-ats lists a company as a bare name or as an object with one.
const names = (rs: ({ name?: string } | string)[]) => rs.map((r) => (typeof r === "string" ? r : r.name));

/** "7:00 AM" to minutes past midnight. */
function minutes(t: string) {
  const m = /^(\d{1,2}):(\d{2})\s*([AP]M)$/i.exec(t.trim());
  if (!m) return null;
  return ((Number(m[1]) % 12) + (m[3].toUpperCase() === "PM" ? 12 : 0)) * 60 + Number(m[2]);
}

export function SetupWizard({
  setup,
  hasCv,
  scores,
  schedule,
  gmailMissing,
  persona,
  children,
}: {
  setup: Setup;
  hasCv: boolean;
  scores: number[];
  schedule: Schedule | null;
  gmailMissing: string[];
  persona: string;
  children: ReactNode;
}) {
  const router = useRouter();
  const segment = useSelectedLayoutSegment();
  const active = segment && STAGE_IDS.includes(segment) ? segment : OVERVIEW;
  const flat = useSyncExternalStore(subscribe, () => matchMedia(FLAT).matches, () => false);

  const base = useMemo(() => baseFrom(setup), [setup]);
  const unfilled = useMemo(
    () => (Array.isArray(setup.personalization?.value) ? setup.personalization.value : []).filter((s: { state: string }) => s.state !== "filled").map((s: { id: string }) => s.id),
    [setup],
  );
  const [form, setForm] = useState<Form>(() => formFrom(setup));
  const draft = useMemo(() => draftFrom(form, base, unfilled), [form, base, unfilled]);
  const empty = Object.keys(draft).length === 0;

  const [shown, setShown] = useState<Set<string>>(() => new Set());
  const [summary, setSummary] = useState<{ stage: string; n: number } | null>(null);
  const [serverError, setServerError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [diff, setDiff] = useState<Diff | null>(null);
  const [applying, setApplying] = useState(false);
  const [applied, setApplied] = useState<Applied | null>(null);
  const [replacing, setReplacing] = useState(false);
  const [boards, setBoards] = useState<Record<string, Board> | null>(null);
  const [boardsError, setBoardsError] = useState<string | null>(null);
  const [checking, setChecking] = useState(false);

  const railHeading = useRef<HTMLHeadingElement>(null);
  const flatHeading = useRef<HTMLHeadingElement>(null);
  const mounted = useRef(false);

  const positions = useMemo(() => radialPositions(STAGE_IDS, R) as Record<string, [number, number]>, []);
  const ring = STAGE_IDS.slice(1).map((id) => positions[id]);

  // No title here: Next's route announcer reads it in the navigation commit, so
  // each stage route sets it in generateMetadata. One written at settle is a hop stale.
  const onSettle = (id: string) => {
    // No stage h1 to land on at the overview: the review heading takes focus instead of body.
    if (id === OVERVIEW) railHeading.current?.focus({ preventScroll: true });
  };

  // Flat mode has no flight to land focus, so it moves focus on the route change.
  useEffect(() => {
    if (flat && mounted.current) (active === OVERVIEW ? railHeading : flatHeading).current?.focus();
    mounted.current = true;
  }, [active, flat]);

  useEffect(() => {
    if (summary) document.getElementById(`summary-${summary.stage}`)?.focus();
  }, [summary]);

  // Re-entry with a saved draft: fetch what it would change, so the review is not blank.
  useEffect(() => {
    if (active !== OVERVIEW || diff || empty) return;
    postJson<{ diff: Diff }>("/api/setup", { draft })
      .then((r) => setDiff(r.diff))
      .catch((e) => setServerError(message(e)));
  }, [active]);

  const go = (id: string) => router.push(hrefOf(id), { scroll: false });
  const errorsOf = (stage: string): Record<string, string> => validate(stage, form);
  const visible = (stage: string) => Object.fromEntries(Object.entries(errorsOf(stage)).filter(([k]) => shown.has(k)));

  async function submit(e: FormEvent, stage: string) {
    e.preventDefault();
    const errs = errorsOf(stage);
    setServerError(null);
    if (Object.keys(errs).length) {
      setShown((s) => new Set([...s, ...Object.keys(errs)]));
      setSummary((p) => ({ stage, n: (p?.n ?? 0) + 1 }));
      return;
    }
    setSaving(true);
    try {
      const r = await postJson<{ diff: Diff }>("/api/setup", { draft });
      setDiff(r.diff);
      setApplied(null);
    } catch (err) {
      setServerError(message(err));
      setSummary((p) => ({ stage, n: (p?.n ?? 0) + 1 }));
      return;
    } finally {
      setSaving(false);
    }
    setSummary(null);
    const i = STAGE_IDS.indexOf(stage);
    go(i === STAGE_IDS.length - 1 ? OVERVIEW : STAGE_IDS[i + 1]);
  }

  async function apply() {
    setApplying(true);
    setApplied(null);
    try {
      const r = await fetch("/api/setup?apply=1", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ draft }) });
      const j = (await r.json().catch(() => ({ ok: false, landed: [], error: `HTTP ${r.status}` }))) as Applied;
      setApplied(j);
      if (j.ok) {
        setForm((f) => ({ ...f, adds: [] }));
        setDiff(null);
      }
      // Re-read the files either way: a failed run may still have landed some of them.
      router.refresh();
    } catch (e) {
      setApplied({ ok: false, landed: [], error: message(e) });
    } finally {
      setApplying(false);
    }
  }

  async function checkBoards() {
    setChecking(true);
    setBoardsError(null);
    try {
      const r = await fetch("/api/portals/verify");
      const j = await r.json();
      if (!r.ok || j.error) throw new Error(j.error || `HTTP ${r.status}`);
      setBoards(Object.fromEntries((j.companies as Board[]).map((c) => [c.name, c])));
    } catch (e) {
      setBoardsError(message(e));
    } finally {
      setChecking(false);
    }
  }

  const onBlur = (e: React.FocusEvent<HTMLFormElement>) => {
    const k = (e.target as HTMLElement).closest<HTMLElement>("[data-field]")?.dataset.field;
    if (k && !shown.has(k)) setShown((s) => new Set(s).add(k));
  };

  const focusField = (key: string) => {
    document.querySelector<HTMLElement>(`#f-${key} :is(input, select, textarea, button)`)?.focus();
  };

  function Summary({ stage }: { stage: string }) {
    if (summary?.stage !== stage) return null;
    const errs = Object.entries(errorsOf(stage));
    if (!errs.length && !serverError) return null;
    return (
      <div id={`summary-${stage}`} tabIndex={-1} aria-labelledby={`summary-${stage}-title`} className="rounded-xl border border-bad/30 bg-bad-soft p-4 outline-none">
        <div role="alert">
          <h2 id={`summary-${stage}-title`} className="text-sm font-semibold text-foreground">
            There is a problem
          </h2>
          <ul className="mt-2 space-y-1 text-sm">
            {errs.map(([k, m]) => (
              <li key={k}>
                <a
                  href={`#f-${k}`}
                  onClick={(e) => {
                    e.preventDefault();
                    focusField(k);
                  }}
                  className="text-bad-text underline underline-offset-2 focus-ring"
                >
                  {m}
                </a>
              </li>
            ))}
            {serverError && <li className="text-foreground">Could not save: {serverError}</li>}
          </ul>
        </div>
      </div>
    );
  }

  const formProps = (stage: string) => ({
    noValidate: true,
    onBlur,
    onSubmit: (e: FormEvent) => submit(e, stage),
    className: "space-y-4",
  });
  const actions = (stage: string) => (
    <div className="flex items-center gap-2 pt-2">
      <Button type="submit" loading={saving}>
        {stage === "when" ? "Review" : "Continue"}
      </Button>
    </div>
  );
  const set = <K extends keyof Form>(k: K) => (v: Form[K]) => setForm((f) => ({ ...f, [k]: v }));
  const text = (k: keyof Form, label: string, errs: Record<string, string>, extra: Partial<React.ComponentProps<typeof Input>> = {}) => (
    <div data-field={k} id={`f-${k}`}>
      <Input
        id={`in-${k}`}
        label={label}
        value={form[k] as string}
        onChange={(e) => (k === "email" ? setForm((f) => setEmail(f, e.target.value)) : set(k)(e.target.value as never))}
        error={errs[k]}
        {...extra}
      />
    </div>
  );

  const companies = Object.keys({ ...base.companies, ...form.companies });
  const hist = bins(scores);
  const histMax = Math.max(1, ...hist);
  const pass = passing(scores, form.minMatch);
  const times = (schedule?.times ?? []).map(minutes).filter((m): m is number => m !== null);
  const health = schedule ? HEALTH[schedule.health] : null;
  const nextRun = schedule?.nextRun ? new Date(schedule.nextRun).toLocaleString("en-US", { weekday: "short", hour: "numeric", minute: "2-digit" }) : null;

  const bodies: Record<string, (errs: Record<string, string>) => ReactNode> = {
    you: (errs) => (
      <>
        <p className="text-sm text-muted">
          No account. Paste text or drop a .md / .txt file to start. A PDF needs an AI CLI in{" "}
          <a href="/config" className="text-foreground underline-offset-2 hover:underline focus-ring">
            Config
          </a>{" "}
          first. The market scan is <span className="text-foreground">free</span>. You only spend tokens when you choose to score a role.
        </p>
        {hasCv && !replacing ? (
          <div className="flex items-center justify-between gap-3 rounded-xl border border-border bg-surface p-4 text-sm">
            <span className="text-foreground">cv.md is in place.</span>
            <Button type="button" variant="secondary" size="sm" onClick={() => setReplacing(true)}>
              Replace CV
            </Button>
          </div>
        ) : (
          <CvIngest
            embedded
            onSaved={(seed) => {
              setForm((f) => {
                let n = f;
                if (seed?.roles?.length && !f.roles.length) n = seed.roles.reduce(addRole, n);
                if (seed?.location && !f.home.trim()) n = { ...n, home: seed.location };
                return n;
              });
              setReplacing(false);
              router.refresh();
            }}
          />
        )}
        <form {...formProps("you")}>
          {text("name", "Your name", errs, { autoComplete: "name" })}
          {text("email", "Your email", errs, { type: "email", autoComplete: "email", spellCheck: false, hint: "Alerts go here unless you name another address." })}
          {actions("you")}
        </form>
      </>
    ),
    what: (errs) => (
      <form {...formProps("what")}>
        <div data-field="roles" id="f-roles">
          <Field label="Roles you want" hint="Adding a role also adds it as a search keyword." error={errs.roles}>
            <ChipList label="Roles" values={form.roles} onChange={(next) => setForm((f) => next.reduce(addRole, { ...f, roles: next.filter((r) => f.roles.includes(r)) }))} />
          </Field>
        </div>
        <div data-field="keywords" id="f-keywords">
          <Field label="Title keywords" hint="The scan keeps a posting whose title contains one of these." error={errs.keywords}>
            <ChipList label="Title keywords" values={form.keywords} onChange={set("keywords")} />
          </Field>
        </div>
        {Object.entries(form.lanes).map(([id, kw]) => (
          <div key={id} data-field={`lane-${id}`} id={`f-lane-${id}`}>
            <Field label={`${id} lane keywords`} error={errs[`lane-${id}`]}>
              <ChipList label={`${id} lane keywords`} values={kw} onChange={(next) => setForm((f) => ({ ...f, lanes: { ...f.lanes, [id]: next } }))} />
            </Field>
          </div>
        ))}
        <div className="grid gap-4 sm:grid-cols-3">
          {text("targetRange", "Target pay", errs, { hint: "Like 120-150K" })}
          {text("walkAway", "Walk-away pay", errs)}
          {text("currency", "Currency", errs, { hint: "Like USD" })}
        </div>
        {actions("what")}
      </form>
    ),
    where: (errs) => (
      <form {...formProps("where")}>
        {text("home", "Where you live", errs, { autoComplete: "address-level2" })}
        <div data-field="remote" id="f-remote">
          <Select id="in-remote" label="Work mode" value={form.remote} onChange={(e) => set("remote")(e.target.value)} error={errs.remote}>
            <option value="">Not set</option>
            {[...REMOTE, ...(form.remote && !REMOTE.includes(form.remote) ? [form.remote] : [])].map((r) => (
              <option key={r}>{r}</option>
            ))}
          </Select>
        </div>
        <div data-field="places" id="f-places">
          <Field label="Places to search" hint="Cities or countries. Remote is not a place: leave this empty to search anywhere.">
            <ChipList label="Places to search" values={form.places} onChange={set("places")} />
          </Field>
        </div>
        {actions("where")}
      </form>
    ),
    who: () => (
      <form {...formProps("who")}>
        <fieldset>
          <legend className="mb-1.5 text-sm font-medium text-foreground">Companies to watch</legend>
          {companies.length ? (
            <ul className="grid gap-x-4 gap-y-1.5 sm:grid-cols-2">
              {companies.map((n) => {
                const b = boards?.[n];
                return (
                  <li key={n}>
                    <label className="flex items-center gap-2 text-sm text-foreground">
                      <input
                        type="checkbox"
                        className="size-4 accent-brand focus-ring"
                        checked={form.companies[n] ?? base.companies[n] ?? false}
                        onChange={(e) => setForm((f) => ({ ...f, companies: { ...f.companies, [n]: e.target.checked } }))}
                      />
                      {n}
                      {b && (
                        <Badge tone={BOARD_TONE[b.status]} title={b.detail}>
                          {b.status}
                        </Badge>
                      )}
                    </label>
                  </li>
                );
              })}
            </ul>
          ) : (
            <p className="text-sm text-muted">No companies in portals.yml yet. Add some below.</p>
          )}
        </fieldset>
        <div className="flex flex-wrap items-center gap-2">
          <Button type="button" variant="secondary" size="sm" loading={checking} onClick={checkBoards}>
            Check boards
          </Button>
          <span className="text-xs text-muted">Asks each board for postings. Takes up to two minutes.</span>
        </div>
        {boardsError && <p className="text-xs text-bad-text">Could not check boards: {boardsError}</p>}
        <div data-field="adds" id="f-adds">
          <Field label="Companies to add" hint="Looked up on Apply and added when a board is found. Up to 20.">
            <ChipList label="Companies to add" values={form.adds} onChange={set("adds")} />
          </Field>
        </div>
        {actions("who")}
      </form>
    ),
    picky: (errs) => (
      <form {...formProps("picky")}>
        <div data-field="minMatch" id="f-minMatch">
          <label htmlFor="in-minMatch" className="mb-1.5 block text-sm font-medium text-foreground">
            Lowest match score to alert on: <span className="tabular-nums">{Number.isFinite(form.minMatch) ? form.minMatch : "?"}</span>
          </label>
          {scores.length > 0 && (
            <div aria-hidden className="mb-2 flex h-28 items-end gap-1">
              {hist.map((h, i) => (
                <div key={i} className={cn("flex-1 rounded-sm", i * 5 + 5 > form.minMatch ? "bg-brand" : "bg-faint/50")} style={{ height: `${(h / histMax) * 100}%` }} />
              ))}
            </div>
          )}
          <input
            id="in-minMatch"
            type="range"
            min={0}
            max={100}
            step={1}
            value={Number.isFinite(form.minMatch) ? form.minMatch : 42}
            onChange={(e) => set("minMatch")(Number(e.target.value))}
            aria-describedby="minMatch-pass"
            className="w-full accent-brand focus-ring"
          />
          <p id="minMatch-pass" className="mt-1.5 text-xs text-muted">
            {scores.length ? `${pass} of ${scores.length} scored roles pass.` : "No scored roles yet, so there is nothing to preview."}
          </p>
          {errs.minMatch && <p className="mt-1.5 text-xs text-bad-text">{errs.minMatch}</p>}
        </div>
        {text("maxRows", "Matches per alert", errs, {
          type: "number",
          inputMode: "numeric",
          min: 1,
          max: 100,
          value: Number.isNaN(form.maxRows) ? "" : form.maxRows,
          onChange: (e) => set("maxRows")(e.target.value === "" ? NaN : Number(e.target.value)),
        })}
        <div className="flex items-center justify-between gap-3">
          <span className="text-sm text-foreground">Skip the email when nothing matches</span>
          <Switch checked={form.quiet} onChange={set("quiet")} label="Skip the email when nothing matches" />
        </div>
        {actions("picky")}
      </form>
    ),
    tell: (errs) => (
      <form {...formProps("tell")}>
        <div className="flex items-center justify-between gap-3">
          <span className="text-sm text-foreground">Email me new matches</span>
          <Switch checked={form.alertsOn} onChange={set("alertsOn")} label="Email me new matches" />
        </div>
        {text("to", "Send alerts to", errs, { spellCheck: false, autoComplete: "email", hint: "Separate addresses with commas." })}
        <div className="flex items-center justify-between gap-3">
          <span className="text-sm text-foreground">Also add a calendar event for each alert</span>
          <Switch checked={form.calendarOn} onChange={set("calendarOn")} label="Also add a calendar event for each alert" />
        </div>
        {form.calendarOn && (
          <p className="text-xs text-muted">
            Needs a calendar token. Run <code className="rounded-md bg-surface-muted px-1 font-mono">node scripts/mint-gmail-token.mjs --calendar</code> once at your desk.
          </p>
        )}
        {gmailMissing.length > 0 && (
          <div className="rounded-xl border border-warn/30 bg-warn-soft p-4 text-sm text-foreground">
            Email sending is not set up yet. Missing in .env: {gmailMissing.join(", ")}.
          </div>
        )}
        {actions("tell")}
      </form>
    ),
    when: () => (
      <form {...formProps("when")}>
        <svg viewBox="-110 -110 220 220" className="mx-auto size-56" aria-hidden>
          <circle r={100} className="fill-none stroke-border" strokeWidth={2} />
          {Array.from({ length: 24 }, (_, h) => {
            const a = (h / 24) * 2 * Math.PI;
            return <line key={h} x1={88 * Math.sin(a)} y1={-88 * Math.cos(a)} x2={100 * Math.sin(a)} y2={-100 * Math.cos(a)} className="stroke-faint" strokeWidth={h % 6 ? 1 : 3} />;
          })}
          {times.map((m) => {
            const a = (m / 1440) * 2 * Math.PI;
            return <line key={m} x1={0} y1={0} x2={76 * Math.sin(a)} y2={-76 * Math.cos(a)} className="stroke-brand" strokeWidth={4} strokeLinecap="round" />;
          })}
          <circle r={5} className="fill-brand" />
        </svg>
        <div className="flex flex-wrap items-center gap-2 text-sm text-foreground">
          {health ? <Badge tone={health.tone}>{health.label}</Badge> : <Badge>Not found</Badge>}
          {schedule?.times.length ? <span>Runs daily at {schedule.times.join(" and ")}.</span> : <span>No scheduled task found. Matches update when you run a scan.</span>}
        </div>
        {nextRun && <p className="text-sm text-muted">Next run: {nextRun}</p>}
        <p className="text-xs text-muted">Run times come from the scheduled task, not from this page.</p>
        {actions("when")}
      </form>
    ),
  };

  const taskList = (
    <ol className="space-y-1">
      {STAGES.map((s) => {
        const done = status(s.id, form, { hasCv }) === "done";
        return (
          <li key={s.id}>
            <Link
              href={hrefOf(s.id)}
              scroll={false}
              aria-current={active === s.id ? "step" : undefined}
              className="flex items-center justify-between gap-2 rounded-md px-2 py-1.5 text-foreground transition-colors duration-150 ease-out hover:bg-surface-hover focus-ring-inset aria-[current=step]:bg-brand-soft"
            >
              <span>{s.label}</span>
              <Badge tone={done ? "good" : "warn"}>{done ? "Completed" : "Needs attention"}</Badge>
            </Link>
          </li>
        );
      })}
    </ol>
  );

  const targets = diff ? Object.keys(FILES).filter((t) => diff[t]) : [];
  const review = (
    <section aria-labelledby="review-changes" className="space-y-3">
      <h3 id="review-changes" className="eyebrow text-xs font-semibold text-muted">
        Changes to apply
      </h3>
      {empty && !applied?.ok && <p className="text-foreground">Nothing to apply. Your files already say this.</p>}
      {!empty && !diff && <p className="text-muted">Working out what changes…</p>}
      {targets.map((t) => {
        const d = diff![t];
        return (
          <div key={t} className="rounded-xl border border-border bg-surface p-3">
            <p className="font-mono text-xs text-foreground">
              {FILES[t]}
              {d.seeded && <span className="text-muted"> (new file)</span>}
            </p>
            {d.error ? (
              <p className="mt-1 text-xs text-bad-text">{d.error}</p>
            ) : t === "personalization" ? (
              <p className="mt-1 text-xs text-muted">{d.changed ? `Fills ${d.sections.join(", ")}` : "No change"}</p>
            ) : (
              <ul className="mt-1 space-y-1 text-xs text-muted">
                {(d.changes as Change[]).map((c) => (
                  <li key={c.path.join(".")} className="break-words">
                    <span className="text-foreground">{c.path.join(".")}</span>: {show(c.before)} to {show(c.after)}
                  </li>
                ))}
                {!d.changes.length && <li>No change</li>}
              </ul>
            )}
          </div>
        );
      })}
      {diff?.companiesAdd && <p className="text-xs text-muted">Look up and add: {diff.companiesAdd.join(", ")}</p>}
      {scores.length > 0 && (
        <p className="text-xs text-muted">
          {pass} of {scores.length} scored roles pass a match score of {form.minMatch}.
        </p>
      )}
      {nextRun && <p className="text-xs text-muted">Changes take effect on the next run: {nextRun}.</p>}
      {serverError && active === OVERVIEW && <p className="text-xs text-bad-text">{serverError}</p>}
      <Button onClick={apply} loading={applying} disabled={empty} className="w-full">
        Apply to {persona}
      </Button>
      {applied && (
        <div role="status" className="space-y-1 text-xs">
          {applied.ok ? (
            <p className="text-brand-text">{applied.landed.length ? `Saved ${applied.landed.map((t) => FILES[t]).join(", ")}.` : "Nothing needed saving."}</p>
          ) : (
            <p className="text-bad-text">
              {applied.failed ? `${FILES[applied.failed.target] ?? applied.failed.target} failed: ${applied.failed.error}` : applied.error}
              {applied.landed.length > 0 && ` Already saved: ${applied.landed.map((t) => FILES[t]).join(", ")}.`}
            </p>
          )}
          {applied.added &&
            (applied.added.error ? (
              <p className="text-warn">Company lookup failed: {applied.added.error}</p>
            ) : (
              <p className="text-muted">
                Added {show(names(applied.added.resolved))}
                {applied.added.unresolved?.length > 0 && `; no board found for ${show(names(applied.added.unresolved))}`}.
              </p>
            ))}
          {applied.draftKept && <p className="text-warn">The saved draft could not be removed: {applied.draftKept}</p>}
          {applied.ok && (
            <p className="flex gap-3 pt-1">
              <Link href="/explore" className="text-foreground underline underline-offset-2 focus-ring">
                See your matches
              </Link>
              <Link href="/" className="text-foreground underline underline-offset-2 focus-ring">
                Home
              </Link>
            </p>
          )}
        </div>
      )}
    </section>
  );

  const rail = (
    <>
      <p className="flex items-center justify-between gap-2">
        <span className="eyebrow text-2xs font-semibold text-muted">Setup · {persona}</span>
        <Link href="/" className="text-xs text-muted underline-offset-2 hover:underline focus-ring">
          Home
        </Link>
      </p>
      <h2 ref={railHeading} tabIndex={-1} className="mt-2 text-lg font-semibold text-foreground outline-none">
        {active === OVERVIEW ? "Review your setup" : "Your setup"}
      </h2>
      <p className="mt-1 text-xs text-muted">{stageLabel(active)}</p>
      <nav aria-label="Setup tasks" className="mt-4">
        {taskList}
      </nav>
      {active === OVERVIEW && <div className="mt-6">{review}</div>}
    </>
  );

  const stepper = (className: string) => (
    <nav aria-label="Setup steps" className={className}>
      {[...STAGES, { id: OVERVIEW, label: "Review" }].map((s) => (
        <Link
          key={s.id}
          href={hrefOf(s.id)}
          scroll={false}
          aria-current={active === s.id ? "step" : undefined}
          className={cn(buttonVariants({ variant: "ghost", size: "sm" }), "aria-[current=step]:bg-brand-soft aria-[current=step]:text-brand-text")}
        >
          {s.label}
        </Link>
      ))}
    </nav>
  );

  if (flat) {
    const s = STAGES.find((x) => x.id === active);
    return (
      <div className="min-h-dvh bg-background px-4 py-6">
        <div className="mx-auto max-w-2xl space-y-6">
          {stepper("flex flex-wrap gap-1")}
          {s && (
            <section className="space-y-4 rounded-2xl border border-border bg-surface p-5">
              <h1 ref={flatHeading} tabIndex={-1} className="font-display text-4xl leading-[1.05] text-landing outline-none">
                {s.title}
              </h1>
              <Summary stage={s.id} />
              {bodies[s.id](visible(s.id))}
            </section>
          )}
          <aside className="rounded-2xl border border-border bg-surface p-5 text-sm">{rail}</aside>
          {children}
        </div>
      </div>
    );
  }

  return (
    <div className="dot-bg fixed inset-0 bg-background">
      {/* inset: the stepper (top-4, about 56px tall) and the w-80 rail, each with a 16px gap. */}
      <World positions={positions} hop={R} active={active} overviewPad={[1000, 760]} inset={[72, 352, 16, 16]} onSettle={onSettle}>
        <svg aria-hidden className="absolute overflow-visible" style={{ left: 0, top: 0 }} width={1} height={1}>
          {ring.map(([x, y], i) => {
            const [nx, ny] = ring[(i + 1) % ring.length];
            return (
              <g key={i} className="stroke-brand/30" strokeWidth={2} strokeDasharray="6 10">
                <line x1={0} y1={0} x2={x} y2={y} />
                <line x1={x} y1={y} x2={nx} y2={ny} />
              </g>
            );
          })}
        </svg>
        {STAGES.map((s) => (
          <Stage key={s.id} id={s.id} title={s.title} className={WIDTH[s.id]}>
            {/* Room for the focus ring: outlines sit 4px outside a control and the body scrolls. */}
            <div className="-mx-1 mt-6 max-h-[calc(100dvh-220px)] space-y-4 overflow-y-auto px-1 pb-1">
              <Summary stage={s.id} />
              {bodies[s.id](visible(s.id))}
            </div>
          </Stage>
        ))}
      </World>

      {stepper("glass fixed top-4 left-1/2 flex -translate-x-1/2 gap-1 rounded-2xl p-1.5")}

      <aside aria-label="Setup progress" className="glass fixed top-24 right-4 bottom-4 w-80 overflow-y-auto rounded-2xl p-4 text-sm">
        {rail}
      </aside>
      {children}
    </div>
  );
}
