import Link from "next/link";
import { Building2, Gauge, Layers } from "lucide-react";
import { pipelineSummary } from "@/lib/career-ops";
import { canonStatus, scoreNum } from "@/lib/format";
import { cumulativeTiles } from "@/lib/funnel-tiles.mjs";
import { Card } from "@/components/ui/card";
import { BarList, CountUp } from "@/components/ui/charts";

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
    <div className="mx-auto max-w-6xl px-4 py-6 max-sm:pb-24 sm:px-6 sm:py-8">
      <header className="mb-6">
        <h1 className="font-display text-2xl tracking-tight text-landing">Analytics</h1>
        <p className="mt-1 text-sm text-muted">Across {total} tracked evaluation{total === 1 ? "" : "s"}.</p>
      </header>

      <div className="space-y-8">
        <div className="grid grid-cols-2 gap-4 lg:grid-cols-4">
          <Stat value={<CountUp value={total} />} label="evaluated" />
          <Stat value={avg ? avg.toFixed(2) : "—"} label="avg score" />
          <Stat
            value={<CountUp value={interviews} />}
            label="interviews"
            hint={interviews === 0 ? "Interviews follow replies — keep follow-ups warm" : undefined}
          />
          <Stat
            value={<CountUp value={offers} />}
            label="offers"
            hint={offers === 0 ? "Offers follow interviews — keep the conversations going" : undefined}
          />
        </div>

        <Card title="Pipeline by stage" icon={Layers}>
          <BarList
            items={stageCounts.map((s) => ({ label: s.label, value: s.n, tone: s.key === "OFFER" ? "good" : "muted" }))}
            total={total}
            takeaway={stageTakeaway}
          />
        </Card>

        <div className="grid items-start gap-4 lg:grid-cols-2">
          <Card title="Score distribution" icon={Gauge}>
            <BarList
              items={buckets.map((b) => ({ label: b.label, value: b.n }))}
              total={scores.length}
              takeaway={scoreTakeaway}
            />
          </Card>

          <Card title="Top companies" icon={Building2} id="companies" className="scroll-mt-8">
            <BarList
              items={topCompanies.map(([label, n]) => ({ label, value: n }))}
              total={total}
              takeaway={companyTakeaway}
            />
          </Card>
        </div>
      </div>
    </div>
  );
}

function Stat({ value, label, hint }: { value: React.ReactNode; label: string; hint?: string }) {
  // The last word rides with the arrow so the arrow never wraps onto a line alone.
  const cut = hint ? hint.lastIndexOf(" ") + 1 : 0;
  return (
    <Card>
      <div className="text-4xl leading-none font-semibold tabular-nums">{value}</div>
      <div className="mt-2 text-sm text-foreground">{label}</div>
      {hint && (
        <Link href="/" className="mt-2 block rounded-md text-xs text-muted transition-colors duration-150 ease-out hover:text-brand-text focus-ring">
          {hint.slice(0, cut)}
          <span className="whitespace-nowrap">{hint.slice(cut)} →</span>
        </Link>
      )}
    </Card>
  );
}
