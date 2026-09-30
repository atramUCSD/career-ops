import type { LucideIcon } from "lucide-react";
import { cn } from "@/lib/cn";

// The one surface primitive. The opt-in corner is the docs home signature: a
// brand gradient that lights the 1px edge via bg-origin-border, which is why
// there is no overflow-hidden (it would also clip focus outlines).
const CORNERS = {
  br: "bg-linear-to-br",
  bl: "bg-linear-to-bl",
  tr: "bg-linear-to-tr",
} as const;

type Tone = "neutral" | "good" | "warn" | "bad" | "info";

const TONES: Record<Tone, string> = {
  neutral: "border-border bg-surface",
  good: "border-good/30 bg-good-soft",
  warn: "border-warn/30 bg-warn-soft",
  bad: "border-bad/30 bg-bad-soft",
  info: "border-info/30 bg-info-soft",
};

const ICON_TONES: Record<Tone, string> = {
  neutral: "text-brand",
  good: "text-brand-text",
  warn: "text-warn",
  bad: "text-bad-text",
  info: "text-info-text",
};

export function Card({
  as,
  icon: Icon,
  title,
  hint,
  aside,
  inset = false,
  tone = "neutral",
  interactive = false,
  elevated = false,
  corner,
  className,
  children,
  ...props
}: React.HTMLAttributes<HTMLElement> & {
  as?: "div" | "section" | "article";
  icon?: LucideIcon;
  title?: React.ReactNode;
  hint?: React.ReactNode;
  aside?: React.ReactNode;
  inset?: boolean;
  tone?: Tone;
  interactive?: boolean;
  elevated?: boolean;
  corner?: keyof typeof CORNERS;
}) {
  const Tag = as ?? (title ? "section" : "div");
  return (
    <Tag
      className={cn(
        "relative border",
        inset ? "rounded-xl p-4" : "rounded-2xl p-5",
        TONES[tone],
        corner && [CORNERS[corner], "from-brand/10 via-transparent to-transparent bg-origin-border"],
        elevated && "shadow-raised",
        interactive &&
          "focus-ring transition-[color,background-color,border-color,scale] duration-150 ease-out hover:border-brand/40 motion-safe:active:scale-99",
        className,
      )}
      {...props}
    >
      {title && (
        <div className="mb-4 flex flex-wrap items-center gap-x-2 gap-y-1">
          {Icon && <Icon aria-hidden className={cn("size-4 shrink-0", ICON_TONES[tone])} />}
          <h2 className="eyebrow text-sm font-semibold text-foreground">{title}</h2>
          {hint && <span className={cn("text-xs", tone === "neutral" ? "text-faint" : "text-muted")}>{hint}</span>}
          {aside && <div className="ml-auto flex items-center gap-2">{aside}</div>}
        </div>
      )}
      {children}
    </Tag>
  );
}
