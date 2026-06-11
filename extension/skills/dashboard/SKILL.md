---
name: dashboard
description: A data UI — KPIs, tables, charts and filters — where density, scannability and real states matter more than decoration.
modes: [design]
when_to_use: The user wants a dashboard, admin panel, analytics view, console, or any data-dense internal tool.
ds4_category: general
ds4_local_mode: reference
ds4_output_kinds: html
ds4_upstream: dstudio/dashboard
---

# SKILL: dashboard

You are designing for someone who looks at this **every day**. Clarity and density win;
marketing flourish loses. The user should find the one number they came for in under a
second.

## Shape

- **App shell**: a slim sidebar or top nav (sections, not 20 links), a header with the
  view title + global actions (date range, search, account), then the content area.
- **KPI row**: 3–5 headline metrics at the top. Each = big number + label + a delta
  (▲/▼ with color) + optional sparkline. This is the first-glance layer.
- **Primary panel**: the main chart or table the view exists for. Give it the most space.
- **Secondary panels**: supporting breakdowns in a grid below — never more than the eye
  can hold (≤6).
- **Tables**: right-align numbers, left-align text, one row height, zebra or hairline
  rows (not both), sticky header, a clear sort affordance, row hover.

## Charts without libraries

No external chart libs (no CDN). Render with **inline SVG** or CSS:
- Line/area: a single `<svg>` `<path>` with a gradient fill under it.
- Bar: flex column of `<div>`s with `height:%`, or SVG `<rect>`s.
- Sparkline: a tiny inline SVG polyline.
- Donut/gauge: SVG `<circle>` with `stroke-dasharray`.
Keep axes minimal: label the extremes, not every tick. Data ink over chart junk.

## States are the deliverable, not a nicety

Render all of these for the main table/panel — a dashboard is mostly *not* the happy path:
- **Loading**: skeleton rows / shimmer, not a spinner-on-blank.
- **Empty**: a real first-run message + the one action to populate it.
- **Error**: what failed + retry, scoped to the panel (don't blank the whole view).
- **Populated**: realistic data — varied names, plausible numbers, a few long values that
  test truncation. Never `Item 1 / Item 2`.
- **Edge**: a huge number, a negative delta, a 40-char label — show they don't break.

## Density & color

- Tighter type scale than marketing (×1.15–1.2), body 13–15px, generous but not airy.
- Neutrals dominate; the accent marks *only* primary actions and active nav. Semantic
  colors (green/amber/red) are reserved for status/deltas — don't spend them on chrome.
- Dark mode reads well here; if dark, keep surfaces layered (bg < surface < card) so
  panels separate without borders everywhere.

## Self-check before artifact (fix anything < 3/5)

- **Scannability**: is the headline metric findable in <1s?
- **States**: are loading / empty / error actually rendered, not just populated?
- **Hierarchy**: KPIs > primary panel > secondary — clear weight order?
- **Data realism**: varied, plausible data that stress-tests layout?
- **Restraint**: accent only on actions/active; semantic colors only on status?

Gate: contrast ≥4.5:1 (incl. on colored cells), tap ≥44px, no horizontal scroll on the
main view at 1280, table degrades to cards at 390.
