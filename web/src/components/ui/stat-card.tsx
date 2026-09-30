import Link from "next/link";
import { instrumentSerif } from "@/lib/fonts";
import { cn } from "@/lib/cn";

// Stat tile with the home's resting gradient corner + lit edge + raised shadow. The
// number is serif ONLY when `featured` (≤1 serif number per route); the rest
// use Inter tabular-nums so numerals never form a serif wall.
const CORNERS = {
  br: "bg-linear-to-br",
  bl: "bg-linear-to-bl",
  tr: "bg-linear-to-tr",
} as const;

export function StatCard({
  href,
  icon: Icon,
  value,
  label,
  hint,
  featured = false,
  corner = "br",
}: {
  href: string;
  icon: React.ComponentType<{ className?: string }>;
  value: React.ReactNode;
  label: string;
  hint: string;
  featured?: boolean;
  corner?: keyof typeof CORNERS;
}) {
  return (
    <Link
      href={href}
      className={cn(
        "group relative rounded-2xl border border-border bg-surface/50 bg-origin-border p-5 shadow-raised focus-ring transition-[color,background-color,border-color,scale] duration-150 ease-out motion-safe:active:scale-99",
        CORNERS[corner],
        "from-brand/10 via-transparent to-transparent",
        "hover:border-brand/40 hover:from-brand/20",
      )}
    >
      <Icon className="size-5 text-brand" />
      <div
        className={cn(
          "mt-3 text-4xl leading-none tabular-nums",
          featured ? instrumentSerif.className : "font-semibold",
        )}
      >
        {value}
      </div>
      <div className="mt-2 text-sm text-foreground">{label}</div>
      <div className="text-xs text-muted">{hint}</div>
    </Link>
  );
}
