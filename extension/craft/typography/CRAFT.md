---
name: Typography
description: A small type scale, three weights, a readable measure and real hierarchy. System-safe stacks (no web font you can't load). Type does most of the design work.
---

# CRAFT: typography

Most of "good design" is typography done with discipline. A clear scale, restrained weights,
a comfortable measure, and real hierarchy carry the page before any color or layout.

## Scale & weights

- **One modular scale** (×1.2–1.25), **≤6 sizes** total, ≤3 above the fold. Don't free-style
  font sizes.
- **Three weights max**: ~400 body, ~500–550 labels/UI, ~600 headings. If everything is bold,
  nothing is. (Note: variable weights like 590 only exist if that variable font is loaded —
  on a system fallback they round to 600. Don't rely on fractional weights you can't load.)
- Tighten tracking slightly on large headings (`-0.01em…-0.02em`); leave body at normal.

## Readability

- **Measure 60–75 characters** per line for body text (~`max-width: 68ch`). Wider tires the
  eye; narrower is choppy.
- **Body ≥ 16px**, line-height 1.5–1.7 for prose, ~1.1–1.2 for big headings.
- **Left-align body** (don't justify — rivers; don't center long paragraphs). Fluid sizing
  with `clamp()` for responsive headings.

## Fonts (system-safe)

- The deliverable runs offline with no external requests, so **don't depend on a web font you
  can't load**. Lead with a real font name only if you also give a correct system fallback
  stack — and don't tune metrics (weights, tracking) to a font that won't be present.
- Web-safe pairings: a clean sans for UI/body (`-apple-system, Inter, system-ui`), an
  optional serif (`Georgia, "Times New Roman"`) for editorial headings/quotes; mono
  (`ui-monospace, "SF Mono"`) for code/data.

## Hierarchy

- Establish hierarchy with **size + weight + space**, not boxes and borders. One clear
  first-glance landing point per screen.
- Labels/eyebrows: smaller, uppercase, letter-spaced, muted — but still legible (contrast).
- Numbers in tables: tabular figures, right-aligned.

## Self-check before artifact

- ≤6 sizes on one scale, ≤3 weights, headings tracked tighter?
- Body ≥16px, measure 60–75ch, left-aligned, good line-height?
- No dependence on an unloadable web font / fractional weight?
- Hierarchy from type+space (clear first-glance point), labels legible?
