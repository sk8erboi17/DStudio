---
name: Stripe
description: Light, professional, trustworthy. Indigo/violet on white, generous whitespace, soft shadows, subtle gradients — polished fintech credibility.
---

# DESIGN SYSTEM: Stripe

Clean, confident, premium-but-approachable. Built to make money-moving feel safe and
modern. Lots of air, careful type, a signature indigo, and restrained gradient accents.

## Color (OKLch — light is canonical)

- `--bg: oklch(1 0 0)`                  /* white */
- `--surface: oklch(0.985 0.003 270)`  /* faint cool off-white panels */
- `--surface-2: oklch(0.96 0.006 270)` /* hover / subtle fill */
- `--border: oklch(0.92 0.006 270)`    /* soft hairline */
- `--fg: oklch(0.22 0.03 275)`         /* deep slate, not black */
- `--muted: oklch(0.52 0.02 275)`      /* secondary slate */
- `--accent: oklch(0.55 0.20 280)`     /* Stripe indigo/violet */
- `--accent-2: oklch(0.62 0.17 230)`   /* a second blue for gradients only */
- semantic: success `oklch(0.65 0.16 155)`, warn `oklch(0.78 0.15 75)`, danger `oklch(0.58 0.20 25)`

Signature gradient (use sparingly, hero/accents only): `linear-gradient(135deg, var(--accent), var(--accent-2))`.

## Typography

- Stack: `"Inter", -apple-system, system-ui, sans-serif` (Stripe uses a custom sans; Inter
  is the closest system-safe match). Headings can go slightly tighter.
- Sizes: 16px body, scale ×1.25 → 16 / 20 / 25 / 31 / 39 / 49. Big, calm hero headlines.
- Weights: 400 body, 500 labels, 600 headings. Line-height 1.6 body, 1.15 large headings.

## Spacing & layout

- 8px base grid; sections breathe (96–128px vertical padding on marketing pages).
- Radius: 8px controls, 12–16px cards. Soft, never sharp.
- Shadows: soft and layered (`0 1px 2px rgba(...) , 0 8px 24px rgba(...)` at low alpha) —
  elevation is the depth cue, not borders.
- Max content width ~1100px, centered, with comfortable gutters.

## Components

- Buttons: solid indigo primary with a soft shadow + 1px lighter top edge; secondary is
  white with a hairline border and shadow. 40–44px tall, 8px radius.
- Inputs: white, 1px border, soft focus ring in indigo at low alpha. Floating labels ok.
- Cards: white on faint surface, soft shadow, generous padding (24–32px).
- Code blocks / API snippets are first-class on marketing pages (dark, monospace, tabs).

## Motion

- Smooth and reassuring: 200–280ms ease. Gentle hover lifts (translateY -2px + shadow).
  Gradient sheens ok in a hero. `prefers-reduced-motion` respected.

## Voice

Clear, credible, a little warm. Plain language about complex things. "Payments
infrastructure for the internet." Confident, never hypey.

## Anti-patterns (never)

Harsh pure-black text, sharp corners, dense cramped layouts, neon, more than the one
indigo (+ its gradient partner), heavy borders everywhere, clip-art icons.
