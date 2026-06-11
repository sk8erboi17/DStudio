---
name: Apple
description: Refined, spacious, deferential. Huge calm headlines, lots of whitespace, system blue used sparingly, content-forward. Premium through restraint and clarity.
ds4_category: web-ui-prototype
ds4_local_mode: native
ds4_output_kinds: image-brief
ds4_upstream: dstudio/apple
---

# DESIGN SYSTEM: Apple

Clarity, deference, depth. The interface gets out of the way; the content (a product, a
photo, a number) is the hero. Big type, generous space, immaculate alignment, one quiet blue.

## Color (OKLch — light canonical, dark equally first-class)

- `--bg: oklch(1 0 0)`                 /* white */
- `--surface: oklch(0.975 0.001 250)`  /* `#f5f5f7`-like off-white */
- `--surface-2: oklch(0.94 0.002 250)`
- `--border: oklch(0.90 0.002 250)`    /* very soft */
- `--fg: oklch(0.15 0.005 250)`        /* near-black `#1d1d1f` */
- `--muted: oklch(0.55 0.005 250)`     /* `#6e6e73` secondary */
- `--accent: oklch(0.58 0.17 250)`     /* system blue, used sparingly for links/CTAs */
- semantic used literally (green/orange/red) only for status.

Dark: `--bg: oklch(0 0 0)` true black, `--surface: oklch(0.18 0 0)`, same blue.

## Typography

- Stack: `-apple-system, "SF Pro Display", "SF Pro Text", system-ui, sans-serif`.
- BIG calm headlines: hero 48–80px, weight 600–700, tight tracking (`-0.02em`). Body 17–21px.
- Scale ×1.25; weights 400 body, 500 labels, 600 display. Line-height 1.1 on huge heads,
  1.5 body. Center hero copy; left-align dense content.

## Spacing & layout

- 8px grid, but think in big blocks: section padding 80–140px, content centered, max ~980–1200px.
- Radius: 12–20px (Apple's continuous-corner feel). Cards are large, soft, roomy.
- Soft shadows for product cards; otherwise space separates, not lines.
- Full-bleed media sections that alternate with centered text. Strong vertical rhythm.

## Components

- Buttons: pill or 12px-radius, system blue solid primary, light gray secondary; medium
  weight, comfortable padding (the famous blue "Buy"/"Learn more" pair).
- Inputs: minimal, soft, rounded, light fills.
- Cards: large, rounded, generous padding, a single soft shadow; image-led.
- Nav: thin, translucent, sticky; minimal links.

## Motion

- Smooth, physical, unhurried: 300–500ms ease-in-out, gentle parallax/scale on scroll
  for hero media. Nothing jarring. `prefers-reduced-motion` strictly honored.

## Voice

Calm, declarative, aspirational-but-plain. Short lines. "A magical new way to…" sparingly.
Sentence fragments for impact. Let the product carry it.

## Anti-patterns (never)

Cramped layouts, tiny type, hard borders everywhere, neon or multiple accents, busy
gradients, clip-art, dense data on a marketing page, anything loud.
