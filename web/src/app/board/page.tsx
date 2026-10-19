import { readApplications, readReport } from "@/lib/career-ops";
import { parseReportMeta } from "@/lib/board-activity.mjs";
import { isSkipDecision } from "@/lib/board-columns.mjs";
import { BoardView } from "@/components/board/board-view";

export const dynamic = "force-dynamic"; // always read fresh local files

export default function BoardPage() {
  const applications = readApplications();
  // The evaluator's "Skip" verdict lives in the report, not the tracker, so it
  // is read here once per load rather than per card on the client.
  const skipped = applications
    .filter((a) => isSkipDecision(parseReportMeta(readReport(a.n)?.content ?? "").summary?.final_decision))
    .map((a) => a.n);
  return <BoardView applications={applications} skipped={skipped} />;
}
