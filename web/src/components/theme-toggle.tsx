"use client";

import { Moon, Sun } from "lucide-react";
import { cn } from "@/lib/cn";
import { Button } from "@/components/ui/button";
import { useTheme } from "@/components/theme-provider";

const OPTIONS = [
  { dark: false, label: "Light", Icon: Sun },
  { dark: true, label: "Dark", Icon: Moon },
] as const;

export function ThemeToggle({ className, labels = true }: { className?: string; labels?: boolean }) {
  const { theme, setTheme } = useTheme();
  const dark = theme === "dark";
  return (
    <div
      role="group"
      aria-label="Color theme"
      className={cn("inline-flex rounded-md border border-border bg-surface p-0.5", className)}
    >
      {OPTIONS.map(({ dark: value, label, Icon }) => (
        <Button
          key={label}
          variant="ghost"
          size="sm"
          aria-pressed={dark === value}
          onClick={() => setTheme(value ? "dark" : "light")}
          title={`${label} mode`}
          className={cn(
            "flex-1 max-sm:min-w-11",
            // The highlight follows html.dark in CSS, not `dark`: the provider holds its
            // default until hydration, and THEME_SCRIPT has already set the class before paint.
            value
              ? "text-muted dark:bg-brand-soft dark:text-brand-text dark:hover:bg-brand-soft dark:hover:text-brand-text"
              : "bg-brand-soft text-brand-text hover:bg-brand-soft hover:text-brand-text dark:bg-transparent dark:text-muted dark:hover:bg-surface-hover dark:hover:text-foreground",
          )}
        >
          <Icon aria-hidden className="size-3.5" />
          <span className={labels ? undefined : "sr-only"}>{label}</span>
        </Button>
      ))}
    </div>
  );
}
