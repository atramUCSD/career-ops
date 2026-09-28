import { cn } from "@/lib/cn";

// Score / status pill. No brand tone — brand is reserved for "active/selected"
// (active tab, nav, focus ring), never for a score. Grades route through the
// good/warn/bad scale so the table stays legible.
export function Badge({
  className,
  tone = "muted",
  ...props
}: React.HTMLAttributes<HTMLSpanElement> & {
  tone?: "good" | "warn" | "bad" | "info" | "muted";
}) {
  const tones = {
    good: "bg-good-soft text-brand-text",
    warn: "bg-warn-soft text-warn",
    bad: "bg-bad-soft text-bad-text",
    info: "bg-info-soft text-info-text",
    muted: "bg-surface-hover text-muted",
  } as const;
  return (
    <span
      className={cn(
        "inline-block rounded-md px-1.5 py-0.5 text-xs font-semibold tabular-nums",
        tones[tone],
        className,
      )}
      {...props}
    />
  );
}
