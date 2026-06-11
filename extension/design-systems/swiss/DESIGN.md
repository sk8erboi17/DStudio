---
name: Swiss
description: International Typographic Style — strict grid, Helvetica, flush-left/ragged-right, black + red on white, photography over illustration. Objective, confident, timeless.
ds4_category: general
ds4_local_mode: reference
ds4_output_kinds: image-brief
ds4_upstream: dstudio/swiss
---

# DESIGN SYSTEM: Swiss

Swiss/International style: the grid is the design. Objective, asymmetric, typographic.
Content organized with mathematical clarity; one accent (classically red); nothing decorative.

## Color

- `--bg: oklch(1 0 0)`            /* white */
- `--surface: oklch(0.98 0 0)`
- `--border: oklch(0.85 0 0)`    /* thin rules */
- `--fg: oklch(0.12 0 0)`        /* black */
- `--muted: oklch(0.45 0 0)`     /* gray */
- `--accent: oklch(0.55 0.22 27)` /* signature red (or a single strong hue) */

Mostly black-and-white; red used decisively and sparingly (a rule, a number, one word).

## Typography

- Stack: `"Helvetica Neue", Helvetica, "Inter", Arial, sans-serif`. Helvetica is the soul.
- **Flush left, ragged right.** Never justified, never centered for body. Tight, even tracking.
- A few sizes, big jumps: a large display, a clear body (16-18px), small captions. Weight via
  Helvetica regular/medium/bold. Line-height tight on display, ~1.5 body.
- Big numbers and short labels as graphic elements.

## Spacing & layout

- A **visible columnar grid** (e.g. 12 columns) drives everything; align ruthlessly.
  Asymmetry is intentional — content can hang on a 4/8 column split, not always centered.
- Generous, mathematical whitespace. Radius: 0 (sharp). No shadows. **Thin rules** (1px) and
  whitespace organize, not boxes.
- Strong baseline rhythm; elements snap to the grid.

## Components

- Buttons: minimal — text + a thin rule or a flat black/red fill, sharp corners, no shadow.
- Inputs: a single bottom rule, label above, generous space. Sharp.
- Tables/lists: hairline rules, flush-left text, right-aligned figures, lots of air.
- Images: documentary photography, full-bleed or grid-aligned, never clip-art.

## Motion

- Minimal, precise: 120-200ms linear/ease. Position and opacity only; nothing playful.
  `prefers-reduced-motion` honored.

## Voice

Objective, declarative, economical. Lowercase or sentence case. Let the typography speak.

## Anti-patterns (never)

Centered body text, justified columns, decorative gradients/shadows, rounded corners,
multiple accents, ornamental icons, anything that ignores the grid.
