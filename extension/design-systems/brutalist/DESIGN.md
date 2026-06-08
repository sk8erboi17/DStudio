---
name: Brutalist
description: Raw, loud, structural. Stark high-contrast, thick black borders, hard corners, monospace, one electric accent. Anti-polish on purpose — confident and editorial.
---

# DESIGN SYSTEM: Brutalist

Web brutalism: exposed structure, no softening. Thick borders, hard edges, big ugly-beautiful
type, a single shocking accent. It should feel made by a human with opinions, not a template.

## Color (OKLch — high contrast is the point)

- `--bg: oklch(0.97 0.01 95)`          /* off-white / paper, or pure white */
- `--surface: oklch(1 0 0)`            /* white blocks */
- `--border: oklch(0.15 0 0)`          /* near-black, THICK */
- `--fg: oklch(0.12 0 0)`              /* black ink */
- `--muted: oklch(0.40 0 0)`           /* gray */
- `--accent: oklch(0.72 0.20 145)`     /* electric lime — or swap a hot pink/cyan/orange */
- second accent allowed (clashing on purpose): `oklch(0.62 0.24 25)` (red) etc.

Inversion (black bg, white text, lime accent) is fully on-brand for sections.

## Typography

- Stack: `"Inter", system-ui, sans-serif` for body; mono `"Geist Mono", ui-monospace,
  monospace` used liberally for labels, meta, captions, nav.
- HUGE display type: hero 64–140px, weight 700–800, tight or even overlapping. Body 16–18px.
- Mix: oversized sans headlines + monospace UI text. Uppercase labels with wide tracking.
- Line-height tight on heads (0.95–1.05), normal body. Underlines are real underlines.

## Spacing & layout

- 8px grid, but compose with bold asymmetry and a visible underlying grid (rule lines ok).
- Radius: 0 (or 2px max). Hard corners everywhere.
- Borders: 2–3px solid `--border` on cards, buttons, inputs, sections. Offset "hard
  shadows" (`box-shadow: 6px 6px 0 var(--border)`) instead of soft blur.
- Dense, intentional, a little crowded; section dividers are thick rules.

## Components

- Buttons: thick border, hard offset shadow, flat fill (accent or white), uppercase mono
  label; on hover the shadow collapses (translate to meet it). 0 radius.
- Inputs: thick border, no rounding, mono text, accent caret/focus (a solid 3px ring).
- Cards: white block, 2–3px border, hard offset shadow, generous internal padding.
- Tags/badges: bordered rectangles, uppercase mono.

## Motion

- Snappy and mechanical: 80–140ms steps/linear. Hover = shadow snap, instant invert.
  No easing softness. `prefers-reduced-motion` honored (drop the snaps).

## Voice

Loud, opinionated, direct. UPPERCASE for emphasis. Short declaratives. Manifesto energy.
"WE BUILD THINGS." Wit over polish.

## Anti-patterns (never)

Soft shadows, rounded corners, pastel gradients, timid type, centered-everything safe
layouts, "clean SaaS" blandness. If it looks like a default Tailwind template, start over.
