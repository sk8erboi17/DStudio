---
name: Material
description: Google Material — elevation and tactile surfaces, a bold key color with tonal variants, Roboto, FAB and ripples. Structured, accessible, productive.
---

# DESIGN SYSTEM: Material

Tangible surfaces with depth. A strong key color carries identity; elevation (shadows)
expresses hierarchy and interaction. Structured, consistent, accessible by default.

## Color (OKLch — light canonical, dark first-class)

- `--bg: oklch(0.98 0.004 250)`        /* surface dim */
- `--surface: oklch(1 0 0)`            /* card surface */
- `--surface-2: oklch(0.96 0.01 270)`  /* surface container */
- `--border: oklch(0.90 0.01 270)`     /* outline variant */
- `--fg: oklch(0.20 0.01 270)`         /* on-surface */
- `--muted: oklch(0.48 0.012 270)`     /* on-surface variant */
- `--accent: oklch(0.50 0.18 275)`     /* primary key color (indigo/violet) */
- `--accent-c: oklch(0.95 0.04 275)`   /* primary container (tonal) */
- secondary/tertiary tonal colors allowed; semantic green/amber/red literal.

Dark: `--bg: oklch(0.18 0.01 270)`, surfaces step lighter with elevation, same key hue.

## Typography

- Stack: `"Roboto", "Inter", system-ui, sans-serif`. Material type scale.
- Display 36-57, headline 24-32, title 16-22, body 14-16, label 11-14. Weights 400/500.
- Labels on buttons/tabs are 500, slightly wider tracking. Sentence case.

## Spacing & layout

- 8px grid (4px for fine adjustments). Components have defined heights (button 40, input 56
  filled).
- Radius: medium-large and consistent — 12px cards, 8-20px buttons, full-round FAB and chips.
- **Elevation is the system**: tonal + shadow levels (0/1/3/6/8/12 dp). Raised cards, app
  bars, menus, dialogs each sit at a defined level. Depth, not borders.
- App bar (top), optional navigation rail/drawer, a **FAB** for the primary action.

## Components

- Buttons: filled (primary, key color), tonal (container), outlined, text — with **ripple**
  on press. FAB for the screen's primary action.
- Inputs: **filled** or **outlined** text fields with a floating label and a focus underline/
  outline in the key color, helper/error text below.
- Cards (elevated/filled/outlined), chips (assist/filter/input), switches, sliders, tabs
  with an active indicator, snackbars for feedback.

## Motion

- Emphasized easing, 200-300ms; ripples, shared-axis transitions, FAB morphs. Meaningful and
  responsive, never gratuitous. `prefers-reduced-motion` honored.

## Voice

Clear, helpful, neutral. Sentence case everywhere. Action labels are verbs ("Save", "Add").

## Anti-patterns (never)

Flat borderless cards with no elevation system, sharp corners, washed-out key color, ALL
CAPS body, more than one key color, ignoring touch-target sizes.
