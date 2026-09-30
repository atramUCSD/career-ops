// Shared motion vocabulary (DESIGN.md section 7). Transform and opacity only,
// no springs. The shell's <MotionConfig reducedMotion="user"> makes the
// transforms instant for reduced-motion viewers.

export const EASE_OUT = [0.22, 1, 0.36, 1] as const;
export const EASE_IN_OUT = [0.65, 0, 0.35, 1] as const;
export const DURATION = { fast: 0.15, base: 0.2, slow: 0.3, data: 0.6 } as const;

/** Blocks inside <AnimatePresence initial={false} mode="popLayout">. */
export const listItem = {
  initial: { opacity: 0, y: 4 },
  animate: { opacity: 1, y: 0 },
  exit: { opacity: 0, y: -4 },
  transition: { duration: DURATION.base, ease: EASE_OUT },
} as const;

/** Table rows (motion.tr) in default sync mode: opacity only, a row never slides. */
export const rowItem = {
  initial: { opacity: 0 },
  animate: { opacity: 1 },
  exit: { opacity: 0 },
  transition: { duration: DURATION.base, ease: EASE_OUT },
} as const;

/** Reorder: pair with layout="position", e.g. transition={{ ...listItem.transition, layout: layoutMove }}. */
export const layoutMove = { duration: DURATION.slow, ease: EASE_IN_OUT } as const;
