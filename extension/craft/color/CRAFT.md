---
name: Color discipline
description: Derive emphasis from the brief and the chosen system. Use stable color roles, measured contrast and explicit status labels, not color quotas.
---

# CRAFT: color discipline

Choose a color logic that helps the audience understand the page. Folio's paper,
Signal's dark work surface and Pulse's colored poster are different valid choices.
They should not converge to one neutral canvas merely to satisfy a percentage.

## Emphasis and meaning

- Choose canvas, reading surfaces and action emphasis together. One accent can
  appear in several links, focus rings and selected controls without becoming a
  defect. Inspect what actually dominates the rendered page, not reference counts.
- Keep the primary action identifiable through contrast, shape, placement and
  spacing. A colored canvas is legitimate when it serves the visual direction.
- Status colors are roles, not a ban on brand colors. A green service identity
  is not automatically a success message. Use explicit status text and distinguish
  selected, pending, successful and failed operations within that palette.
- Add effects only when they clarify hierarchy or the chosen visual character;
  never add a glow or gradient to compensate for weak content or composition.

## Tokens

- Define a small token set and use it everywhere — `--bg --surface --surface-2 --border --fg
  --muted --accent` (+ accent-hover, semantic). No hard-coded one-off hexes scattered in the
  markup.
- Use the pack's supplied color values and pairs. RGB/hex and OKLch are both
  valid; converting notation is not a quality improvement. Distinguish reading
  layers without placing borders around every element.

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

- Does the palette support this brief, with a clear primary action and unambiguous states?
- Tokens defined and used (no scattered one-off hexes)?
- Body + muted text ≥ 4.5:1 on the rendered background?
- If dark mode: layered surfaces, re-checked contrast?
