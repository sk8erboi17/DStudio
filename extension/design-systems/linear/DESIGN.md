---
name: Linear
description: Dark, sharp, technical. Indigo accent on near-black, tight grid, crisp 1px borders, fast and quiet — a tool for people who live in it.
ds4_category: general
ds4_local_mode: reference
ds4_output_kinds: html
ds4_upstream: dstudio/linear
---

# DESIGN SYSTEM: Linear

A focused, keyboard-first product aesthetic. Dark by default, high signal, zero
decoration. Everything feels fast, precise, and a little severe. Restraint is the brand.

## Color (OKLch — dark is canonical)

- `--bg: oklch(0.16 0.012 270)`        /* near-black, faint cool cast */
- `--surface: oklch(0.20 0.014 270)`   /* cards / panels, one step up */
- `--surface-2: oklch(0.25 0.016 270)` /* hover / raised */
- `--border: oklch(0.30 0.015 270)`    /* hairline, low contrast */
- `--fg: oklch(0.96 0.005 270)`        /* primary text, not pure white */
- `--muted: oklch(0.70 0.012 270)`     /* secondary text */
- `--accent: oklch(0.62 0.19 274)`     /* indigo — links, primary, focus */
- semantic: success `oklch(0.72 0.17 150)`, warn `oklch(0.80 0.15 85)`, danger `oklch(0.64 0.21 25)`

Light mode exists but is secondary: invert (`--bg: oklch(0.99 0 0)`), keep the same indigo.

## Typography

- Stack: `"Inter", -apple-system, system-ui, sans-serif`. Numbers tabular in tables.
- Sizes: 13px base UI, 14–15px body, headings 18 / 22 / 28. Tight — this is a dense tool.
- Weights: 400 body, 510 labels, 590 headings. Never heavier.
- Letter-spacing slightly negative on headings (`-0.01em`); line-height 1.5 body, 1.2 headings.

## Spacing & layout

- 4px base grid; common steps 4 / 8 / 12 / 16 / 24 / 32.
- Radius: small and consistent — 6px controls, 8px cards. Nothing pill-shaped except tags.
- Borders do the work: 1px `--border` everywhere instead of shadows. Shadows only on
  floating layers (menus, dialogs), and subtle.
- Dense rows (32–36px), sidebar 240px, generous horizontal padding inside a tight vertical rhythm.

## Components

- Buttons: solid indigo primary (compact, 32px), ghost secondary (border only), text tertiary.
- Inputs: dark surface, 1px border, indigo focus ring (no glow). 32px tall.
- Tables/lists: hairline rows, hover highlight, right-aligned numbers, status as a small dot+label.
- Menus/cmd-k: dark floating panel, subtle shadow, 1px border, keyboard hints inline.

## Motion

- Fast and minimal: 120–160ms ease-out. Things appear, they don't bounce. Respect
  `prefers-reduced-motion`. No decorative animation.

## Voice

Terse, technical, confident. Sentence case. No exclamation marks, no marketing fluff.
"Create issue", not "Let's create your first issue! 🎉".

## Anti-patterns (never)

Purple gradients, glassmorphism, big rounded pills, drop shadows on cards, emoji as UI,
playful copy, more than one accent, anything that slows the eye down.
