import { cva, type VariantProps } from "class-variance-authority";
import { Loader2 } from "lucide-react";
import { cn } from "@/lib/cn";

// buttonVariants stays exported so a <Link> can wear the same classes.
// max-sm:min-h-11 keeps a 44px touch target on every size.
export const buttonVariants = cva(
  "inline-flex items-center justify-center gap-1.5 rounded-md text-sm font-medium whitespace-nowrap focus-ring transition-[color,background-color,border-color,scale] duration-150 ease-out motion-safe:active:scale-98 disabled:pointer-events-none disabled:opacity-50 max-sm:min-h-11",
  {
    variants: {
      variant: {
        primary: "bg-brand text-brand-foreground hover:bg-brand-200",
        secondary: "border border-border bg-surface text-foreground hover:bg-surface-muted",
        ghost: "hover:bg-surface-hover hover:text-foreground",
        soft: "border border-brand/30 bg-brand-soft text-brand-text hover:bg-brand-soft/70",
        warn: "bg-warn text-brand-foreground hover:bg-warn/90",
        danger: "bg-bad-text text-brand-foreground hover:bg-bad-text/90",
        "danger-ghost": "text-muted hover:bg-bad-soft hover:text-bad-text",
      },
      size: {
        sm: "h-7 px-2 text-xs",
        md: "h-9 px-3",
        lg: "h-10 px-4",
        icon: "size-9 max-sm:min-w-11",
        "icon-sm": "size-7 max-sm:min-w-11",
      },
    },
    defaultVariants: { variant: "primary", size: "md" },
  },
);

export type ButtonVariants = VariantProps<typeof buttonVariants>;

export function Button({
  variant,
  size,
  loading = false,
  disabled,
  className,
  children,
  ...props
}: React.ComponentProps<"button"> & ButtonVariants & { loading?: boolean }) {
  return (
    <button
      className={cn(buttonVariants({ variant, size }), className)}
      disabled={disabled || loading}
      aria-busy={loading || undefined}
      {...props}
    >
      {loading && <Loader2 aria-hidden className="size-4 shrink-0 motion-safe:animate-spin" />}
      {children}
    </button>
  );
}
