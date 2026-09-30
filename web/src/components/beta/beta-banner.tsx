"use client";

import { useEffect, useState } from "react";
import { Bug, ShieldCheck, ThumbsUp, Search } from "lucide-react";
import { Button, buttonVariants } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Dialog } from "@/components/ui/dialog";
import { Textarea } from "@/components/ui/field";
import { collect, fingerprint, issueBody, issueUrl, type Diag } from "@/lib/report/report";
import { searchIssues } from "@/lib/beta/issue-search.mjs";
import "@/lib/report/logbuf"; // install the client error ring-buffer (side-effect)

type SimilarIssue = { number: number; title: string; url: string };
type Meta = { version: string; channel: string; sha: string };

// The shell mounts two faces (sidebar rail from md, floating below it); one request serves both.
let versionReq: Promise<Meta> | null = null;

// Dupe-deflection at write (the maintainer's #1 triage cost): search open
// issues client-side via GitHub's public search API — no key, no server of
// ours. The search itself lives in lib/beta/issue-search.mjs, which returns
// null when it could NOT run rather than folding that into an empty array —
// see that file for the two days of silent false negatives that cost us.
const REPO = "career-ops-hq/career-ops";
const findSimilar = (q: string) => searchIssues(q, REPO, fetch);

// Beta/RC differentiator: a small version+channel pill (only on a pre-release
// channel) + a one-click "Report a bug" that opens a PRE-FILLED GitHub issue. No
// telemetry to any server (local-first / firewall) — the user reviews the exact,
// PII-scrubbed payload (preview-then-confirm) and clicks to open the issue himself.
export function BetaBanner({ rail = false }: { rail?: boolean }) {
  const [meta, setMeta] = useState<Meta | null>(null);
  const [open, setOpen] = useState(false);
  const [desc, setDesc] = useState("");
  const [diag, setDiag] = useState<Diag | null>(null);
  const [similar, setSimilar] = useState<SimilarIssue[]>([]);
  const [searching, setSearching] = useState(false);
  // Distinct from "similar is empty": one means we looked and found nothing,
  // the other means we could not look. Merging them is the bug this fixes.
  const [searchFailed, setSearchFailed] = useState(false);

  // Text search is behind an EXPLICIT click, never as-you-type: the user's
  // words (which can name a company) must not reach api.github.com at keystroke
  // time — that would break the banner's "nothing is sent until you click"
  // pledge, and scrub() is a path/secret scrubber, not a free-text one, so it
  // could not remove the company name anyway. The click IS the consent.
  const checkExisting = async () => {
    const words = desc.trim().split(/\s+/).slice(0, 6).join(" ");
    if (!words) return;
    setSearching(true);
    setSearchFailed(false);
    const found = await findSimilar(`label:web-alpha ${words}`);
    setSearching(false);
    // The user ASKED this question, so the user gets an answer — including
    // "I could not check". Returning the button to its resting state on a
    // failed search made it look like a successful search that found nothing.
    if (found === null) {
      setSearchFailed(true);
      return;
    }
    if (found.length) setSimilar(found);
  };

  useEffect(() => {
    (versionReq ??= fetch("/api/version").then((r) => r.json()))
      .then((d) => {
        if (d?.channel && d.channel !== "stable") setMeta(d);
      })
      .catch(() => {});
  }, []);

  const openReport = async () => {
    const d = await collect();
    setDiag(d);
    setOpen(true);
    // One exact-match search by fingerprint: same bug already filed → the
    // strongest dedupe signal, shown before the user types a word.
    // Fired without the user asking, so a failure here stays silent: an error
    // about a question nobody asked is noise. The explicit "check existing"
    // button below is where a failure has to be visible.
    findSimilar(`in:body "${fingerprint(d)}"`).then((found) => {
      if (found?.length) setSimilar(found);
    });
  };

  if (!meta) return null;

  return (
    <>
      {rail ? (
        // From md this sits in flow in the sidebar footer, so it never floats over the rail or the page.
        <div className="space-y-1.5 border-t border-border pt-3">
          <p className="flex items-center gap-1.5 px-1 text-xs font-medium text-brand-text">
            <span aria-hidden className="size-1.5 rounded-full bg-brand motion-safe:animate-pulse" />
            {meta.version} · {meta.channel}
          </p>
          <Button variant="soft" size="sm" onClick={openReport} className="w-full">
            <Bug aria-hidden className="size-3" /> Report a bug
          </Button>
        </div>
      ) : (
        <>
          {/* bottom-5 left-5 mirrors Ask's bottom-5 right-5; z-40 keeps it under the mobile drawer (z-60) and dialogs. The sidebar has no room for it below md, where the aside is hidden. */}
          {/* h-10 matches Ask's 40px. Under sm the button alone is the face (44px, like Ask): the full pill collides with Ask on one row, and the version still reaches the report via the Dialog title and issue body. */}
          <div className="fixed bottom-5 left-5 z-40 flex h-10 items-center gap-2 rounded-md border border-brand/30 bg-surface/90 px-3 text-xs shadow-raised backdrop-blur-md max-sm:h-auto max-sm:border-0 max-sm:bg-transparent max-sm:p-0 max-sm:shadow-none max-sm:backdrop-blur-none md:hidden">
            <span className="flex items-center gap-1.5 font-medium text-brand-text max-sm:hidden">
              <span aria-hidden className="size-1.5 rounded-full bg-brand motion-safe:animate-pulse" />{" "}
              <span>
                {meta.version} · {meta.channel}
              </span>
            </span>
            {meta.sha && <span className="hidden font-mono text-faint sm:inline">{meta.sha}</span>}
            <Button variant="soft" size="sm" onClick={openReport} className="ml-1 max-sm:ml-0">
              <Bug aria-hidden className="size-3" /> Report a bug
            </Button>
          </div>
        </>
      )}

      {diag && (
        <Dialog
          open={open}
          onClose={() => setOpen(false)}
          size="lg"
          title={
            <span className="flex items-center gap-2">
              <Bug aria-hidden className="size-4 text-brand-text" /> Report a bug · {diag.channel}
            </span>
          }
          footer={
            <>
              <Button variant="ghost" onClick={() => setOpen(false)}>
                Cancel
              </Button>
              <a
                href={issueUrl(diag, desc)}
                target="_blank"
                rel="noreferrer"
                onClick={() => setOpen(false)}
                className={buttonVariants()}
              >
                <Bug aria-hidden className="size-4" /> Open GitHub issue
              </a>
            </>
          }
        >
          <Textarea
            value={desc}
            onChange={(e) => setDesc(e.target.value)}
            rows={4}
            data-autofocus
            aria-label="What went wrong"
            placeholder="What were you doing, and what went wrong?"
            className="resize-none"
          />
          {desc.trim().split(/\s+/).length >= 3 && (
            <Button variant="ghost" size="sm" onClick={checkExisting} loading={searching} className="mt-2 text-muted">
              {!searching && <Search aria-hidden className="size-3" />} Check for existing reports first
            </Button>
          )}
          {searchFailed && (
            // Says what to DO, not just what broke: the whole point of the
            // check is to spare a duplicate, and if we cannot run it the
            // right move is to file anyway rather than to stall.
            <p className="mt-2 text-xs text-muted">
              Couldn&apos;t reach GitHub to check — file it anyway, a duplicate is cheaper than a lost report.
            </p>
          )}
          <details className="mt-3 rounded-xl border border-border bg-surface/40">
            <summary className="cursor-pointer rounded-xl px-3 py-2 text-xs font-medium text-muted select-none focus-ring">
              Exactly what gets attached — review before sending ↓
            </summary>
            <pre className="max-h-52 overflow-auto border-t border-border px-3 py-2 font-mono text-2xs leading-relaxed whitespace-pre-wrap text-muted">
              {issueBody(diag, desc)}
            </pre>
          </details>
          {similar.length > 0 && (
            <Card tone="warn" inset className="mt-3">
              <p className="text-xs font-medium text-warn">Already reported? A 👍 on an existing issue beats a duplicate:</p>
              <ul className="mt-1.5 space-y-1">
                {similar.map((s) => (
                  <li key={s.number}>
                    <a
                      href={s.url}
                      target="_blank"
                      rel="noreferrer"
                      className="inline-flex items-center gap-1.5 rounded-md text-xs text-foreground underline-offset-2 focus-ring transition-colors duration-150 ease-out hover:text-brand-text hover:underline"
                    >
                      <ThumbsUp aria-hidden className="size-3 shrink-0 text-warn" />
                      <span className="font-mono">#{s.number}</span> {s.title.slice(0, 60)}
                    </a>
                  </li>
                ))}
              </ul>
            </Card>
          )}
          <p className="mt-2 flex items-start gap-1.5 text-2xs text-faint">
            <ShieldCheck aria-hidden className="mt-px size-3.5 shrink-0 text-brand-text" /> Opens a GitHub issue you confirm — nothing is sent until you click. NEVER includes your CV, profile, application answers, or job URLs.
          </p>
        </Dialog>
      )}
    </>
  );
}
