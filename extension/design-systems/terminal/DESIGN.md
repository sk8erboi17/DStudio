---
name: Terminal
description: Retro CRT terminal — monospace everything, phosphor green (or amber) on near-black, scanline texture, blocky cursor. Hacker/console aesthetic, all type.
ds4_category: general
ds4_local_mode: reference
ds4_output_kinds: html
ds4_upstream: dstudio/terminal
---

# DESIGN SYSTEM: Terminal

A console. Monospace from edge to edge, phosphor glow on black, blinking cursor. Information
density and the romance of the command line. Type IS the interface; there is almost no chrome.

## Color (dark is the only canonical)

- `--bg: oklch(0.16 0.01 150)`        /* near-black with a faint green cast */
- `--surface: oklch(0.20 0.015 150)`  /* panels barely lighter */
- `--border: oklch(0.45 0.10 150)`    /* dim green rule */
- `--fg: oklch(0.85 0.16 150)`        /* phosphor green text */
- `--muted: oklch(0.60 0.10 150)`     /* dimmer green */
- `--accent: oklch(0.90 0.20 150)`    /* bright green highlight */
- amber variant: swap hue to ~85 (amber phosphor); or green-on-black classic.
- semantic: error bright red `oklch(0.65 0.24 27)`, warn amber, ok bright green.

## Typography

- Stack: `"JetBrains Mono", "Geist Mono", "SF Mono", ui-monospace, monospace` — EVERYTHING.
- One or two sizes. 14-16px base, headings just larger/bolder mono. Generous line-height
  (1.5-1.6) like a real terminal. Uppercase for headings/labels with letter-spacing.
- A **blinking block cursor** (▌) as an accent on inputs/prompts. Prompt prefixes (`$`, `>`).

## Spacing & layout

- Character-grid feel: align to a monospace column. Radius: 0. Borders are ASCII-ish boxes or
  thin green rules. No soft shadows — a faint green **glow** (text-shadow) instead.
- Optional **scanline / CRT texture** overlay (subtle repeating linear-gradient) + a faint
  vignette. Keep it readable, not nauseating.
- Dense, left-aligned, log-like.

## Components

- Buttons: `[ LABEL ]` bracketed, or a bordered box; hover = invert (green bg / black text).
- Inputs: a prompt prefix + a line, blinking cursor, green caret. No rounded fills.
- Lists/tables: ASCII rules (─│┌┐) or hairline green; monospace columns line up naturally.
- Output blocks look like terminal output; status as `[OK]` `[ERR]` tags.

## Motion

- Typewriter reveals, cursor blink, instant state flips. 0-120ms, stepped. Optional boot/
  glitch flourish. `prefers-reduced-motion` drops blink + glow animation.

## Voice

Terse, technical, lowercase or UPPER for system messages. `$ run`, `> done`. Dry humor ok.

## Anti-patterns (never)

Proportional fonts, soft pastel color, rounded corners, drop shadows, gradients (other than
the scanline/glow), photography, anything that breaks the all-mono illusion.
