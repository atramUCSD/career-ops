import { Skeleton } from "@/components/ui/skeleton";
import { BOARD_COLUMNS } from "@/lib/board-columns.mjs";

// Same frame and lane row as BoardView, so the lanes do not jump when it lands.
export default function BoardLoading() {
  return (
    <div className="px-4 py-6 sm:px-6 sm:py-8 max-sm:pb-24" aria-label="Loading board">
      <div className="mb-6">
        <Skeleton className="h-8 w-24" />
        <Skeleton className="mt-2 h-4 w-64 max-w-full" />
      </div>
      <div className="flex h-[calc(100dvh-16rem)] min-h-96 items-stretch gap-3 overflow-x-auto pb-2 max-sm:h-[calc(100dvh-24.5rem)]">
        {BOARD_COLUMNS.map((col) => (
          <div key={col.id} className="flex min-w-48 flex-1 flex-col gap-2 rounded-xl border border-border bg-surface/40 p-3 max-sm:w-[85vw] max-sm:flex-none">
            <Skeleton className="h-4 w-20" />
            {Array.from({ length: 3 }).map((_, i) => (
              <Skeleton key={i} className="h-16 w-full rounded-lg" />
            ))}
          </div>
        ))}
      </div>
    </div>
  );
}
