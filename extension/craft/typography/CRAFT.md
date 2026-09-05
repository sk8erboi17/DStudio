---
name: Typography
description: Readable hierarchy, deliberate display type and responsive text. Use available fonts and derive the scale from the content, not a size quota.
---

# CRAFT: typography

Most of "good design" is typography done with discipline. A clear scale, restrained weights,
a comfortable measure, and real hierarchy carry the page before any color or layout.

## Scale & weights

- Define roles first: display, section heading, body, label and metadata. Reuse
  each role consistently. A modular scale is a useful starting point, not a quota
  that should flatten a poster or make a dense table enormous.
- Use weights the actual font supplies; make emphasis selective. Fractional
  variable weights only work when that variable font is available. Check the
  rendered fallback instead of assuming it has identical metrics.
- Adjust display tracking for the chosen face; leave prose at a readable default.
  Do not force condensed, serif and humanist faces into the same treatment.

## Readability

- **Measure 60–75 characters** per line for body text (~`max-width: 68ch`). Wider tires the
  eye; narrower is choppy.
- **Body ≥ 16px**, line-height 1.5–1.7 for prose, ~1.1–1.2 for big headings.
- **Left-align body** (don't justify — rivers; don't center long paragraphs).
  Use rem/em for text and fluid headings with a relative minimum. Test 200% text
  scaling independently of viewport width. Allow grid children to shrink and
  long words to wrap without hiding overflow; labels and controls must still work.

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

- Consistent roles, intentional emphasis and display type appropriate to the task?
- Body ≥16px, measure 60–75ch, left-aligned, good line-height?
- No dependence on an unloadable web font / fractional weight?
- Hierarchy from type+space (clear first-glance point), labels legible?
- Enlarged text reflows at mobile width; no clipped words, overlapping controls
  or fixed-height containers hiding content?
