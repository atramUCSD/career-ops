import Link from "next/link";
import { pipelineSummary } from "@/lib/career-ops";
import { canonStatus, scoreNum } from "@/lib/format";
import { cumulativeTiles } from "@/lib/funnel-tiles.mjs";
import { barWidths } from "@/lib/chart-geometry.mjs";

export const dynamic = "force-dynamic";

const STAGES: { key: string; label: string }[] = [
  { key: "EVALUATED", label: "Evaluated" },
  { key: "APPLIED", label: "Applied" },
  { key: "RESPONDED", label: "Responded" },
  { key: "INTERVIEW", label: "Interview" },
  { key: "OFFER", label: "Offer" },
  { key: "HIRED", label: "Hired" },
  { key: "REJECTED", label: "Rejected" },
  { key: "DISCARDED", label: "Discarded" },
];

export default function Analytics() {
  const { applications } = pipelineSummary();
  const total = applications.length;

  const stageCounts = STAGES.map((s) => ({
    ...s,
    n: applications.filter((a) => canonStatus(a.status).includes(s.key)).length,
  }));
  const stageN = (key: string) => stageCounts.find((s) => s.key === key)?.n ?? 0;

  const scores = applications.map((a) => scoreNum(a.score)).filter((n) => !Number.isNaN(n));
  const avg = scores.length ? scores.reduce((a, b) => a + b, 0) / scores.length : 0;
  const buckets = [
    { label: "4.5 – 5.0", test: (n: number) => n >= 4.5 },
    { label: "4.0 – 4.4", test: (n: number) => n >= 4 && n < 4.5 },
    { label: "3.0 – 3.9", test: (n: number) => n >= 3 && n < 4 },
    { label: "< 3.0", test: (n: number) => n < 3 },
  ].map((b) => ({ label: b.label, n: scores.filter(b.test).length }));

  const companyCounts = new Map<string, number>();
  for (const a of applications) if (a.company) companyCounts.set(a.company, (companyCounts.get(a.company) ?? 0) + 1);
  const topCompanies = [...companyCounts.entries()].sort((a, b) => b[1] - a[1]).slice(0, 10);
  const held = topCompanies.reduce((a, [, n]) => a + n, 0);

  // CUMULATIVE, unlike the stage bars above: these two tiles are achievement
  // counters whose zero-state shows a coaching nudge, so a candidate who has
  // already advanced past a stage must not read 0 for it (an offer-holder was
  // told "Interviews follow replies — keep follow-ups warm"). Mirrors
  // everInterview/everOffer in stats.mjs's computeFunnel().
  const { interviews, offers } = cumulativeTiles(applications.map((a) => canonStatus(a.status)));

  // One takeaway sentence per chart — the aria-label an assistive-technology
  // user hears instead of the flattened bars, same bar as the artifact charts.
  const stageTakeaway =
    `Of ${total} tracked evaluations, ${stageN("APPLIED")} sit at applied, ` +
    `${stageN("INTERVIEW")} at interview, ${stageN("OFFER")} at offer and ` +
    `${stageN("REJECTED")} were rejected.`;
  const scoreTakeaway = scores.length
    ? `${scores.length} scored evaluations average ${avg.toFixed(2)}; ` +
      `${buckets[0].n + buckets[1].n} score 4.0 or better.`
    : "No scored evaluations yet.";
  const companyTakeaway = topCompanies.length
    ? `The top ${topCompanies.length} of ${companyCounts.size} companies hold ` +
      `${held} of ${total} tracked evaluations.`
    : "No companies tracked yet.";

  return (
    <div className="mx-auto max-w-4xl px-6 py-10">
      <h1 className="font-display text-2xl tracking-tight text-landing">Analytics</h1>
      <p className="mt-1 text-sm text-muted">Across {total} tracked evaluation{total === 1 ? "" : "s"}.</p>

      {/* headline stats */}
      <div className="mt-6 grid grid-cols-2 gap-4 sm:grid-cols-4">
        <Stat value={total} label="evaluated" />
        <Stat value={avg ? avg.toFixed(2) : "—"} label="avg score" />
        <Stat
          value={interviews}
          label="interviews"
          hint={interviews === 0 ? "Interviews follow replies — keep follow-ups warm →" : undefined}
        />
        <Stat
          value={offers}
          label="offers"
          hint={offers === 0 ? "Offers follow interviews — keep the conversations going →" : undefined}
        />
      </div>

      <Section title="Pipeline by stage">
        <BarChart
          items={stageCounts.map((s) => ({ label: s.label, n: s.n, positive: s.key === "OFFER" }))}
          total={total}
          takeaway={stageTakeaway}
        />
      </Section>

      <Section title="Score distribution">
        <BarChart items={buckets} total={scores.length} takeaway={scoreTakeaway} />
      </Section>

      <Section title="Top companies" id="companies">
        <BarChart items={topCompanies.map(([label, n]) => ({ label, n }))} takeaway={companyTakeaway} />
      </Section>
    </div>
  );
}

function Stat({ value, label, hint }: { value: number | string; label: string; hint?: string }) {
  return (
    <div className="rounded-2xl border border-border bg-surface/50 p-4">
      <div className="text-3xl font-semibold tabular-nums">{value}</div>
      <div className="mt-1 text-xs text-faint">{label}</div>
      {hint && (
        <Link href="/" className="mt-2 block text-xs text-muted transition-colors hover:text-brand">
          {hint}
        </Link>
      )}
    </div>
  );
}

function Section({ title, children, id }: { title: string; children: React.ReactNode; id?: string }) {
  return (
    <section id={id} className="mt-10 scroll-mt-8">
      <h2 className="text-xs font-semibold uppercase tracking-[0.2em] text-muted">{title}</h2>
      <div className="mt-4 space-y-2.5">{children}</div>
    </section>
  );
}

/**
 * One horizontal bar chart, server-rendered. Widths come from the shared
 * geometry module (the same code path as the artifact's SVG charts) with a
 * 4% floor so a small non-zero count stays visible; n = 0 renders an empty
 * track. Labels and counts stay real text; the SVG marks are aria-hidden and
 * the chart speaks through its takeaway aria-label.
 */
function BarChart({
  items,
  takeaway,
  total,
}: {
  items: { label: string; n: number; positive?: boolean }[];
  takeaway: string;
  total?: number;
}) {
  const widths = barWidths(items.map((i) => i.n), 100, 4);
  return (
    <div role="img" aria-label={takeaway} className="space-y-2.5">
      {items.map((it, i) => (
        <div key={it.label} className="flex items-center gap-3">
          <div className="w-32 shrink-0 truncate text-sm text-muted">{it.label}</div>
          <svg className="h-7 flex-1" aria-hidden="true">
            <rect width="100%" height="100%" rx="6" className="fill-surface" />
            {widths[i] > 0 && (
              <rect
                width={`${widths[i]}%`}
                height="100%"
                rx="6"
                className={it.positive ? "fill-emerald-500/50" : "fill-foreground/20"}
              />
            )}
          </svg>
          <div className="w-20 shrink-0 text-right text-sm tabular-nums">
            {it.n}
            {total !== undefined && total > 0 && (
              <span className="ml-1 text-xs text-faint">{Math.round((it.n / total) * 100)}%</span>
            )}
          </div>
        </div>
      ))}
    </div>
  );
}
