---
name: State coverage
description: A design that only shows the happy path is half-built. Render loading, empty, error, populated and edge states — for every data-driven surface.
---

# CRAFT: state coverage

Most of a real product is *not* the happy path. A screen that only shows full, perfect data
is a render, not a design. Cover the states that actually happen.

## The five states (for every data-driven surface)

1. **Loading** — skeletons that match the final layout (shimmer), not a spinner on blank.
   Don't reflow when data arrives.
2. **Empty** — a real first-run message + the **one action** that fills it ("No invoices yet
   — create your first"). Never a blank panel.
3. **Error** — what failed, in plain language, + a **retry**, scoped to the affected region
   (don't blank the whole screen for one panel's failure). No leaking internals.
4. **Populated** — realistic, **varied** data: long names, big numbers, every status, a few
   edge values that stress truncation and alignment. Never "Item 1 / Item 2".
5. **Edge** — the cases that break naive layouts: a 40-char unbroken string, a huge number, a
   negative/zero value, a list of 1 and of 100, a missing optional field.

## Interaction states

Every interactive element needs **default / hover / focus / active / disabled** — and where
relevant **selected** and **indeterminate** (checkboxes, partial selection). Focus must be
visible (see accessibility). Disabled must look disabled and not be focusable as if active.

## Forms & async

- Validation states **per field** (default / focus / error / success), inline, on blur and
  on submit — not a single generic banner.
- Async actions: the trigger shows **in-progress** (and disables to prevent double-submit),
  then **success** or **error**. Never a dead button that gives no feedback.

## Self-check before artifact

- Did I render loading / empty / error — or only populated?
- Is the populated data varied and edge-tested (long strings, big numbers, 1 vs many)?
- Do interactive elements have hover / focus / active / disabled?
- Do forms show per-field validation, and async actions show progress → result?
