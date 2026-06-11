---
name: Motion discipline
description: Motion is feedback, not decoration. Short, purposeful, interruptible, and reduced-motion-aware. Animate transform/opacity, never block the content.
---

# CRAFT: motion discipline

Motion exists to **explain** (where did this come from, what changed, what's loading) — not
to impress. Most of a good interface is still. Earn every animation.

## Rules

- **Purpose**: every animation answers "what changed / where did it go". Hover feedback, state
  transitions, enter/exit, loading. No motion that decorates without informing.
- **Duration**: 120–240ms for UI transitions, up to ~300–400ms for larger/hero moves. Faster
  than you think. Ease-out for enters, ease-in for exits.
- **Animate cheap properties**: `transform` and `opacity` (GPU-friendly). Avoid animating
  `width/height/top/left` (layout thrash) — use transform/scale instead.
- **Never block content**: don't gate reading on an entrance animation; text appears
  immediately or near-so. No word-by-word reveals on body copy.
- **Restraint**: one or two considered motions per screen. Bounces/springs only where a
  playful brand calls for it (see the design system), never by default.

## Reduced motion (required)

```css
@media (prefers-reduced-motion: reduce) {
  *, *::before, *::after { animation-duration: .01ms !important; animation-iteration-count: 1 !important; transition-duration: .01ms !important; scroll-behavior: auto !important; }
}
```
Drop parallax, auto-play, infinite loops, and large transforms; keep essential, instant
feedback. Nothing flashes more than 3×/second.

## Self-check before artifact

- Does each animation inform (feedback/transition/loading), not just decorate?
- Durations 120–240ms (UI), transform/opacity only, content never blocked?
- `prefers-reduced-motion` honored (parallax/auto-play/loops dropped)?
- Restrained — one or two motions per screen, not motion everywhere?
