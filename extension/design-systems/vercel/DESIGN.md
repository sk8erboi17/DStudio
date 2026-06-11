---
name: Vercel
description: Pure black & white, geometric, maximum contrast. No accent color — type, space and a single hairline carry everything. Developer-grade minimalism.
ds4_category: general
ds4_local_mode: reference
ds4_output_kinds: html
ds4_upstream: dstudio/vercel
---

# DESIGN SYSTEM: Vercel

Monochrome to the bone. Black, white, and one gray border. The product *is* the content;
the chrome disappears. Confidence through absence. Color, when it appears, is data, not decoration.

## Color (OKLch — works identically inverted)

- `--bg: oklch(1 0 0)`           /* white (or `oklch(0.15 0 0)` for dark) */
- `--surface: oklch(0.985 0 0)`  /* barely-there panel */
- `--border: oklch(0.90 0 0)`    /* the one gray hairline */
- `--fg: oklch(0.15 0 0)`        /* near-black */
- `--muted: oklch(0.55 0 0)`     /* gray secondary text */
- `--accent: oklch(0.15 0 0)`    /* "accent" IS black — primary buttons are black */
- semantic (only for status, never chrome): success `oklch(0.62 0.17 150)`,
  warn `oklch(0.80 0.16 80)`, danger `oklch(0.58 0.22 27)`, info `oklch(0.60 0.18 250)`

Dark mode is a true invert and equally canonical.

## Typography

- Stack: `-apple-system, "SF Pro", "Inter", system-ui, sans-serif`; mono
  `"SF Mono", "Geist Mono", ui-monospace, monospace` for anything technical.
- Sizes: 14–16px body, scale ×1.2. Headings get weight + size, never color.
- Weights: 400 body, 500 labels, 600 headings. Tight tracking on big headings (`-0.02em`).
- Generous line-height (1.6) — whitespace is the design.

## Spacing & layout

- 4px grid, but compose with large empty space. Sections separated by space, not lines.
- Radius: 6–8px, restrained. Geometric, even.
- Exactly one border weight (1px `--border`). No shadows in content; a faint shadow only
  on overlays. Dividers are hairlines.
- Strong grid alignment; everything snaps. Centered max-width ~1000px for prose.

## Components

- Buttons: black solid primary, white-with-hairline secondary, both 8px radius, crisp.
  Hover = subtle invert or 90% opacity, no shadow.
- Inputs: white, 1px border, black focus ring (no glow). Mono for tokens/keys.
- Tables/logs: monospace numbers, hairline rows, lots of breathing room.
- Code is a first-class citizen: dark block, mono, copy button, language tab.

## Motion

- Near-instant, mechanical: 100–150ms ease-out. Fades and crisp slides, never bounces.
  `prefers-reduced-motion` honored.

## Voice

Minimal, technical, dry. Lowercase or sentence case. Let the work speak. "Deploy." not
"Deploy your amazing project now!".

## Anti-patterns (never)

Any decorative color, gradients, shadows-on-cards, rounded pills, illustrations, emoji,
multiple grays competing — if it isn't black, white, or one gray hairline, justify it.
