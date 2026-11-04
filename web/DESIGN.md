# career-ops web: design contract

This is the design system for `web/`. It refines the existing look (LeafyGreen-derived palette, Inter and Instrument Serif, dashboard density) rather than redesigning it, and the dark theme leads. Every rule applies by lookup: if a case is not covered, stop and ask the orchestrator instead of improvising. Colors are LeafyGreen (Apache-2.0) hex values, or those values at an alpha through `color-mix` or a Tailwind `/NN` modifier. No new dependencies, icons from `lucide-react` only, and font loading is never touched. **Done means** both greps match nothing outside `components/ui/` and section 9:

```sh
grep -rE "(emerald|amber|red|sky|zinc)-[0-9]|text-\[[0-9.]+px\]|tracking-\[|text-brand/|hover:(brightness|-?translate|shadow)|transition-all|focus(-visible|-within)?:(ring|border)|ring-dashed|drop-shadow|prose-sm" web/src
grep -rE "hsla?\(|rgba?\(" --include=*.tsx web/src
```

## 1. Token map

Replace each raw class with its token. When a raw light class is paired with a raw `dark:` class, both become one token: `text-emerald-700 dark:text-emerald-400` becomes `text-brand-text`. Keep state prefixes (`hover:`, `group-hover:`). Success text and icons use `brand-text`, never `good`; `good` is a fill for bars, dots and segments.

| Raw class (every listed shade and opacity) | Token |
|---|---|
| `text-emerald-400` `-500` `-600` `-700`, `dark:text-emerald-400`; `text-brand/60` `/80` (any alpha on brand text); `text-good` on text or an icon | `text-brand-text` |
| `bg-emerald-400` `-500` `-500/70` / `bg-emerald-500/10` `/12` `/15` / `hover:bg-emerald-500/15` `/20` / `fill-emerald-500/50` | `bg-good` / `bg-good-soft` / `hover:bg-good/20` / `fill-good/50` |
| `border-emerald-400/40`, `border-emerald-500/25` `/30` `/40` on a status callout (on a button or link, use `<Button variant="soft">`) | `border-good/30` |
| `text-amber-200` `-300` `-300/90` `-400` `-500` `-600` `-700` `-800` `-800/90`, every `dark:text-amber-*` | `text-warn` |
| `bg-amber-500` `-500/70` / `bg-amber-500/10` `/15` `/[0.07]` / `bg-amber-500/20` / `hover:bg-amber-500/30` / `hover:bg-amber-600` | `bg-warn` / `bg-warn-soft` / `bg-warn/15` / `hover:bg-warn/25` / `hover:bg-warn/90` |
| `border-amber-400/50`, `border-amber-500/25` `/30` `/40` / `border-amber-500/50` / `border-l-amber-500` | `border-warn/30` / `border-warn/50` / `border-l-warn` |
| `text-red-400` `-500` `-600` `-700`, `dark:text-red-400`, `hover:text-red-500` | `text-bad-text` (`hover:text-bad-text`) |
| `bg-red-400` `-500` `-400/70` (dots, bars) / `bg-red-500/10` `/15` `/[0.06]` / any other solid red fill carrying text | `bg-bad` / `bg-bad-soft` / `bg-bad-text text-brand-foreground` |
| `border-red-400/30`, `border-red-500/30` / `hover:border-red-400/50` / `border-l-red-500` | `border-bad/30` / `hover:border-bad/50` / `border-l-bad` |
| solid `bg-red-500 text-white hover:bg-red-600` / `bg-amber-500 text-white hover:bg-amber-600` button | `<Button variant="danger">` / `variant="warn"` |
| `text-sky-400` / `bg-sky-400` / `border-sky-400/40`; `text-zinc-400` / `bg-zinc-400`, `bg-zinc-500` / `bg-zinc-400/50`, `bg-zinc-600` | `text-info-text` / `bg-info` / `border-info/30`; `text-faint` / `bg-faint` / `bg-faint/50` |
| resting `bg-surface-hover` (badges, chips, tracks, inline code, icon wells; not a Switch track) | `bg-surface-muted`; `hover:bg-surface-hover` stays |
| `bg-black/50`, `bg-black/60` scrims / `text-white` on `bg-brand`, `bg-warn` or `bg-bad-text` | `Dialog` (an unmigrated overlay uses `bg-scrim`) / `text-brand-foreground` |
| `hover:brightness-110` on `bg-brand` / `hover:-translate-y-*`, `hover:shadow-*`, `shadow-brand/*`, `hover:shadow-brand/*` | `hover:bg-brand-200` or `<Button>` / delete; hover elevation is `hover:border-brand/40` |
| bare `transition`, `transition-all` / `focus-within:shadow-*` with `focus-within:border-brand/50` | `transition-colors` (`-opacity` or `-transform` if that is what animates) / `field-focus-within` |
| `ring-black/5 dark:ring-white/10` / `shadow-black/10` / `prose prose-sm dark:prose-invert` / `drop-shadow-sm` / `ring-1 ring-warn/40 ring-dashed` / `bg-[var(--bg)]` | `ring-border` / delete the color modifier (the size class maps by section 5) / `report-prose` / delete / `border border-dashed border-warn/40` / `bg-background` |

**Text on tinted fills.** Text on `bg-surface-muted` and inside a tone Card or any `-soft` fill uses `text-foreground` or `text-muted`, never `text-faint` (dark faint is 4.34 to 4.50 on those). Other `bg-white` and `text-white` uses are allowed only as listed in section 9. **Deletable `dark:` overrides (48):** all 45 palette ones (`dark:text-emerald-400` x16, `dark:text-amber-400` x16, `dark:text-red-400` x7, `dark:text-amber-300` x4, `dark:text-amber-300/90`, `dark:text-amber-200`), `dark:ring-white/10`, `dark:prose-invert`, and the CSS rule `html.dark .co-ledger` in discovering-state. Only `dark:bg-background/45` (x2, the hero veil) stays.

**Inline `<style>` strings.** The same map applies to raw CSS, plus:

| Inline CSS | Replacement |
|---|---|
| `hsl(160 64% 46% / .1)` and other palette hsl/rgb / apply-backdrop halos `hsl(220 90% 72% / a)`, `hsl(30 82% 72% / a)`, `hsl(0 0% 100% / a)` | `color-mix(in srgb, var(--good) 10%, transparent)`, same token and alpha / `color-mix(in srgb, X a%, transparent)` with X = `var(--info)`, `#FFC010`, `#FFFFFF`, keeping each alpha |
| `var(--border, X)`, `var(--faint, X)` (token defined) / `var(--co-border, X)`, `var(--co-faint, X)` (never defined: X renders today) | drop `, X` / `var(--border)`, `var(--faint)` |
| `font-size` `12.5px` to `14px` / `9px` to `11px`; radius `.8rem`, `.7rem` / `.6rem`, `.5rem`, `.3rem` / `1.1rem`, `1.3rem` | `.875rem` / `var(--text-2xs)` (`16px` on the ai-search-box textarea stays: it stops iOS zoom); `.75rem` / `.375rem` / `1rem` (`1rem` stays; `2px` stays on 3px bars) |
| `box-shadow` colors (drawer `rgba(0,0,0,.4)`, first-score card) / scrims `rgba(8,8,12,.45)`, `.co-aha` `rgba(0,0,0,.5)` | section 5 geometry with `var(--shadow-tint)` / `var(--shadow-deep)` / `var(--scrim)` |
| `transition: width` on `.co-src__bar` / pulsing `box-shadow` keyframes (`co-orb`, `co-reason-pulse`, apply-view) | `transform: scaleX(p)`, `transform-origin: left` / a `::after` ring animating `scale` and `opacity` |
| `.co-aibox:focus-within` box-shadow and its transition / drawer or dialog timing (`.34s cubic-bezier(...)`) | the `field-focus-within` declarations, no transition / `.3s var(--ease-in-out)` |

## 2. Token value changes (globals.css)

| Token | Theme | Old | New | Reason |
|---|---|---|---|---|
| `--surface-hover` | light | `#E8EDEB` | `color-mix(in srgb, #001E2B 4%, transparent)` | It equalled `--border`. Reads as about `#F5F6F7` on surface, `#EFF1F1` on bg. |
| `--surface-hover` | dark | `#1C2D38` | `color-mix(in srgb, #E8EDEB 3%, transparent)` | Same visibility (1.08:1 on surface); faint meta on a hovered row now clears 4.5. |
| `--surface-muted` (new) | light / dark | none | `#E8EDEB` / `#1C2D38` | Resting neutral fill that borrowed `--surface-hover`. Map `--color-surface-muted`; `.report-prose code` switches to it. |
| `--control-border` (new) | both | none | `#889397` | Form-control edge at 3:1 or better (WCAG 1.4.11): Input, Select, Textarea, custom checkboxes, unchecked Switch track. Cards, rows, dividers keep `--border`. Map `--color-control-border`. |
| `--scrim`; `--shadow-tint`, `--shadow-deep` (new) | light / dark | none | `#001E2B` at 50% / 70%; at 8% and 20% / 50% and 80%, via `color-mix` | Dialog `::backdrop` and drawer (map `--color-scrim`); the two shadows in section 5. |
| `.co-cost[data-size="xs"]` | both | `10.5px` | `var(--text-2xs)` | Joins the type scale. |

Foundation confirms once in the compiled CSS that `shadow-raised` keeps its `var()` colors and that `--text-2xs`, `--ease-out` and `--ease-in-out` exist on `:root` (inline `<style>` strings reference them; use `@theme static` if they are pruned).

## 3. Type scale

Add `--text-2xs: 0.6875rem; --text-2xs--line-height: 1rem;` to `@theme`; the other steps are Tailwind's defaults. Today's 10px and 11px chips inherit the parent's 20px line-height, so they get about 4px shorter: intended tightening, checked in the screenshots. Map: `text-[9px]` `[10px]` `[11px]` → `text-2xs` (micro labels, eyebrows, tiny chips, sidebar meta); `text-[13px]` `[13.5px]` `[14px]` → `text-sm` (body, rows, chips, controls); `text-[12px]` → `text-xs` (captions, badges); `[15px]` → `text-base` (lead paragraphs, mobile nav); `[17px]` → `text-lg` (serif card titles); `[19px]` → `text-xl` (serif pull quotes). An explicit `leading-*` already on the element stays. Page title: `font-display text-2xl tracking-tight text-landing` (the one `text-3xl` h1 joins it). Hero (Today, first run and the setup wizard's stage titles only): `font-display text-4xl md:text-5xl leading-[1.05] text-landing`. Section heading outside a Card: `eyebrow text-xs font-semibold text-muted`. Card `title` prop: `eyebrow text-sm font-semibold text-foreground` (today's Home Panel look); a card heading that is not uppercase today stays in children as `text-sm font-semibold text-foreground`, or `font-display text-lg` on display cards. A status color on a heading (`text-bad-text`, `text-warn`) is kept. `text-4xl` and `text-5xl` serve only the hero and stat numbers.

## 4. Eyebrow

One utility replaces `tracking-[0.14em]`, `[0.16em]`, `[0.18em]`, `[0.2em]` and any `uppercase tracking-wide` chip. Size, weight and color stay separate classes: `uppercase tracking-[0.18em]` becomes `eyebrow`; a compact label is `eyebrow text-2xs font-semibold text-muted`. CSS: `@utility eyebrow { text-transform: uppercase; letter-spacing: 0.16em; }`

## 5. Radius and shadow

Three levels. **Control** `rounded-md` (6px): Button, Input, Select, Textarea, Badge, chips, nav and menu items, inline code, logo tiles up to `size-8`. **Inset** `rounded-xl` (12px): nested cards, callouts, alerts, list and table containers, popovers, menus, toasts, thumbnails. **Surface** `rounded-2xl` (16px): top-level Card, Dialog, drawer, hero. `rounded` becomes `rounded-md`; `rounded-lg` becomes `rounded-md` on a `button`, `a`, form control or chip, and `rounded-xl` on anything else. `rounded-full` stays only on: dots, progress tracks, avatars, fixed-size icon wells with no padding, the Switch, `.co-cost`, filter-builder include/exclude chips, facet-chips and its search input, the three Today hero links (`today-dashboard.tsx`), and the apply-view URL bar with its submit button. Every other `rounded-full` element with padding or a border becomes `rounded-md`, or becomes `<Button>`.

Two shadows, defined in `@theme`. `shadow-raised` = `0 1px 2px var(--shadow-tint), 0 4px 12px -2px var(--shadow-tint)`: elevated or interactive cards, floating buttons (Ask, back to top), sticky save bars, shortlist tray, Switch knob. `shadow-overlay` = `0 2px 6px var(--shadow-tint), 0 24px 48px -12px var(--shadow-deep)`: Dialog, drawer, popovers, menus, toasts, assistant console panel. `shadow`, `shadow-sm` and `shadow-md` become `shadow-raised`; `shadow-xl` and `shadow-2xl` become `shadow-overlay`; `shadow-lg` becomes `shadow-overlay` on an overlay and `shadow-raised` elsewhere. Resting cards, rows, inputs and in-flow buttons carry no shadow; in dark, borders carry elevation.

## 5a. Glass material

Glass is a surface treatment, not a color: a translucent fill over a live blur of what sits behind it. It is reserved for four sites: the app-shell nav, the Today hero instrument slab, the setup wizard's active stage panel and the wizard stepper. Everything else that wants the look uses `frost`, which is the same fill without the blur pass and has no budget.

| Token | Light | Dark |
|---|---|---|
| `--glass-fill` | `--surface` at 55% via `color-mix` (also the contrast floor: a site that fails 4.5:1 takes a thicker local fill or goes solid) | same |
| `--glass-sheen` | top-down `#FFFFFF` gradient, 6% to 0%, layered over the fill | same |
| `--glass-border` | `#001E2B` at 12% (Mist vanishes on a light surface) | Mist `#E8EDEB` at 16% |
| `--glass-edge` (inset top highlight) | `#FFFFFF` at 70% | Mist at 35% |
| `--glass-blur` / `--glass-saturate` | `12px` (also the maximum) / `160%` | same |

- `@utility glass` is solid `--surface` with a `--border` edge by default. Under `@supports (backdrop-filter: blur(1px))` it takes the sheen, the fill, the glass border, the inset edge and `backdrop-filter: blur(var(--glass-blur)) saturate(var(--glass-saturate))`. Under `(prefers-reduced-transparency: reduce), (prefers-contrast: more)`, and under `html[data-glass="off"]` (the kill switch, and the in-app toggle for browsers without the reduced-transparency query), it is solid again. Under `forced-colors: active` it is `Canvas` with a `CanvasText` border. The fallbacks are plain media queries inside the utility, not a `@custom-variant`: they are part of the material, never something a call site opts into.
- `@utility frost` is the same fill, border and edge with no `backdrop-filter`, and the same three fallbacks.
- At most 3 `glass` surfaces are visible per view. No glass on glass.
- Never put `opacity`, `filter`, `mask` or `clip-path` on a `glass` element or any ancestor of one: each makes a Backdrop Root, and the blur then samples nothing. Animate `transform` instead.
- Text on glass passes 4.5:1 against the worst-case backdrop sample. Brand text on glass is `text-brand-text`, never a Mint literal (about 1.3:1 on light glass).
- Focus uses `outline`, which survives forced colors. `field-focus` and `field-focus-within` are box-shadow rings, so each adds `outline: 2px solid CanvasText; outline-offset: 2px` under `forced-colors: active`.
- Dialogs stay out of glass: `dialog.ui-dialog` fades `opacity`, and its scrim leaves nothing worth blurring.
- Never combine `glass` or `frost` with a `bg-*`, border color or `shadow-*` class. In the built CSS the two utilities sort after Tailwind's border-width utilities and before its background and shadow ones, so at equal specificity a `bg-*` or `shadow-*` class silently beats the material, and `cn()` cannot dedupe a utility twMerge does not know. A surface that needs a tone or a shadow is not glass. The same order means the material's `border: 1px` beats `border-0` and `border-r`: a one-sided edge needs the important modifier (`border-0! border-r!`, as on the nav).
- Nothing inside or behind a `glass` surface runs an infinite animation. The beta dot in the nav footer pulses three times and holds.
- `apply-view.tsx` has no `backdrop-blur-*` left. Its neutral panels (questions, skeleton, issue list, form details) are `frost`; its tone callouts take their solid `-soft` fill from Card, by the rule above. `/apply`'s page wrapper sets `--glass-fill` to 70%: at 55% the bright form shot behind it drops `text-muted` to 4.21:1 in dark mode. Text on `glass` or `frost` is `text-foreground` or `text-muted`, never `text-faint` (3.5:1 at 70% over that backdrop).
- The page behind the shell is `AmbientGlow` (`hero-glow.tsx`), a fixed `-z-10` layer of the hero's static corner glows, so the nav has something to blur. Today's hero shader runs for 4 s and then holds its frame (`speed` 0 stops its rAF loop), so the slab over it costs no idle frames.

## 6. Spacing rhythm

New code uses steps 0.5, 1, 1.5, 2, 3, 4, 5, 6, 8, 10, 12. Existing off-step values (2.5, 3.5, 7, 9) are not rounded; an element moved onto a primitive takes the primitive's spacing. `size-*`, `w-*`, `h-*`, insets and translates never change for rhythm. Page: `mx-auto max-w-6xl px-4 py-6 sm:px-6 sm:py-8`, plus `max-sm:pb-24` above the mobile bar; reading pages `max-w-3xl`; header to first section `mb-6`, between sections `space-y-8`. Section: no padding (sections are not boxes); heading to content `mb-3`; card grids `gap-4`. Card: `p-5` (was `p-6`), inset and callout `p-4`, dense list rows `px-4 py-3`; header to body `mb-4`; stacks `space-y-3`. Control: Button and inputs `h-9 px-3` (sm `h-7 px-2`), chips `px-2 py-0.5`; control rows `gap-2`; icon to label `gap-1.5`; label to control `mb-1.5`; field to field `space-y-4`.

## 7. Motion

Durations: 150ms hover, press and focus; 200ms enter, exit, popovers and dialogs; 300ms layout moves and drawers; 600ms data. Add to `@theme`: `--ease-out: cubic-bezier(0.22, 1, 0.36, 1); --ease-in-out: cubic-bezier(0.65, 0, 0.35, 1);`. Existing `ease-out` and `ease-in-out` classes intentionally pick up these curves. `components/ui/motion.ts` exports `EASE_OUT = [0.22, 1, 0.36, 1]`, `EASE_IN_OUT = [0.65, 0, 0.35, 1]`, `DURATION = { fast: 0.15, base: 0.2, slow: 0.3, data: 0.6, camera: 0.45 }` (`camera` belongs to section 7a only), and the `listItem`, `rowItem` and `layoutMove` presets below. No springs, no bounce. Only `transform` and `opacity` animate; never width, height, position, margin, shadow or filter. Reduced motion: the shell's `<MotionConfig reducedMotion="user">` makes motion/react transforms instant; CSS transforms sit behind `motion-safe:` or `@media (prefers-reduced-motion: no-preference)`; opacity fades may remain.

| Pattern | Implementation | Applies to |
|---|---|---|
| Hover, press | `transition-colors duration-150 ease-out`. Button and interactive Card use `transition-[color,background-color,border-color,scale] duration-150 ease-out` with `motion-safe:active:scale-98` (Button) or `motion-safe:active:scale-99` (Card) | every interactive element; press on buttons, clickable cards |
| Focus | `focus-ring`, instant; replaces every `focus(-visible)?:ring-*`, `focus-visible:outline-none` and bare `focus:outline-none`. Inside an `overflow-hidden` or `overflow-auto` container use `focus-ring-inset` | buttons, links, cards, rows |
| Field focus | `field-focus` on Input, Select, Textarea (replaces `outline-none focus:border-brand/50` and `focus:ring-2 focus:ring-brand/20`); `field-focus-within` on text-entry wrappers (filter-builder, facet-chips, apply-view URL bar) | form controls only |
| Enter and exit | Blocks: `<AnimatePresence initial={false} mode="popLayout">` in a `relative` parent, children use `listItem` (opacity 0 to 1, y 4 to 0, exit y -4, 200ms `EASE_OUT`). Tables: default sync mode around `motion.tr` with `rowItem` (opacity only, 200ms), never popLayout | blocks: inbox, review queue, worker pills, ChipList, shortlist, toasts, inline errors; tables: pipeline, follow-ups |
| Reorder | Blocks: `layout="position"` with `layoutMove` (300ms `EASE_IN_OUT`). Tables: single-row status moves only, `layout="position"` on `motion.tr` plus `layoutScroll` on the `overflow-x-auto` ancestor; a sort is instant | worker pills, profile cards, shortlist; pipeline status moves |
| Data | ui/charts, once in view, 600ms `EASE_OUT`, stagger 0.04s over at most 8 items | charts only |

```css
@utility focus-ring { &:focus-visible { outline: 2px solid var(--brand); outline-offset: 2px; } }  @utility focus-ring-inset { &:focus-visible { outline: 2px solid var(--brand); outline-offset: -2px; } }
@utility field-focus { outline: none; &:focus-visible { border-color: var(--brand); box-shadow: 0 0 0 2px color-mix(in srgb, var(--brand) 25%, transparent); } }
@utility field-focus-within { &:focus-within { border-color: var(--brand); box-shadow: 0 0 0 2px color-mix(in srgb, var(--brand) 25%, transparent); } }
html:has(dialog[open]) { overflow: hidden; }
dialog.ui-dialog, dialog.ui-dialog::backdrop { transition: opacity .2s var(--ease-out), overlay .2s allow-discrete, display .2s allow-discrete; }
dialog.ui-dialog::backdrop { background: var(--scrim); }  dialog.ui-dialog:not([open]), dialog.ui-dialog:not([open])::backdrop { opacity: 0; }
@starting-style { dialog.ui-dialog[open], dialog.ui-dialog[open]::backdrop { opacity: 0; } }
@media (prefers-reduced-motion: no-preference) { dialog.ui-dialog { transition: opacity .2s var(--ease-out), scale .2s var(--ease-out), overlay .2s allow-discrete, display .2s allow-discrete; }
  dialog.ui-dialog:not([open]) { scale: .98; }  @starting-style { dialog.ui-dialog[open] { scale: .98; } } }
```

## 7a. Camera tier

The setup wizard is one world of stages at fixed coordinates, and moving between stages moves a camera over it (`components/ui/camera.tsx`, geometry in `lib/camera-path.mjs`). This is the only exception to section 7's durations.

- The world element's `transform` is the only thing that animates. Stages rest at scale 1: the camera scales the world, never a stage, so text is crisp at rest. Stage positions come from `radialPositions` (You at the centre, the ring clockwise from 12 o'clock), at R = 900.
- A stage's footprint is at most `w-2xl` (42rem). On an integrated GPU at DPR 2 the cost of a flight tracks how much stage area is on screen near scale 1: a `w-4xl` stage made every flight to or from it GPU-bound. R = 900 leaves the closest pair (155px apart at the cap) showing a deliberate sliver of each neighbour; a stage that outgrows the cap means re-running the geometry check in `/lab/camera`, not raising R by eye.
- Fixed chrome (the stepper, the rail) is declared to `World` as `inset` in screen px, `[top, right, bottom, left]`. Every view, the overview included, centres in the rect inside it, so nothing rests under the chrome.
- A flight is `element.animate` over 13 keyframes sampled from van Wijk and Nuij's smooth zoom (rho = sqrt 2). `DURATION.camera` (450ms) is one hop at constant zoom; any longer flight and any change of zoom (the review overview) is `DURATION.data` (600ms). The bucket follows world distance, not stage count. A flight from rest eases with `EASE_IN_OUT`; a flight that interrupts another starts with `commitStyles()` then `cancel()` and eases with `EASE_OUT`, which starts at peak velocity. Never `fill: "forwards"`: a filling animation outranks every later inline write.
- Nothing in React commits during a flight. The commit that changes the active stage also un-hides it from its `<Activity>`, and take-off waits one frame. `inert`, the glass/frost swap and focus on the stage `h1` (`preventScroll`) all change in the settle commit or after it, never at take-off: making a focused Continue button inert mid-flight sends focus to `body`. The page title is the exception and belongs to the route, not the camera: each stage page sets it in `generateMetadata`, because Next's route announcer reads `document.title` in the navigation commit, and a title written at settle is one hop stale by then.
- During a flight `<html>` carries `data-flying` (on the root, not the viewport, so the swap reaches the chrome glass outside the world). The viewport turns pointer events off. Every `glass` surface fades in its `::before` mask (solid `--surface`) over 150ms and drops its `backdrop-filter` once the mask is opaque. On settle the blur returns at once and the mask fades out. Opacity sits on the pseudo-element only, never on the glass or its ancestors. The camera clears the flag if it unmounts mid-flight.
- Two `will-change` hints, both measured. The world carries `will-change: transform`: promoted only at take-off, it re-rasterised on the GPU thread for the first 250ms of every flight. `glass` carries `will-change: backdrop-filter`: without it, dropping the blur decomposited the surface and re-promoting it at settle cost a frame. Together they cost at most 37MB of GPU memory over the unhinted build, at the overview. Nothing else gets a hint.
- Perf is measured at native DPR 2 on the integrated GPU (`/lab/camera`, a production build), not at DPR 1: the GPU cost is per device pixel, and DPR 1 hides it.
- The `filter` ban stays: WCAG 2.3.3 counts animated blur as motion.
- Reduced motion has no flight. The camera reads `prefers-reduced-motion` at take-off (so a live OS toggle applies to the next move without a remount) and plays a 200ms fade-through of the whole world, cutting position at the midpoint: two keyframes share offset 0.5. Opacity on the world makes it a Backdrop Root, so the same `data-flying` swap turns every glass surface to frost first, with its transitions off.
- Perf marks: `camera:settle` when a flight lands and the `camera:settle-commit` measure across the settle commit, which stays under 50ms.

## 8. Primitive APIs

All live in `components/ui/`, and every primitive forwards `className`. Tone classes come from a literal `Record<Tone, string>`, never an interpolated template string (Tailwind only generates literals it finds).

```ts
// button.tsx. buttonVariants({ variant, size }) stays exported for <Link>. "outline" folds into "secondary".
Button: ButtonHTMLAttributes<HTMLButtonElement> & { loading?: boolean;  // Loader2 spinner, aria-busy, disabled
  variant?: "primary" | "secondary" | "ghost" | "soft" | "warn" | "danger" | "danger-ghost"; // default "primary"
  size?: "sm" | "md" | "lg" | "icon" | "icon-sm" }; // h-7 | h-9 (default) | h-10 | size-9 | size-7; all keep max-sm:min-h-11
// soft = bg-brand-soft text-brand-text border border-brand/30 hover:bg-brand-soft/70; warn = bg-warn and danger = bg-bad-text,
// both text-brand-foreground; danger-ghost = text-muted hover:text-bad-text hover:bg-bad-soft
// card.tsx. Absorbs motion-bits Panel and the tinted alert panels. Card drops overflow-hidden: the corner
// gradient uses bg-origin-border, and clipping would cut focus outlines.
Card: HTMLAttributes<HTMLElement> & { as?: "div" | "section" | "article"; // default "section" with a title, else "div"
  icon?: LucideIcon; title?: ReactNode; hint?: ReactNode; aside?: ReactNode; // title renders an h2
  inset?: boolean; /* rounded-xl p-4, not rounded-2xl p-5 */ tone?: "neutral" | "good" | "warn" | "bad" | "info"; // neutral = bg-surface border-border; else bg-X-soft border-X/30, icon in X's text token
  interactive?: boolean; elevated?: boolean; corner?: "br" | "bl" | "tr" };
// dialog.tsx. Native <dialog class="ui-dialog"> + showModal(): inert background, focus trap, Escape, focus return.
Dialog: { open: boolean; onClose: () => void; title: ReactNode; description?: ReactNode; // closes on Escape (cancel event), backdrop, close button; aria-labelledby, aria-describedby
  size?: "sm" | "md" | "lg" | "xl"; footer?: ReactNode; children: ReactNode };
// sizes: max-w-sm (next-date) | max-w-md (log) | max-w-lg (beta, first-score) | max-w-3xl with an h-[85vh] body (digest).
// first-score-view migrates to Dialog size="lg" and drops .co-aha, co-aha-in and its own focus trap.
// field.tsx. Absorbs motion-bits Label (its `code` prop becomes `meta`) and both Toggles (motion-bits, config-form).
type FieldOwn = { label?: ReactNode; hint?: ReactNode; error?: string | null; meta?: ReactNode; compact?: boolean };
Input: Omit<InputHTMLAttributes<HTMLInputElement>, "size"> & FieldOwn & { size?: "sm" | "md"; mono?: boolean };
Textarea: TextareaHTMLAttributes<HTMLTextAreaElement> & FieldOwn & { mono?: boolean };
Select: Omit<SelectHTMLAttributes<HTMLSelectElement>, "size"> & FieldOwn & { size?: "sm" | "md" }; // native <option>s
Field: FieldOwn & { children: ReactNode };             // wraps a custom control such as ChipList
Switch: { checked: boolean; onChange: (v: boolean) => void; label: string; disabled?: boolean };
// controls: border-control-border bg-surface field-focus. label = text-sm font-medium text-foreground, sentence case;
// compact (Home settings panels only) = eyebrow text-2xs font-semibold text-muted. error = text-xs text-bad-text + aria-invalid, aria-describedby. Switch track: off bg-control-border, on bg-brand; knob bg-white shadow-raised.
// charts.tsx. Moved from motion-bits; BarList replaces the inline BarChart in /analytics. Bar, Steps and SegmentBar are
// decorative: their number or label is always rendered as text beside them.
type Tone = "brand" | "good" | "warn" | "bad" | "info" | "boost" | "muted"; // bg-<tone>; muted is bg-faint
CountUp: { value: number };  Steps: { done: number; total: number; tone?: Tone };  Bar: { pct: number; tone?: Tone; size?: "sm" | "md" }; // h-1 | h-1.5 on a bg-surface-muted track
SegmentBar: { parts: { key: string; count: number; tone: Tone; label: string }[] };  BarList: { items: { label: string; value: number; tone?: Tone }[]; takeaway: string; total?: number };
```

## 9. Allowed exceptions

`hero-glow.tsx` shader colors (LeafyGreen hex with alpha) and the hero veil's `dark:bg-background/45`. The email digest preview: its `bg-white` iframe and the digest HTML, which is an email and needs inline hex. `company-logo.tsx`: the hue-hashed `hsl()` monogram with `text-white`, and `bg-white` behind fetched logos, which assume a white canvas. The Switch knob's `bg-white`. The `theme-color` meta hex in `app/layout.tsx` and `theme-toggle.tsx`, which must be literal before CSS loads. `#000` inside CSS `mask-image` gradients, where it sets alpha, not color.

## 10. Ownership

**Foundation** is one agent and lands first: `app/globals.css`, `app/layout.tsx`, `components/ui/*` (including the new dialog, field, charts and motion.ts), `app-shell`, `mobile-nav`, `theme-toggle`, `usage-meter`, `jobs/worker-pills`, `profile-picker`, `beta/*`, `onboarding-banner`, `hero-glow`, `components/ui/camera.tsx`, `lib/camera-path.mjs`, and this file. **Rollout** is everything else under `web/src`, including `home/motion-bits.tsx` (the agent owning `components/home/*` switches imports to `ui/` and deletes the moved pieces) and class strings in `lib/format.ts` and `lib/followups.ts`. Rollout agents never edit foundation files: a missing token, size or prop goes to the orchestrator, not around it with a raw class.
