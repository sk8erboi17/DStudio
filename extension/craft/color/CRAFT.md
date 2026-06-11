---
name: Color discipline
description: Neutrals carry the page, one accent earns attention, semantic colors mean status. Define tokens, check contrast on the render, never spend the accent on chrome.
---

# CRAFT: color discipline

Color is a budget, not a decoration. Most of the surface is neutral; the accent is precious;
semantic colors carry meaning. Spend deliberately.

## The budget

- **Neutrals 70–90%** of the surface (bg, surface, text, borders).
- **One accent, 5–10%** — for the primary action, active state, key links. Used ≥2× on a
  screen it stops meaning "primary." Don't paint chrome with it.
- **Semantic 0–5%** — success/warning/danger/info, reserved for **status only**. Don't use
  green just because it looks nice; it signals "good".
- **Effects < 1%.** Gradients/glows are seasoning, not the meal.

## Tokens

- Define a small token set and use it everywhere — `--bg --surface --surface-2 --border --fg
  --muted --accent` (+ accent-hover, semantic). No hard-coded one-off hexes scattered in the
  markup.
- Prefer **OKLch** for perceptually even steps; keep a consistent lightness ladder
  (bg < surface < surface-2) so elevation reads without a border on everything.

## Contrast (cross-ref accessibility)

- **Verify on the rendered colors**, after `var()`/`color-mix()`/opacity resolve. The usual
  failure is a **muted text token too light** for body copy (oklch L ~55–70% on white ≈ 3:1).
  Body/secondary text must hit ≥4.5:1 — darken the muted token, don't ship the gray.
- Text over images/gradients needs a scrim or a solid plate; never trust contrast over a
  photo.

## Dark mode (if offered)

- Not a CSS invert. Layer surfaces lighter with elevation (bg < surface < card), desaturate
  the accent slightly, soften pure-white text to ~oklch(0.95). Re-check contrast — both ways.

## Self-check before artifact

- Neutrals dominate, one accent only on actions/active, semantic only on status?
- Tokens defined and used (no scattered one-off hexes)?
- Body + muted text ≥ 4.5:1 on the rendered background?
- If dark mode: layered surfaces, re-checked contrast?
