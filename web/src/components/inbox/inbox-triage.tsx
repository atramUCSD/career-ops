"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { AnimatePresence, motion } from "motion/react";
import { Undo2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { listItem } from "@/components/ui/motion";
import { useJobs } from "@/components/jobs/job-store";
import type { InboxJob } from "@/lib/career-ops";
import type { AtsSource } from "@/lib/explore";
import { ATS_SOURCES } from "@/lib/explore";
import { daysSince, seniorityFromTitle, sourceFromUrl, SENIORITY_ORDER, type Seniority } from "@/lib/inbox";
import { FacetChips } from "./facet-chips";
import { TriageRow, type RowScore } from "./triage-row";
import { characterizeBatch, ShortlistTray, type PrepProgress, type ShortItem } from "./shortlist-tray";
import { readSavedCliId, resolveCliId } from "@/lib/saved-cli";
import { cn } from "@/lib/cn";
import { estimateRunCost } from "@/lib/run-cost-estimate.mjs";
import { createInboxSkipActions, queueInboxSkip } from "@/lib/inbox-skip-client.mjs";

const SHORTLIST_KEY = "career-ops:shortlist";
const HIDDEN_KEY = "career-ops:hidden";
const CONFIG_KEY = "career-ops:config";
const BATCH = 20;
type UndoNotice = { label: string; fn: () => Promise<void>; busy?: boolean; error?: string };

// The inbox as a TRIAGE surface: Abundance → Triage → Shortlist → Opt-in Score.
// Default is a small fresh batch (never the full wall); free facets + Save/Skip narrow
// it; only "Score shortlist" and "Prepare shortlist" spend tokens (both behind the
// tray's explicit confirm). 🔴 The shell is agnostic to what makes a role relevant —
// order is freshness with a single documented plug point.
export function InboxTriage({ inbox }: { inbox: InboxJob[] }) {
  const router = useRouter();
  const { jobs, startJob } = useJobs();
  // Serialize skip/undo per URL so a fast Undo cannot lose the race to Skip.
  const skipChain = useRef(new Map<string, Promise<void>>());
  const undoRunning = useRef(new Set<UndoNotice["fn"]>());
  const restoreRunning = useRef(false);

  // facets
  const [within, setWithin] = useState<number | null>(null);
  const [sources, setSources] = useState<Set<AtsSource>>(() => new Set());
  const [seniorities, setSeniorities] = useState<Set<Seniority>>(() => new Set());
  const [locQ, setLocQ] = useState("");
  const [kw, setKw] = useState("");
  const [showAll, setShowAll] = useState(false);

  // persisted triage state + ephemeral selection/undo
  const [shortlist, setShortlist] = useState<ShortItem[]>([]);
  const [hidden, setHidden] = useState<string[]>([]);
  const [selected, setSelected] = useState<Set<string>>(() => new Set());
  const [undo, setUndo] = useState<UndoNotice | null>(null);
  const [writeError, setWriteError] = useState("");
  const [restoring, setRestoring] = useState(false);
  const [hasCli, setHasCli] = useState(false);
  const [loaded, setLoaded] = useState(false);

  useEffect(() => {
    try {
      const s = localStorage.getItem(SHORTLIST_KEY);
      if (s) setShortlist(JSON.parse(s));
      const h = localStorage.getItem(HIDDEN_KEY);
      if (h) {
        const parsed = JSON.parse(h) as unknown;
        const urls = Array.isArray(parsed) ? parsed.filter((u): u is string => typeof u === "string") : [];
        const pending = new Set(inbox.map((j) => j.url));
        setHidden(urls.filter((u) => pending.has(u)));
      }
      const c = localStorage.getItem(CONFIG_KEY);
      setHasCli(!!(c && JSON.parse(c).cliId));
    } catch {
      /* ignore */
    }
    setLoaded(true);
    // First SSR inbox only — later refreshes prune via the inbox effect below.
  }, []);
  useEffect(() => {
    if (loaded) try { localStorage.setItem(SHORTLIST_KEY, JSON.stringify(shortlist)); } catch { /* quota */ }
  }, [shortlist, loaded]);
  useEffect(() => {
    if (loaded) try { localStorage.setItem(HIDDEN_KEY, JSON.stringify(hidden)); } catch { /* quota */ }
  }, [hidden, loaded]);
  // After SSR refresh, pipeline.md [x] rows are already gone from `inbox`.
  // Drop them from the localStorage cache so "N hidden" does not linger.
  useEffect(() => {
    const pending = new Set(inbox.map((j) => j.url));
    setHidden((h) => {
      const next = h.filter((u) => pending.has(u));
      return next.length === h.length ? h : next;
    });
  }, [inbox]);
  // auto-dismiss the undo toast
  useEffect(() => {
    if (!undo || undo.busy || undo.error) return;
    const t = setTimeout(() => setUndo((current) => current?.fn === undo.fn && !current.busy && !current.error ? null : current), 5000);
    return () => clearTimeout(t);
  }, [undo]);

  // stable "now" for freshness (per mount)
  const now = useMemo(() => Date.now(), []);

  // Dedupe by URL — pipeline.md can list the same posting twice; it's one job, so it
  // triages once (and Save/Skip/score, all keyed by URL, act on it coherently).
  const enriched = useMemo(() => {
    const seen = new Set<string>();
    const out: { job: InboxJob; source: AtsSource | null; seniority: Seniority | null; age: number | null }[] = [];
    for (const job of inbox) {
      if (seen.has(job.url)) continue;
      seen.add(job.url);
      out.push({ job, source: sourceFromUrl(job.url), seniority: seniorityFromTitle(job.role), age: daysSince(job.postedAt, now) });
    }
    return out;
  }, [inbox, now]);

  // EVALUADA lookup: the latest evaluate worker per posting URL (running → badge).
  const scoreByUrl = useMemo(() => {
    const best = new Map<string, (typeof jobs)[number]>();
    for (const j of jobs) {
      if (!j.input || j.kind !== "evaluate") continue;
      const ex = best.get(j.input);
      if (!ex || j.startedAt > ex.startedAt) best.set(j.input, j);
    }
    const m = new Map<string, RowScore>();
    for (const [url, j] of best) {
      m.set(url, { score: j.result?.score ?? null, tone: j.result?.tone ?? "muted", jobId: j.id, running: j.status === "running", reportN: j.reportN });
    }
    return m;
  }, [jobs]);

  // facet options — only surface what's actually present in the (non-hidden) data
  const availSources = useMemo(() => {
    const set = new Set<AtsSource>();
    for (const e of enriched) if (e.source && !hidden.includes(e.job.url)) set.add(e.source);
    return ATS_SOURCES.filter((s) => set.has(s));
  }, [enriched, hidden]);
  const availSeniorities = useMemo(() => {
    const set = new Set<Seniority>();
    for (const e of enriched) if (e.seniority && !hidden.includes(e.job.url)) set.add(e.seniority);
    return SENIORITY_ORDER.filter((s) => set.has(s));
  }, [enriched, hidden]);

  const filtered = useMemo(
    () =>
      enriched.filter((e) => {
        if (hidden.includes(e.job.url)) return false;
        if (within != null && (e.age == null || e.age > within)) return false;
        if (sources.size && (!e.source || !sources.has(e.source))) return false;
        if (seniorities.size && (!e.seniority || !seniorities.has(e.seniority))) return false;
        if (locQ.trim() && !(e.job.location || "").toLowerCase().includes(locQ.trim().toLowerCase())) return false;
        if (kw.trim() && !`${e.job.company} ${e.job.role}`.toLowerCase().includes(kw.trim().toLowerCase())) return false;
        return true;
      }),
    [enriched, hidden, within, sources, seniorities, locQ, kw],
  );

  // 🔴 SINGLE ORDER PLUG POINT — freshness only (newest first_seen first; unknown last).
  // A smarter ranker replaces ONLY this comparator; facets/triage/shortlist/score never
  // touch relevance. This is the whole firewall in one line.
  const ordered = useMemo(() => [...filtered].sort((a, b) => (a.age ?? Infinity) - (b.age ?? Infinity)), [filtered]);

  const anyFacet = within != null || sources.size > 0 || seniorities.size > 0 || locQ.trim() !== "" || kw.trim() !== "";
  const capped = !showAll && !anyFacet;
  const visible = capped ? ordered.slice(0, BATCH) : ordered;
  const hiddenCount = hidden.length;

  const isShortlisted = (url: string) => shortlist.some((s) => s.url === url);

  const persistSkip = async (url: string, done: boolean) => {
    await queueInboxSkip(skipChain.current, url, done);
    router.refresh();
  };
  const handleUndo = async (notice: UndoNotice) => {
    if (undoRunning.current.has(notice.fn)) return;
    undoRunning.current.add(notice.fn);
    setUndo((current) => current?.fn === notice.fn ? { ...current, busy: true, error: undefined } : current);
    try {
      await notice.fn();
      setUndo((current) => current?.fn === notice.fn ? null : current);
    } catch (cause) {
      const error = cause instanceof Error ? cause.message : "Could not undo this skip. Please try again.";
      setUndo((current) => current?.fn === notice.fn ? { ...current, busy: false, error } : current);
    } finally {
      undoRunning.current.delete(notice.fn);
    }
  };

  const save = (job: InboxJob) => {
    if (isShortlisted(job.url)) return;
    setShortlist((s) => [...s, { url: job.url, company: job.company, role: job.role }]);
  };
  const skip = (job: InboxJob) => {
    setWriteError("");
    setHidden((h) => (h.includes(job.url) ? h : [...h, job.url]));
    const actions = createInboxSkipActions((done) => persistSkip(job.url, done), () => {
      setHidden((h) => h.filter((u) => u !== job.url));
      setUndo((current) => current?.fn === notice.fn && !current.busy ? null : current);
      setWriteError(`Could not skip ${job.company}. Please try Skip again.`);
    });
    const notice: UndoNotice = {
      label: `Skipped ${job.company}`,
      fn: async () => {
        await actions.undo();
        setHidden((h) => h.filter((u) => u !== job.url));
      },
    };
    setUndo(notice);
    void actions.skip();
  };
  const restoreHidden = async () => {
    if (restoreRunning.current) return;
    restoreRunning.current = true;
    setRestoring(true);
    const urls = hidden;
    setWriteError("");
    try {
      await Promise.all(urls.map((url) => persistSkip(url, false).then(() => {
        setHidden((h) => h.filter((u) => u !== url));
      }).catch(() => setWriteError("Some jobs could not be restored. Try restore again."))));
    } finally {
      restoreRunning.current = false;
      setRestoring(false);
    }
  };
  const toggleSelect = (url: string) =>
    setSelected((s) => {
      const n = new Set(s);
      if (n.has(url)) n.delete(url);
      else n.add(url);
      return n;
    });
  const saveSelected = () => {
    const add = enriched
      .filter((e) => selected.has(e.job.url) && !isShortlisted(e.job.url))
      .map((e) => ({ url: e.job.url, company: e.job.company, role: e.job.role }));
    if (add.length) setShortlist((s) => [...s, ...add]);
    setSelected(new Set());
  };

  const estimate = useMemo(() => {
    if (shortlist.length === 0) return {};
    return estimateRunCost(jobs, "evaluate", shortlist.length);
  }, [jobs, shortlist.length]);

  const scoreShortlist = () => {
    const batchId = `shortlist-${Date.now()}`;
    for (const it of shortlist) {
      startJob({ title: `Score · ${it.company}`, subtitle: it.role, kind: "evaluate", input: it.url, page: "/pipeline", batchId });
    }
    setShortlist([]); // sent — the rows flip to Scoring… → badge via scoreByUrl
  };

  // Prepare cost estimate — sibling of `estimate`, sampled from tailor workers;
  // while no tailor history exists, pdf runs seed it (same content-tailoring
  // worker class). {} when there are no samples at all — the tray says so.
  const prepEstimate = useMemo(() => {
    let samples = jobs.filter((j) => j.kind === "tailor" && j.status === "done" && j.cost?.tokens).map((j) => j.cost!);
    if (!samples.length) samples = jobs.filter((j) => j.kind === "pdf" && j.status === "done" && j.cost?.tokens).map((j) => j.cost!);
    if (!samples.length || shortlist.length === 0) return {};
    const avgT = samples.reduce((a, c) => a + c.tokens, 0) / samples.length;
    const usds = samples.filter((s) => s.usd != null).map((s) => s.usd!);
    const avgUsd = usds.length ? usds.reduce((a, c) => a + c, 0) / usds.length : undefined;
    return { tokens: Math.round(avgT * shortlist.length), usd: avgUsd != null ? +(avgUsd * shortlist.length).toFixed(2) : undefined };
  }, [jobs, shortlist.length]);

  // Free batch characterization for "Prepare N" — from scores already on the
  // client. null slot = blocked: no completed evaluation to tailor against
  // (never shortlisted for scoring, still running, or a run with no score).
  const prepBatch = useMemo(
    () =>
      characterizeBatch(
        shortlist.map((it) => {
          const s = scoreByUrl.get(it.url);
          return s && !s.running && s.score != null ? s.score : null;
        }),
      ),
    [shortlist, scoreByUrl],
  );

  const [prep, setPrep] = useState<PrepProgress>({ running: false, label: null, byUrl: {} });

  // "Prepare shortlist" — the tray's second spend. POSTs the batch to /api/prepare
  // and reads the same NDJSON event stream job-store reads from /api/run; per-item
  // {type:"item"} outcomes flip the tray rows the way score results flip triage
  // rows. The shortlist is NOT cleared: rows stay visible carrying their badge.
  // Preparation only — nothing on this path (client or server) submits anything.
  const prepareShortlist = async () => {
    if (prep.running) return;
    const urls = shortlist.map((it) => it.url);
    const cliId = readSavedCliId() || (await resolveCliId());
    if (!cliId) {
      setPrep({ running: false, label: "No CLI configured — open Config and click Save config", byUrl: {} });
      return;
    }
    setPrep({ running: true, label: "Starting…", byUrl: {} });
    const byUrl: PrepProgress["byUrl"] = {};
    let summary = "";
    const finish = (label: string) => {
      setPrep({ running: false, label, byUrl: { ...byUrl } });
      // Every prepared item already wrote a real report/tracker note — tell
      // server-snapshot surfaces (Today, pipeline) to refetch (job-store pattern).
      window.dispatchEvent(new CustomEvent("co-job-done", { detail: { kind: "prepare" } }));
    };
    try {
      const res = await fetch("/api/prepare", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ urls, cliId }),
      });
      if (!res.ok || !res.body) {
        const e = await res.json().catch(() => ({}));
        setPrep({ running: false, label: e.error || "Failed to start", byUrl: {} });
        return;
      }
      const reader = res.body.getReader();
      const dec = new TextDecoder();
      let buf = "";
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        buf += dec.decode(value, { stream: true });
        let nl: number;
        while ((nl = buf.indexOf("\n")) !== -1) {
          const line = buf.slice(0, nl).trim();
          buf = buf.slice(nl + 1);
          if (!line) continue;
          try {
            const ev = JSON.parse(line);
            if (ev.type === "status") {
              setPrep((p) => ({ ...p, label: ev.label }));
            } else if (ev.type === "item" && typeof ev.url === "string") {
              byUrl[ev.url] = ev.status === "prepared" ? "prepared" : "failed";
              setPrep((p) => ({ ...p, byUrl: { ...byUrl } }));
            } else if (ev.type === "done") {
              // finish happens on stream-close (job-store pattern); latch the summary
              summary = `Prepared ${ev.prepared ?? 0} of ${urls.length}${ev.failed ? ` · ${ev.failed} failed` : ""} — review before anything is sent`;
            } else if (ev.type === "error") {
              finish(ev.msg || "Error");
              return;
            }
          } catch {
            /* skip malformed line */
          }
        }
      }
      finish(summary || "Interrupted — check what landed before re-running");
    } catch {
      finish("Connection error");
    }
  };

  return (
    <div className={cn("mt-4 max-w-3xl", shortlist.length > 0 && "pb-28 sm:pb-24")}>
      {writeError && <p role="alert" className="mb-3 text-sm text-bad-text">{writeError}</p>}
      {/* Keep recovery mounted when the last Skip refreshes to an empty inbox. */}
      <div hidden={inbox.length === 0}>
      <FacetChips
        within={within}
        setWithin={setWithin}
        sources={sources}
        toggleSource={(s) => setSources((set) => { const n = new Set(set); n.has(s) ? n.delete(s) : n.add(s); return n; })}
        seniorities={seniorities}
        toggleSeniority={(s) => setSeniorities((set) => { const n = new Set(set); n.has(s) ? n.delete(s) : n.add(s); return n; })}
        locQ={locQ}
        setLocQ={setLocQ}
        kw={kw}
        setKw={setKw}
        availSources={availSources}
        availSeniorities={availSeniorities}
        resultCount={filtered.length}
        totalCount={enriched.length - hiddenCount}
        anyActive={anyFacet}
        onClear={() => { setWithin(null); setSources(new Set()); setSeniorities(new Set()); setLocQ(""); setKw(""); }}
      />

      {/* batch header: fresh slice by default, or the full filtered set */}
      <div className="mt-4 flex items-baseline justify-between gap-3">
        <p className="eyebrow text-xs font-semibold text-muted">
          {capped ? "Fresh — worth a look" : anyFacet ? `${filtered.length} match${filtered.length === 1 ? "" : "es"}` : "All roles"}
        </p>
        {hiddenCount > 0 && (
            <Button variant="ghost" size="sm" onClick={() => void restoreHidden()} disabled={restoring} aria-busy={restoring} className="text-faint">
              {hiddenCount} hidden · {restoring ? "restoring…" : "restore"}
            </Button>
        )}
      </div>

      {/* multi-select action bar */}
      {selected.size > 0 && (
        <div className="mt-2 flex items-center gap-2 rounded-xl border border-brand/30 bg-brand-soft px-3 py-2 text-sm">
          <span className="font-medium text-brand-text tabular-nums">{selected.size} selected</span>
          <Button size="sm" onClick={saveSelected}>
            Save to shortlist
          </Button>
          <Button variant="ghost" size="sm" onClick={() => setSelected(new Set())} className="text-muted">
            Clear
          </Button>
        </div>
      )}

      {visible.length > 0 ? (
        // relative: popLayout pins an exiting row absolutely inside this list.
        <ul className="relative mt-3 divide-y divide-border overflow-hidden rounded-xl border border-border bg-surface/40">
          <AnimatePresence initial={false} mode="popLayout">
            {visible.map((e) => (
              <TriageRow
                key={e.job.url}
                job={e.job}
                source={e.source}
                age={e.age}
                scored={scoreByUrl.get(e.job.url)}
                selected={selected.has(e.job.url)}
                shortlisted={isShortlisted(e.job.url)}
                onToggleSelect={() => toggleSelect(e.job.url)}
                onSave={() => save(e.job)}
                onSkip={() => skip(e.job)}
              />
            ))}
          </AnimatePresence>
        </ul>
      ) : (
        <Card inset className="mt-3 border-dashed bg-surface/30 px-6 py-10 text-center">
          <p className="font-display text-lg">No matches</p>
          <p className="mx-auto mt-1 max-w-sm text-sm text-muted">Loosen the filters to see more of your inbox.</p>
        </Card>
      )}

      {/* "See all N" — only when the fresh batch is capping a larger list */}
      {capped && ordered.length > BATCH && (
        <Button
          variant="secondary"
          onClick={() => setShowAll(true)}
          className="mt-3 w-full bg-surface/40 text-muted hover:border-brand/40 hover:bg-surface/40 hover:text-brand"
        >
          See all {ordered.length} in inbox →
        </Button>
      )}

      {/* empty-shortlist guidance (only once there's nothing saved) */}
      {shortlist.length === 0 && (
        <p className="mt-4 text-center text-xs text-faint">Save roles worth a look, then score them together — one token spend.</p>
      )}
      </div>

      {/* undo toast (sits above the tray) */}
        <AnimatePresence initial={false}>
          {undo && (
            <motion.div
              key="undo"
              {...listItem}
              className={cn("fixed inset-x-0 z-40 flex justify-center px-4", shortlist.length > 0 ? "bottom-24 sm:bottom-24" : "bottom-20 sm:bottom-6")}
            >
              <div className="inline-flex max-w-full flex-wrap items-center gap-2 rounded-xl border border-border bg-surface py-1.5 pl-4 pr-1.5 text-sm shadow-overlay">
                <div className="min-w-0 flex-1 break-words">
                  <span className="text-muted" role="status">{undo.label}</span>
                  {undo.error && <p role="alert" className="text-bad-text">{undo.error}</p>}
                </div>
                <Button variant="ghost" size="sm" onClick={() => void handleUndo(undo)} disabled={undo.busy} aria-busy={Boolean(undo.busy)} className="shrink-0 text-brand hover:text-brand">
                  <Undo2 aria-hidden className="size-3.5" /> {undo.busy ? "Undoing…" : undo.error ? "Retry undo" : "Undo"}
                </Button>
              </div>
            </motion.div>
          )}
        </AnimatePresence>

      <ShortlistTray
        items={shortlist}
        estimate={estimate}
        prepEstimate={prepEstimate}
        batch={prepBatch}
        prep={prep}
        hasCli={hasCli}
        onRemove={(url) => setShortlist((s) => s.filter((x) => x.url !== url))}
        onClear={() => setShortlist([])}
        onScore={scoreShortlist}
        onPrepare={prepareShortlist}
      />
    </div>
  );
}
