"use client";

import { useCallback, useRef, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { Upload, FileText, Loader2, Check, AlertTriangle, Lock, ArrowRight, RotateCcw } from "lucide-react";
import { AnimatePresence, motion } from "motion/react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Textarea } from "@/components/ui/field";
import { listItem } from "@/components/ui/motion";
import { instrumentSerif } from "@/lib/fonts";
import { cvReadiness, parseCvStream, type CvSeed } from "@/lib/cv/quality";
import { DEFAULT_FILTERS, filtersToParams } from "@/lib/explore";

type Phase = "input" | "parsing" | "review" | "saving" | "error";

function cliId(): string | null {
  try {
    return JSON.parse(localStorage.getItem("career-ops:config") || "{}").cliId || null;
  } catch {
    return null;
  }
}

const STYLE = `
.co-cvdrop{position:relative;border:1.5px dashed color-mix(in srgb, var(--fg) 22%, transparent);border-radius:1rem;transition:border-color .2s,background .2s}
.co-cvdrop[data-over="true"]{border-color:var(--brand);background:color-mix(in srgb,var(--brand) 5%,transparent)}
`;

export function CvIngest({ onSaved }: { onSaved?: () => void }) {
  const router = useRouter();
  const [phase, setPhase] = useState<Phase>("input");
  const [paste, setPaste] = useState("");
  const [over, setOver] = useState(false);
  const [trace, setTrace] = useState("");
  const [md, setMd] = useState("");
  const [seed, setSeed] = useState<CvSeed | null>(null);
  const [err, setErr] = useState("");
  const fileRef = useRef<HTMLInputElement>(null);

  const readiness = md ? cvReadiness(md) : null;

  // Stream the ingest, parsing markers live.
  const runStream = useCallback(async (init: RequestInit) => {
    setPhase("parsing");
    setTrace("Reading your CV…");
    setErr("");
    try {
      const r = await fetch("/api/cv/ingest", init);
      if (r.status === 404) {
        setErr("Connect an AI CLI in Config first — it parses your CV locally.");
        setPhase("error");
        return;
      }
      if (!r.body) {
        setErr("No response.");
        setPhase("error");
        return;
      }
      const reader = r.body.getReader();
      const dec = new TextDecoder();
      let buf = "";
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        buf += dec.decode(value, { stream: true });
        const parsed = parseCvStream(buf);
        if (parsed.error) {
          setErr(parsed.error === "unreadable" ? "I couldn't read text from that file (it may be a scanned image). Paste the text instead." : "Couldn't parse the CV — paste the text instead.");
          setPhase("error");
          return;
        }
        if (parsed.trace) setTrace(parsed.trace.split("\n").filter(Boolean).slice(-1)[0] || "Reading your CV…");
        if (parsed.markdown) setMd(parsed.markdown);
        if (parsed.seed) setSeed(parsed.seed);
      }
      const final = parseCvStream(buf);
      if (!final.markdown.trim()) {
        setErr("Couldn't read a CV there — paste the text instead.");
        setPhase("error");
        return;
      }
      setMd(final.markdown);
      setSeed(final.seed);
      setPhase("review");
    } catch (e) {
      setErr(e instanceof Error ? e.message : "stream error");
      setPhase("error");
    }
  }, []);

  const ingestText = (text: string) => {
    const trimmed = text.trim();
    if (!trimmed) {
      setErr("That looks empty — paste your CV instead.");
      setPhase("error");
      return;
    }
    // Pasted text is already readable. Same path as a .md/.txt drop — no CLI.
    // (PDF/DOCX still need a CLI below.)
    const id = cliId();
    if (!id) {
      setSeed(null);
      setMd(trimmed);
      setPhase("review");
      return;
    }
    void runStream({ method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ text: trimmed, cliId: id }) });
  };

  const ingestFile = (file: File) => {
    // .md/.txt/.markdown fast path — plain text, NO CLI needed, instant.
    if (/\.(md|markdown|txt)$/i.test(file.name)) {
      file
        .text()
        .then((t) => {
          if (!t.trim()) {
            setErr("That file looks empty — paste your CV instead.");
            setPhase("error");
            return;
          }
          setSeed(null);
          setMd(t.trim());
          setPhase("review");
        })
        .catch(() => {
          setErr("Couldn't read that file — paste your CV instead.");
          setPhase("error");
        });
      return;
    }
    // PDF/other → the user's CLI parses it. Needs a configured CLI.
    const id = cliId();
    if (!id) {
      setErr("needs-cli");
      setPhase("error");
      return;
    }
    const form = new FormData();
    form.append("file", file);
    form.append("cliId", id);
    void runStream({ method: "POST", body: form });
  };

  const [saveErr, setSaveErr] = useState("");
  const save = async () => {
    if (!md.trim()) {
      setSaveErr("Your CV looks empty — paste it again.");
      return;
    }
    setSaveErr("");
    setPhase("saving");
    try {
      const r = await fetch("/api/cv", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ content: md }) });
      if (!r.ok) {
        const d = await r.json().catch(() => ({}));
        setSaveErr(d.error || "Couldn't save your CV — try again.");
        setPhase("review"); // keep the parsed CV so they don't lose it
        return;
      }
    } catch {
      setSaveErr("Couldn't save your CV — check your connection and try again.");
      setPhase("review");
      return;
    }
    onSaved?.();
    // WOW #1 — land in the Explorer with the CV-derived filters in the URL + run=1,
    // so the Explorer auto-fires the FREE scan itself (robust, no push/replaceState race).
    // GENEROUS first scan so it never comes back empty (that would kill the wow): roles
    // only + a wide 30-day window; location stays a refinement for the deepen step, NOT a
    // hard exclude (allow=[] passes everything). Recall over precision for the first reveal.
    const roles = seed?.roles?.length ? seed.roles : seed?.title ? [seed.title] : [];
    const f = { ...DEFAULT_FILTERS, ats: [...DEFAULT_FILTERS.ats], positive: roles, sinceDays: 30 };
    const qs = filtersToParams(f);
    router.push(`/explore?${qs}${qs ? "&" : ""}run=1`);
  };

  // ── INPUT ──
  if (phase === "input" || phase === "error") {
    return (
      <div className="relative space-y-3">
        <style>{STYLE}</style>
        <div
          className="co-cvdrop p-5 field-focus-within"
          data-over={over}
          onDragOver={(e) => {
            e.preventDefault();
            setOver(true);
          }}
          onDragLeave={() => setOver(false)}
          onDrop={(e) => {
            e.preventDefault();
            setOver(false);
            const f = e.dataTransfer.files?.[0];
            if (f) ingestFile(f);
          }}
        >
          {/* Borderless on purpose: the dashed drop zone is the field edge and carries the focus state. */}
          <textarea
            aria-label="Paste your CV"
            value={paste}
            onChange={(e) => setPaste(e.target.value)}
            onKeyDown={(e) => {
              if ((e.metaKey || e.ctrlKey) && e.key === "Enter" && paste.trim()) ingestText(paste.trim());
            }}
            placeholder="Paste your CV here — or drop a PDF / .md file below. Even a rough paste works; we'll clean it up."
            className="h-32 w-full resize-none bg-transparent text-sm leading-relaxed outline-none placeholder:text-faint"
          />
          <div className="mt-3 flex flex-wrap items-center gap-3 border-t border-border pt-3">
            <Button type="button" variant="secondary" size="sm" onClick={() => fileRef.current?.click()}>
              <Upload aria-hidden className="size-3.5" /> Upload PDF / file
            </Button>
            <input
              ref={fileRef}
              type="file"
              accept=".pdf,.md,.markdown,.txt,.docx"
              hidden
              onChange={(e) => e.target.files?.[0] && ingestFile(e.target.files[0])}
            />
            <span className="inline-flex items-center gap-1 text-2xs text-faint">
              <Lock aria-hidden className="size-3" /> Stays on your machine. Parsed by your own AI.
            </span>
            <Button type="button" disabled={!paste.trim()} onClick={() => ingestText(paste.trim())} className="ml-auto">
              Read my CV <ArrowRight aria-hidden className="size-4" />
            </Button>
          </div>
        </div>
        <AnimatePresence initial={false} mode="popLayout">
          {phase === "error" && (
            <motion.div key={err === "needs-cli" ? "needs-cli" : "err"} role="alert" {...listItem}>
              {err === "needs-cli" ? (
                <Card inset tone="warn" className="flex flex-wrap items-center gap-2 text-sm text-warn">
                  <AlertTriangle aria-hidden className="size-3.5 shrink-0" />
                  <span>To read a PDF or Word file, connect an AI CLI in Config. Paste or drop .md / .txt to start without one.</span>
                  <Link
                    href="/config"
                    className="ml-auto inline-flex items-center gap-1 rounded-md bg-warn/15 px-2 py-0.5 font-medium text-warn transition-colors duration-150 ease-out hover:bg-warn/25 focus-ring max-sm:min-h-11"
                  >
                    Connect your AI CLI <ArrowRight aria-hidden className="size-3.5" />
                  </Link>
                </Card>
              ) : (
                <p className="flex items-center gap-1.5 text-sm text-warn">
                  <AlertTriangle aria-hidden className="size-3.5 shrink-0" /> {err}
                </p>
              )}
            </motion.div>
          )}
        </AnimatePresence>
      </div>
    );
  }

  // ── PARSING (the 10s bridge) ──
  if (phase === "parsing") {
    return (
      <Card role="status" className="bg-surface/60 backdrop-blur-sm">
        <div className="flex items-center gap-2">
          <Loader2 aria-hidden className="size-4 text-brand motion-safe:animate-spin" />
          <span className={`${instrumentSerif.className} text-lg text-foreground`}>{trace || "Reading your CV…"}</span>
        </div>
        <div className="mt-3 inline-flex items-center gap-1.5 rounded-md border border-good/30 bg-good-soft px-2 py-0.5 text-2xs font-semibold text-brand-text">
          <span aria-hidden className="size-1.5 rounded-full bg-good" /> 0 tokens · $0.00 · local
        </div>
        {md && (
          <motion.div
            initial={{ opacity: 0, y: 4 }}
            animate={{ opacity: 1, y: 0 }}
            transition={listItem.transition}
            className="mt-4 max-h-40 overflow-hidden rounded-xl border border-border bg-surface/40 p-3 text-2xs text-faint"
          >
            {md.slice(0, 400)}…
          </motion.div>
        )}
      </Card>
    );
  }

  // ── REVIEW (propose → confirm) ──
  return (
    <Card className="relative bg-surface/60 backdrop-blur-sm">
      <div className="mb-3 flex flex-wrap items-center gap-2">
        <FileText aria-hidden className="size-4 text-brand" />
        <h2 className={`${instrumentSerif.className} text-lg text-foreground`}>Here&apos;s your CV — review and save</h2>
        {readiness && (
          <Badge
            tone={readiness.scoreable ? "good" : "warn"}
            className="ml-auto inline-flex items-center gap-1 text-2xs font-medium"
          >
            {readiness.scoreable ? <Check aria-hidden className="size-3" /> : <AlertTriangle aria-hidden className="size-3" />}
            {readiness.scoreable ? "Ready to match" : "A bit thin"}
          </Badge>
        )}
      </div>
      {readiness?.hint && <p className="mb-2 text-xs text-warn">{readiness.hint}</p>}
      <AnimatePresence initial={false} mode="popLayout">
        {saveErr && (
          <motion.p key="save-err" role="alert" {...listItem} className="mb-2 flex items-center gap-1.5 text-xs text-bad-text">
            <AlertTriangle aria-hidden className="size-3.5 shrink-0" /> {saveErr}
          </motion.p>
        )}
      </AnimatePresence>
      <div className="grid gap-3 md:grid-cols-2">
        {/* Editor pane keeps the preview's inset radius so the pair reads as one split view. */}
        <Textarea
          aria-label="CV markdown"
          mono
          value={md}
          onChange={(e) => setMd(e.target.value)}
          className="h-72 resize-none rounded-xl bg-surface/40 p-3 text-xs leading-relaxed"
        />
        <div
          tabIndex={0}
          role="region"
          aria-label="CV preview"
          className="report-prose h-72 max-w-none overflow-y-auto rounded-xl border border-border bg-surface/40 p-3 text-sm focus-ring"
        >
          <ReactMarkdown remarkPlugins={[remarkGfm]}>{md}</ReactMarkdown>
        </div>
      </div>
      <div className="mt-4 flex flex-wrap items-center gap-3">
        <Button type="button" size="lg" onClick={save} loading={phase === "saving"}>
          {phase !== "saving" && <Check aria-hidden className="size-4" />}
          Save &amp; find my matches
        </Button>
        <Button
          type="button"
          variant="ghost"
          onClick={() => {
            setMd("");
            setSeed(null);
            setPhase("input");
          }}
          className="text-muted"
        >
          <RotateCcw aria-hidden className="size-3.5" /> Start over
        </Button>
        <span className="ml-auto inline-flex items-center gap-1 text-2xs text-faint">
          <Lock aria-hidden className="size-3" /> Saved locally to cv.md
        </span>
      </div>
    </Card>
  );
}
