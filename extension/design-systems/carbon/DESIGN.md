---
name: Carbon
description: IBM Carbon — enterprise productivity. Dense 2px-grid layouts, IBM Plex, blue-60 accent, sharp corners, data-first. Calm, rigorous, accessible.
ds4_category: general
ds4_local_mode: reference
ds4_output_kinds: html
ds4_upstream: dstudio/carbon
---

# DESIGN SYSTEM: Carbon

Enterprise software for people who work in it all day. Rigorous grid, restrained color, dense
information, IBM Plex typography. Function and clarity over flourish; accessible by mandate.

## Color (white & dark "g100" both canonical)

- `--bg: oklch(1 0 0)`                 /* white (or g100 `oklch(0.18 0.005 250)`) */
- `--surface: oklch(0.97 0.003 250)`   /* layer-01 */
- `--surface-2: oklch(0.93 0.005 250)` /* layer-02 */
- `--border: oklch(0.86 0.006 250)`    /* subtle border */
- `--fg: oklch(0.18 0.006 250)`        /* text-primary (near `#161616`) */
- `--muted: oklch(0.48 0.008 250)`     /* text-secondary */
- `--accent: oklch(0.52 0.18 255)`     /* Blue 60 — interactive/primary */
- semantic: red 60 danger, green 50 success, yellow 30 warning, literal and consistent.

Dark (g100): layered grays step lighter (bg < layer-01 < layer-02), same blue 60.

## Typography

- Stack: `"IBM Plex Sans", "Inter", system-ui, sans-serif`; mono `"IBM Plex Mono", monospace`.
- Carbon type scale: body 14px (`body-01`), 16px for comfortable reading; headings via a
  productive scale (16/20/28/32). Weights 400/600. Tight, even, no flourish.
- Labels 12px, helper text 12px. Sentence case.

## Spacing & layout

- **2px base grid** (Carbon's mini-unit), composing on a 16-column grid. Dense but aligned.
- Radius: small — **0 to 2-4px**. Mostly **sharp** corners; productivity over softness.
- Borders + layered surfaces carry hierarchy; shadows are minimal (overlays only).
- App shell: a top **UI shell** header + an optional left side-nav; content in a strict grid.

## Components

- Buttons: primary (blue 60), secondary (gray), tertiary (outline), ghost, danger — sharp,
  with a distinct focus outline. Fixed heights (40/48).
- Inputs/selects: bordered, labeled above, helper/error below, a 2px focus border in blue.
- Data tables are first-class: dense rows, sortable, sticky header, batch actions, pagination.
- Tags, notifications (inline/toast), tabs, accordions, modals — all calm and consistent.

## Motion

- Productive motion: fast (110-240ms), Carbon's standard easing. Functional transitions, no
  decoration. `prefers-reduced-motion` honored.

## Voice

Clear, professional, direct. Sentence case. Helpful error/empty messages with the next action.

## Anti-patterns (never)

Rounded pill everything, playful color, heavy shadows, decorative gradients, cramped
illegible density, inconsistent grid, low contrast (Carbon targets AA+).
