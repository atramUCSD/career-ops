"use client";

import { useSyncExternalStore } from "react";
import { Moon, Sun } from "lucide-react";
import { cn } from "@/lib/cn";
import { Button } from "@/components/ui/button";

const KEY = "career-ops:theme";

// Up to three of these are mounted at once (sidebar, mobile header, drawer).
// Reading the class on <html> as one external store keeps them in step;
// per-instance state went stale as soon as a sibling was clicked.
const subscribe = (cb: () => void) => {
  window.addEventListener("themechange", cb);
  return () => window.removeEventListener("themechange", cb);
};
const isDark = () => document.documentElement.classList.contains("dark");

function setTheme(dark: boolean) {
  document.documentElement.classList.toggle("dark", dark);
  // keep the browser chrome (Safari status bar / Dynamic Island) tinted to match
  document.querySelector('meta[name="theme-color"]')?.setAttribute("content", dark ? "#001E2B" : "#F9FBFA");
  try {
    localStorage.setItem(KEY, dark ? "dark" : "light");
  } catch {
    /* ignore */
  }
  // let theme-reactive components (shaders, sibling toggles) re-read
  window.dispatchEvent(new Event("themechange"));
}

const OPTIONS = [
  { dark: false, label: "Light", Icon: Sun },
  { dark: true, label: "Dark", Icon: Moon },
] as const;

export function ThemeToggle({ className, labels = true }: { className?: string; labels?: boolean }) {
  // null on the server: THEME_SCRIPT sets the class before paint, where SSR can't see it.
  const dark = useSyncExternalStore(subscribe, isDark, () => null);
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
          onClick={() => setTheme(value)}
          title={`${label} mode`}
          className={cn(
            "flex-1 max-sm:min-w-11",
            // The highlight follows html.dark in CSS, not `dark`: the store is null until
            // hydration, and THEME_SCRIPT has already set the class before first paint.
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
