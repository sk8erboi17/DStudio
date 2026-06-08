---
name: mobile-app
description: Mobile app screens rendered inside a realistic phone frame (390×844), thumb-first, with a real navigation model and per-screen states.
modes: [design]
when_to_use: The user wants mobile app screens, an iOS/Android prototype, or "an app".
---

# SKILL: mobile-app

You are designing for a thumb on a 390×844 screen held one-handed. Reach, tap size and a
clear navigation model matter more than cleverness.

## Frame

- Render each screen in a **390×844 device frame** (rounded corners, status bar with time
  / signal / battery, optional notch/dynamic-island, home indicator). Inline SVG/CSS for
  the frame — no external assets.
- For multi-screen flows, lay frames **side by side** on the canvas (a row of phones) so
  the flow reads left-to-right; or one `index.html` launcher linking to `screens/*.html`.
- The content scrolls *inside* the frame; the status bar and bottom nav stay fixed.

## Navigation model (pick one and be consistent)

- **Tab bar** (3–5 items, bottom): for apps with parallel top-level sections. Icons +
  labels, the active tab in the accent, ≥44px targets, safe-area padding at the bottom.
- **Stack / push**: a top bar with a back chevron + title for drill-down flows.
- **Modal sheet**: bottom sheet for focused tasks (compose, filter, confirm).
Don't mix paradigms randomly; one primary model per app.

## Per-screen craft

- **One primary action per screen**, as a full-width button or a FAB — obvious and within
  thumb reach (bottom third).
- **Touch ergonomics**: ≥44px targets, ≥8px between them, generous vertical rhythm. Body
  ≥16px (never shrink to fit more).
- **Native feel**: respect platform conventions (iOS large titles / Android app bars) if
  the brief names a platform; otherwise a clean neutral system.
- **Cover the states** per screen: loading (skeleton), empty (first-run + the one action),
  error (inline, retry), populated (real varied data), and a key edge (long name, long
  list). A prototype that only shows full screens isn't a prototype.

## Typical screens (build the flow, not one screen)

Onboarding/auth → home/feed → detail → a create/compose flow → profile/settings. Show the
2–4 screens that carry the product's core loop, not a screen dump.

## Self-check before artifact (fix anything < 3/5)

- **Reach**: primary actions in the thumb zone (bottom third)?
- **Consistency**: one navigation model, applied the same on every screen?
- **States**: loading / empty / error actually rendered for the key screen?
- **Flow**: do the screens tell the core-loop story in order?
- **Ergonomics**: ≥44px targets, ≥16px body, safe-area respected?

Gate: 390-wide frames, contrast ≥4.5:1, tap ≥44px, no horizontal scroll inside the frame,
realistic data (no `User 1 / User 2`).
