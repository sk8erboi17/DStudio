---
name: Motion discipline
description: Make transitions purposeful, interruptible and reduced-motion-aware while preserving reading, selection and control.
---

# CRAFT: motion discipline

## Explain a change

Use motion for meaningful feedback, spatial continuity or a deliberate visual
character. Transition length follows distance and task; roughly 120–240ms is a
useful UI starting point, not a mandatory quota. Prefer transform/opacity when
appropriate, and measure actual layout/painting cost before calling it cheap.

Content is readable immediately. Do not gate reading on a hero entrance or
word-by-word prose reveal. Keep controls available during pending work; an
animation cannot determine when loading, saving or an external operation succeeds.
Unknown progress stays indeterminate instead of inventing a percentage.

## Preserve interaction

Interrupt or retarget transitions safely after rapid input. Cancelled drags and
previews keep prior committed data. Updating a view must preserve focus, typed
input, scroll intent and text selection; avoid replacing the whole reading DOM
on each streamed fragment. Pause automatic motion when the user is reading or
operating the region, and expose necessary playback/Stop controls.

## Reduced motion and verification

Respect `prefers-reduced-motion` by removing nonessential travel, parallax,
autoplay and decorative loops; preserve immediate state feedback. Apply the
preference to JavaScript-driven motion as well as CSS. Do not rely on a global
near-zero-duration rule if code waits for an animation event to complete.

Exercise rapid repeated input, cancellation, reduced motion and slow/fast
simulated updates. Check flicker, stale callbacks, focus and reading selection
in the actual browser. Record only tested outcomes, not a performance claim
based on the property chosen to animate.
