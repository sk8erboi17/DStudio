---
name: Notion
description: Warm, editorial, human. Off-white paper, near-black ink, a friendly accent, serif accents and emoji-as-identity. Calm document-first software.
---

# DESIGN SYSTEM: Notion

Software that feels like a well-kept notebook. Warm neutrals, generous reading measure,
restrained color, a touch of playfulness. Content is text-first; the chrome is quiet and cozy.

## Color (OKLch — light canonical)

- `--bg: oklch(0.99 0.004 90)`         /* warm off-white, faint paper */
- `--surface: oklch(0.97 0.004 90)`    /* hover / sidebar fill */
- `--surface-2: oklch(0.94 0.005 90)`
- `--border: oklch(0.90 0.004 90)`     /* soft warm gray */
- `--fg: oklch(0.25 0.01 60)`          /* warm near-black ink `#37352f` */
- `--muted: oklch(0.55 0.01 60)`       /* warm gray secondary */
- `--accent: oklch(0.55 0.13 240)`     /* Notion blue, calm */
- accent palette (highlights/tags, low chroma): blue, brown, orange, green, pink, red —
  used as soft backgrounds (`oklch(0.93 0.04 h)`), never loud.

Dark: warm charcoal `--bg: oklch(0.22 0.005 60)`, `--fg: oklch(0.92 0.005 60)`.

## Typography

- Stack: `-apple-system, "Inter", system-ui, sans-serif`; an optional serif
  (`"Lyon", Georgia, serif`) for big page titles / quotes adds the editorial feel.
- Body 16px, comfortable reading measure (~680px), line-height 1.65. Headings 30 / 24 / 20.
- Weights 400 body, 500 labels, 600 headings. Slightly relaxed, never tight.

## Spacing & layout

- 4px grid; calm vertical rhythm with real paragraph spacing. Document max-width ~720px.
- Radius: 4–6px (subtle, soft). Almost no shadows; hover fills instead of elevation.
- Left rail sidebar (light, collapsible), content centered as a "page". Blocks, dividers,
  callouts (tinted soft backgrounds with an emoji/icon).

## Components

- Buttons: subtle — light fill or border, blue primary used sparingly; rounded 6px.
- Inputs: minimal, often borderless until focus; inline, document-like.
- Callouts: soft tinted background + leading emoji/icon. Toggle lists, checklists, tables
  with hairline borders. Tags as soft colored pills.
- Hover reveals controls (drag handles, + buttons) — quiet until needed.

## Motion

- Gentle and quick: 120–200ms ease. Soft fades, hover fills, smooth expand/collapse.
  Nothing flashy. `prefers-reduced-motion` honored.

## Voice

Friendly, plain, encouraging. First person ok. Emoji as identity/markers (one per
callout/page), not decoration. "Add a page", "Your workspace".

## Anti-patterns (never)

Cold pure-white + pure-black, harsh borders, heavy shadows, saturated/neon color, cramped
data-dense chrome, corporate stiffness, emoji spam.
