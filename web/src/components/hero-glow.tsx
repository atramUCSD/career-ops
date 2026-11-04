"use client";

import dynamic from "next/dynamic";
import { useEffect, useState } from "react";
import { cn } from "@/lib/cn";

// The career-ops-docs home signature: an animated grain-gradient glow. Deferred
// to browser idle, skipped on reduced-motion, ssr:false → zero LCP cost. Renders
// grain in the corners (transparent center) so the dot-grid shows through.
const GrainGradient = dynamic(
  () => import("@paper-design/shaders-react").then((m) => m.GrainGradient),
  { ssr: false },
);

// Static stand-in in the shader's "corners" shape: server-rendered, shown until
// the shader mounts, and the only glow under reduced motion. --glow is the
// shader's base green (#00ED64) at roughly its intensity per theme.
const CORNERS = ["0% 0%", "100% 0%", "0% 100%", "100% 100%"]
  .map((at) => `radial-gradient(55% 60% at ${at}, var(--glow), transparent)`)
  .join(", ");

// Page-wide version of the static corners, fixed behind everything at -z-10 so
// the glass nav has something to blur. Body's background sits on the canvas,
// below negative z-index layers, so this paints above it and under the page.
export function AmbientGlow() {
  return (
    <div
      aria-hidden
      style={{ backgroundImage: CORNERS }}
      className="pointer-events-none fixed inset-0 -z-10 [--glow:color-mix(in_srgb,#00ED64_8%,transparent)] dark:[--glow:color-mix(in_srgb,#00ED64_12%,transparent)]"
    />
  );
}

// settle: run the shader for a few seconds, then hold the frame (speed 0 stops
// its rAF loop), so an idle page draws nothing and glass over it stops re-blurring.
const SETTLE_MS = 4000;

export function HeroGlow({ settle = false }: { settle?: boolean }) {
  const [show, setShow] = useState(false);
  const [dark, setDark] = useState(true);
  const [settled, setSettled] = useState(false);

  useEffect(() => {
    if (!settle || !show) return;
    const t = setTimeout(() => setSettled(true), SETTLE_MS);
    return () => clearTimeout(t);
  }, [settle, show]);

  useEffect(() => {
    if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) return;

    const readTheme = () => setDark(document.documentElement.classList.contains("dark"));
    readTheme();
    window.addEventListener("themechange", readTheme);

    const w = window as Window & {
      requestIdleCallback?: (cb: () => void, o?: { timeout?: number }) => number;
    };
    let timer: ReturnType<typeof setTimeout> | undefined;
    if (typeof w.requestIdleCallback === "function") {
      w.requestIdleCallback(() => setShow(true), { timeout: 2000 });
    } else {
      timer = setTimeout(() => setShow(true), 400);
    }

    return () => {
      window.removeEventListener("themechange", readTheme);
      if (timer) clearTimeout(timer);
    };
  }, []);

  return (
    <>
      {/* Crossfades out on the same 700ms / 200ms-delay curve the shader fades in on. */}
      <div
        aria-hidden
        style={{ backgroundImage: CORNERS }}
        className={cn(
          "pointer-events-none absolute inset-0 z-0 [--glow:color-mix(in_srgb,#00ED64_16%,transparent)] transition-opacity delay-200 duration-700 dark:[--glow:color-mix(in_srgb,#00ED64_24%,transparent)]",
          show && "opacity-0",
        )}
      />
      {show && (
        <GrainGradient
          className="absolute inset-0 z-0 animate-fade-in-delayed"
          colors={dark ? ["#00ED64", "#00684A", "#02343000"] : ["#71F6BA", "#00ED64", "#00ED6400"]}
          colorBack="#00000000"
          softness={1}
          intensity={dark ? 0.42 : 0.26}
          noise={0.32}
          speed={settled ? 0 : 0.45}
          shape="corners"
          minPixelRatio={1}
          maxPixelCount={1920 * 1080}
        />
      )}
    </>
  );
}
