---
name: data-table
description: A serious data table — sortable, filterable, paginated, with row selection, bulk actions, sticky header, and every state (loading/empty/error/dense) rendered.
modes: [design]
when_to_use: The user wants a data table, grid, list view, records/admin table, or "a table of <things>" with real interaction.
ds4_category: data-visualization
ds4_local_mode: native
ds4_output_kinds: html
ds4_upstream: dstudio/data-table
---

# SKILL: data-table

A real table is a small application. The default AI table (10 static rows, no states) is
useless. Build the controls, the interactions, and the states — that's the whole point.

## Anatomy

- **Toolbar** above the table: a search/filter input, filter chips/dropdowns, a column
  visibility control, and a primary action ("Add"). When rows are selected, the toolbar
  swaps to a **bulk-action bar** (N selected · Delete · Export · …).
- **Header row**: sticky on scroll, sortable columns (click to sort, show ▲/▼ on the active
  one, only one sort at a time by default), a select-all checkbox.
- **Body rows**: a leading checkbox, then cells. **Right-align numbers**, left-align text,
  one row height, hairline or zebra rows (not both), row hover, row actions (a trailing "…"
  menu or inline buttons revealed on hover).
- **Cell types** done right: status as a colored pill/dot+label, money right-aligned and
  formatted, dates relative or ISO, avatars+name, truncation with a tooltip for long text,
  numeric badges.
- **Footer**: pagination (page size + prev/next + range "1-20 of 248") or a row count.

## Interactions

Sort (header click), filter (toolbar), search, select (row + select-all + indeterminate
state), bulk actions, row action menu, pagination, column show/hide. Make them feel real.

## States (the deliverable)

- **Loading**: skeleton rows (shimmer), not a blank spinner.
- **Empty**: a real first-run message + the primary action ("No invoices yet — create one").
- **No results** (after filtering): "No rows match these filters" + a clear-filters action.
- **Error**: inline, scoped to the table, with retry.
- **Populated**: realistic, varied data — long names, big numbers, every status, a few edge
  values that test truncation and alignment. Never "Row 1 / Row 2".
- **Selected**: rows highlighted + the bulk bar; **partial select** = indeterminate checkbox.

## Self-check before artifact (fix anything < 3/5)

- **Real controls**: sort + filter + search + pagination + selection actually present?
- **States**: loading / empty / no-results / error rendered, not just populated?
- **Cell craft**: numbers right-aligned + formatted, status as pills, truncation handled?
- **Bulk flow**: selecting rows surfaces bulk actions with a count?
- **Data realism**: varied, plausible, alignment-stressing data?

Gate: contrast ≥4.5:1 (incl. status pills), sticky header, keyboard-reachable controls,
table degrades to cards/stacked at 390, no placeholder rows.
