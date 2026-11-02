"use client";

// The wizard camera (DESIGN.md 7a). One transformed node, the world, with the
// stages at fixed world coordinates. A flight is a WAAPI keyframe array sampled
// from the van Wijk path, so it runs on the compositor, and nothing in React
// commits until it settles: the target is revealed one frame before take-off,
// and inert, glass and focus all change at settle.

import { Activity, createContext, useContext, useEffect, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { durationBucket, samplePath, transformFor, viewFromMatrix } from "@/lib/camera-path.mjs";
import { cn } from "@/lib/cn";
import { DURATION, EASE_IN_OUT, EASE_OUT } from "./motion";

type View = [number, number, number];
type Point = [number, number];

/** Pass as `active` to zoom out to the whole world (review, re-entry). */
export const OVERVIEW = "overview";

const bezier = (e: readonly number[]) => `cubic-bezier(${e.join(", ")})`;

type CameraState = { positions: Record<string, Point>; settled: string; near: (id: string) => boolean };
const CameraContext = createContext<CameraState | null>(null);

export function World({
  positions,
  hop,
  active,
  overviewPad = [900, 700],
  inset = [0, 0, 0, 0],
  onSettle,
  children,
}: {
  /** World coordinates of each stage's centre (radialPositions). */
  positions: Record<string, Point>;
  /** One-hop distance: the ring radius. Sets the mount window and the duration bucket. */
  hop: number;
  /** The stage the route asks for, or OVERVIEW. */
  active: string;
  /** World units added to the stage spread when fitting the overview: the widest and tallest footprint. */
  overviewPad?: Point;
  /** Screen px the fixed chrome covers, [top, right, bottom, left]. Every view centres in the rect inside it. */
  inset?: [number, number, number, number];
  /** After a flight lands and the new stage's h1 has focus: set document.title and the status region here. */
  onSettle?: (id: string) => void;
  children: ReactNode;
}) {
  const viewportRef = useRef<HTMLDivElement>(null);
  const worldRef = useRef<HTMLDivElement>(null);
  const animRef = useRef<Animation | null>(null);
  const flyingTo = useRef<string | null>(null);
  const flown = useRef(false);
  const [settled, setSettled] = useState(active);
  const settledRef = useRef(settled);
  settledRef.current = settled;

  const viewOf = (id: string, vw: number, vh: number): View => {
    const [t, r, b, l] = inset;
    // Scale 1 at rest: the camera scales the world, never the stage, so text is crisp.
    let [cx, cy] = positions[id] ?? [0, 0];
    let k = 1;
    if (id === OVERVIEW) {
      const xs = Object.values(positions).map((p) => p[0]);
      const ys = Object.values(positions).map((p) => p[1]);
      const [minX, maxX, minY, maxY] = [Math.min(...xs), Math.max(...xs), Math.min(...ys), Math.max(...ys)];
      [cx, cy] = [(minX + maxX) / 2, (minY + maxY) / 2];
      k = Math.min((vw - l - r) / (maxX - minX + overviewPad[0]), (vh - t - b) / (maxY - minY + overviewPad[1]));
    }
    // The view's centre is the viewport's; shift it so the target sits mid free rect.
    return [cx - (l - r) / (2 * k), cy - (t - b) / (2 * k), vw / k];
  };

  // Mounted: every stage within one hop of where the camera is or where it is
  // going. The rest keep their state in a hidden Activity.
  const near = (id: string) => {
    if (active === OVERVIEW || settled === OVERVIEW) return true;
    const within = (other: string) =>
      Math.hypot(positions[id][0] - positions[other][0], positions[id][1] - positions[other][1]) <= hop + 1;
    return within(active) || within(settled);
  };

  const size = () => [viewportRef.current!.clientWidth, viewportRef.current!.clientHeight] as const;

  // Initial placement, and re-placement on resize while at rest.
  useLayoutEffect(() => {
    const place = () => {
      if (animRef.current) return;
      const [vw, vh] = size();
      worldRef.current!.style.transform = transformFor(viewOf(settledRef.current, vw, vh), vw, vh);
    };
    place();
    window.addEventListener("resize", place);
    return () => window.removeEventListener("resize", place);
    // viewOf reads positions; a new layout is a new world, not a resize.
  }, [positions]);

  useEffect(() => {
    // Double submit, or a no-op route change: the old stage stays interactive until settle.
    if (active === flyingTo.current || (active === settledRef.current && !animRef.current)) return;
    // This commit un-hid the target; take off on the next frame so its mount never lands mid-flight.
    const raf = requestAnimationFrame(() => fly(active));
    return () => cancelAnimationFrame(raf);
  }, [active]);

  // Unmounted mid-flight: the flag lives on <html> and would outlive the camera.
  useEffect(() => () => {
    delete document.documentElement.dataset.flying;
  }, []);

  function fly(id: string) {
    const world = worldRef.current!;
    const [vw, vh] = size();
    let easing: readonly number[] = EASE_IN_OUT;
    if (animRef.current) {
      // Freeze where the camera is now. finish() would jump to the old target first.
      animRef.current.commitStyles();
      animRef.current.cancel();
      // A moving camera continues at speed; EASE_IN_OUT would stop it dead first.
      easing = EASE_OUT;
    }
    const from = viewFromMatrix(new DOMMatrixReadOnly(getComputedStyle(world).transform), vw, vh) as View;
    const to = viewOf(id, vw, vh);
    flyingTo.current = id;
    flown.current = true;
    // On <html>, not the viewport: the swap has to reach glass chrome outside the world.
    document.documentElement.dataset.flying = "";

    const reduce = matchMedia("(prefers-reduced-motion: reduce)").matches;
    // Reduced motion: a 200ms fade-through with the cut at the midpoint, two
    // keyframes sharing offset 0.5. Opacity on the world makes it a Backdrop
    // Root, which is why data-flying masks the glass first.
    const anim = reduce
      ? world.animate(
          [
            { opacity: 1, transform: transformFor(from, vw, vh) },
            { opacity: 0, transform: transformFor(from, vw, vh), offset: 0.5 },
            { opacity: 0, transform: transformFor(to, vw, vh), offset: 0.5 },
            { opacity: 1, transform: transformFor(to, vw, vh) },
          ],
          { duration: DURATION.base * 1000 },
        )
      : world.animate(
          samplePath(from, to, 12).map((v) => ({ transform: transformFor(v, vw, vh) })),
          { duration: DURATION[durationBucket(from, to, hop)] * 1000, easing: bezier(easing) },
        );
    animRef.current = anim;
    anim.finished.then(
      () => {
        if (animRef.current !== anim) return;
        // Never fill: forwards. A filling animation outranks every later inline write.
        anim.commitStyles();
        anim.cancel();
        world.style.removeProperty("opacity");
        animRef.current = null;
        flyingTo.current = null;
        delete document.documentElement.dataset.flying;
        performance.mark("camera:settle");
        setSettled(id);
      },
      () => {}, // cancelled by an interrupting flight, which owns the camera now
    );
  }

  useLayoutEffect(() => {
    if (!flown.current) return;
    performance.measure("camera:settle-commit", "camera:settle");
    // Inert landed on the old stage in this commit, which sent focus to body if
    // Continue had it. The h1 takes it back before paint.
    worldRef.current!.querySelector<HTMLElement>(`[data-stage="${CSS.escape(settled)}"] h1`)?.focus({ preventScroll: true });
    onSettle?.(settled);
  }, [settled]);

  return (
    <CameraContext.Provider value={{ positions, settled, near }}>
      <div ref={viewportRef} className="fixed inset-0 overflow-clip in-data-flying:pointer-events-none">
        {/* will-change keeps the world on its own layer at rest. Promoted only at
            take-off, it re-rasterised on the GPU thread for the first 250ms of
            every flight and dropped frames on an integrated GPU. */}
        <div ref={worldRef} className="absolute top-0 left-0 origin-top-left will-change-transform">
          {children}
        </div>
      </div>
    </CameraContext.Provider>
  );
}

/**
 * A stage at its world position. Only the settled stage is glass and
 * interactive; the rest are frost and inert. Footprint goes on className.
 */
export function Stage({ id, title, className, children }: { id: string; title: ReactNode; className?: string; children: ReactNode }) {
  const camera = useContext(CameraContext);
  if (!camera) throw new Error("Stage must sit inside World");
  const [x, y] = camera.positions[id];
  const live = camera.settled === id;
  return (
    <Activity mode={camera.near(id) ? "visible" : "hidden"}>
      <section
        data-stage={id}
        inert={!live}
        style={{ left: x, top: y }}
        className={cn("absolute -translate-x-1/2 -translate-y-1/2 rounded-2xl p-6", live ? "glass" : "frost", className)}
      >
        {/* tabIndex -1: the camera moves focus here on landing; it is a reading position, not a control. */}
        <h1 tabIndex={-1} className="font-display text-4xl leading-[1.05] text-landing outline-none md:text-5xl">
          {title}
        </h1>
        {children}
      </section>
    </Activity>
  );
}
