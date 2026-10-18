import { Skeleton } from "@/components/ui/skeleton";

export default function ReviewLoading() {
  return (
    <div className="mx-auto max-w-3xl px-4 py-6 max-sm:pb-24 sm:px-6 sm:py-8" aria-label="Loading review queue">
      <Skeleton className="h-8 w-28" />
      <Skeleton className="mt-2 h-4 w-96 max-w-full" />
      <div className="mt-6 space-y-3">
        {Array.from({ length: 3 }).map((_, i) => (
          <div key={i} className="rounded-xl border border-border bg-surface/40 p-4">
            <Skeleton className="h-4 w-48" />
            <Skeleton className="mt-3 h-3 w-full" />
            <Skeleton className="mt-2 h-3 w-5/6" />
          </div>
        ))}
      </div>
    </div>
  );
}
