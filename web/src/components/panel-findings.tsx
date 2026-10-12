import { AlertTriangle } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Steps } from "@/components/ui/charts";
import type { PanelDefect, PanelRun } from "@/lib/core/hiring-panel";

// No hooks and no "use client": the review queue renders this on the client,
// /cv on the server. Every string from a run is reader output derived from an
// untrusted JD, so it renders as plain React text, never as markdown.

const SHOWN = 10;

const DISPOSITION_TONE: Record<PanelDefect["disposition"], "good" | "warn" | "muted"> = {
  fix: "good",
  "needs-user": "warn",
  wontfix: "muted",
  pending: "muted",
};

export function PanelFindings({ run }: { run: PanelRun }) {
  const { meta, ats, defects } = run;
  const source = meta?.source.split(/[\\/]/).pop();
  const missing = (n: number | null) => (n && meta?.mustHaves ? ` (${n} of ${meta.mustHaves} must-haves missing)` : "");
  return (
    <div>
      <div className="mb-3 flex flex-wrap items-baseline gap-x-2 gap-y-1">
        <h2 className="eyebrow text-2xs font-semibold text-muted">Hiring panel</h2>
        <span className="text-xs text-faint">
          Ran {run.date ?? "on an unknown date"}
          {source && ` on ${source}`}
          {meta?.isolated && ", 7 isolated readers"}
        </span>
      </div>

      {meta && !meta.isolated && <Warning>Ran inline, not isolated: the agreement counts are not independent.</Warning>}
      {run.sourceChanged && <Warning>{source} changed after this run, so these findings describe an earlier version.</Warning>}
      {run.problems.slice(0, 3).map((p, i) => (
        <Warning key={i} bad>
          {p}
        </Warning>
      ))}
      {run.problems.length > 3 && <Warning bad>{run.problems.length - 3} more problems in output/.hiring-panel/{run.dir}.</Warning>}

      {run.verdicts.length > 0 && (
        <div className="mb-2 flex flex-wrap gap-1.5">
          {run.verdicts.map((v) => (
            <Badge key={v.id} tone={v.good ? "good" : "bad"}>
              {v.short} {v.verdict}
            </Badge>
          ))}
        </div>
      )}
      {ats.before && (
        <p className="mb-4 text-xs text-muted">
          ATS screen: {ats.before}
          {missing(ats.missingBefore)} before, {ats.after ? `${ats.after}${missing(ats.missingAfter)} after` : "not rerun yet"}.
        </p>
      )}

      {defects === null ? (
        <p className="text-sm text-muted">Panel still running or unmerged: no defect list yet.</p>
      ) : defects.length === 0 ? (
        <p className="text-sm text-muted">The panel raised no defects.</p>
      ) : (
        <>
          <ul className="space-y-3">
            {defects.slice(0, SHOWN).map((d) => (
              <li key={d.n} className="grid grid-cols-[2.5rem_1fr] gap-x-3 gap-y-1.5 text-sm sm:grid-cols-[2.5rem_1fr_auto]">
                <span className="mt-0.5 text-xs text-muted tabular-nums">{d.line}</span>
                <div className="min-w-0">
                  <div className="flex flex-wrap items-start gap-x-2 gap-y-1">
                    <Badge>{d.category}</Badge>
                    {d.split && <Badge tone="info">split</Badge>}
                    <span className="min-w-0 flex-1 basis-48">{d.problem}</span>
                  </div>
                  <p className="mt-1 text-xs text-faint">
                    {d.split ? "Fixes" : "Fix"}: {d.fix}
                  </p>
                  {d.note && (
                    <p className={d.disposition === "needs-user" ? "mt-1 text-xs text-warn" : "mt-1 text-xs text-muted"}>
                      {d.disposition === "needs-user" ? "Ask" : "Reason"}: {d.note}
                    </p>
                  )}
                </div>
                <div className="flex items-center gap-2 max-sm:col-start-2 sm:flex-col sm:items-end sm:gap-1.5">
                  <div className="flex items-center gap-1.5" title={`Raised by readers ${d.readers.join(", ")}`}>
                    <Steps done={d.k} total={7} className="w-20" />
                    <span className="text-xs text-muted tabular-nums">{d.k}/7</span>
                  </div>
                  <Badge tone={DISPOSITION_TONE[d.disposition]}>{d.disposition}</Badge>
                </div>
              </li>
            ))}
          </ul>
          {defects.length > SHOWN && (
            <p className="mt-3 text-xs text-faint">
              {defects.length - SHOWN} more in output/.hiring-panel/{run.dir}/08-defects.md
            </p>
          )}
        </>
      )}
    </div>
  );
}

function Warning({ bad, children }: { bad?: boolean; children: React.ReactNode }) {
  return (
    <p className={bad ? "mb-2 flex items-start gap-1.5 text-xs text-bad-text" : "mb-2 flex items-start gap-1.5 text-xs text-warn"}>
      <AlertTriangle aria-hidden className="mt-0.5 size-3 shrink-0" />
      <span className="min-w-0">{children}</span>
    </p>
  );
}
