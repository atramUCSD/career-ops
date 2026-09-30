"use client";

import { useEffect, useState } from "react";
import { ArrowUp } from "lucide-react";
import { cn } from "@/lib/cn";
import { Button } from "@/components/ui/button";
import { shouldShowBackToTop, scrollBehaviorFor } from "@/lib/scroll-to-top.mjs";

// Floating control that returns the window to the top of long pages. Rendered
// once from the app shell. The window is the scroll container here (main has no
// own overflow-y), so it listens on window scroll and calls window.scrollTo.
//
// It sits one row above the assistant launcher, which owns bottom-5 right-5, so
// the two never overlap; a lower z-index lets an open assistant panel cover it
// cleanly. When hidden it's also removed from the tab order and hidden from
// assistive tech, so there's nothing to land on until it's actually usable.
export function BackToTop() {
  const [visible, setVisible] = useState(false);

  useEffect(() => {
    const onScroll = () => setVisible(shouldShowBackToTop(window.scrollY));
    onScroll(); // sync once in case we mount already scrolled (restored position)
    window.addEventListener("scroll", onScroll, { passive: true });
    return () => window.removeEventListener("scroll", onScroll);
  }, []);

  const toTop = () => {
    const prefersReducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    window.scrollTo({ top: 0, behavior: scrollBehaviorFor(prefersReducedMotion) });
  };

  return (
    <Button
      type="button"
      variant="secondary"
      size="icon"
      onClick={toTop}
      aria-label="Back to top"
      aria-hidden={!visible}
      tabIndex={visible ? 0 : -1}
      className={cn(
        "fixed bottom-20 right-5 z-40 size-11 bg-surface/90 text-muted shadow-raised backdrop-blur hover:text-foreground",
        // Tailwind 4 translate-* sets the `translate` property, not `transform`.
        "transition-[opacity,translate,color,background-color,border-color,scale] duration-200",
        visible ? "opacity-100 translate-y-0" : "pointer-events-none opacity-0 motion-safe:translate-y-2",
      )}
    >
      <ArrowUp className="size-5" aria-hidden />
    </Button>
  );
}
