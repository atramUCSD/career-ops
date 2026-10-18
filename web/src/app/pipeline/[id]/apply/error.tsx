"use client";

export default function ApplyError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  return (
    <div className="mx-auto max-w-3xl px-4 py-6 sm:px-6 sm:py-8">
      <p className="text-sm text-bad-text">Could not load this apply checklist.</p>
      <p className="mt-2 text-sm text-muted">{error.message || "The report or related files could not be read."}</p>
      <button
        type="button"
        className="mt-4 rounded-md border border-border px-3 py-1.5 text-sm"
        onClick={() => reset()}
      >
        Try again
      </button>
    </div>
  );
}
