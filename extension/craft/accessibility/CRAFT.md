---
name: Accessibility baseline
description: Check rendered contrast, keyboard operation, focus, labels, targets and reflow; report coverage without claiming certification.
---

# CRAFT: accessibility baseline

Use this as a practical baseline, not WCAG certification. Automated checks cover
part of the work; operate controls and inspect actual rendered states.

## Contrast and meaning

Use at least 4.5:1 for ordinary text and 3:1 for large text (18pt, or 14pt bold).
Check required control boundaries and meaningful graphics at 3:1. Compute actual
resolved color pairs without rounding a failing ratio up. Thin fonts, images,
opacity and changing backgrounds require further inspection. Status and selection
need understandable words, shape or structure as well as hue.
See [W3C contrast guidance](https://www.w3.org/WAI/WCAG22/Understanding/contrast-minimum.html).

## Keyboard and focus

Use semantic links, buttons, inputs, tables and landmarks. Provide a clear main
heading and meaningful heading order. Every operation has a keyboard path;
spatial editors also expose equivalent position/list controls. Focus remains
visible and unobscured. Opening a dialog moves focus inside; Escape/cancel closes
it where appropriate and returns focus to a useful surviving control. Deleting
or filtering a focused item must leave a usable destination.

## Labels and updates

Associate each input with a visible label, errors and instructions. Name icon
buttons; give content images meaningful alt text and decorative images empty alt.
Group related choices. Announce consequential state changes without repeating
an entire stream or moving focus on every update. Keep user-entered text literal.

## Reflow and pointer targets

Verify 320 CSS-pixel width and 200% enlarged text, logical reading order and no
page clipping. A data table, map or editor may need a labelled local two-dimensional
region with an equivalent usable path; explain the exception, do not hide overflow.
See [W3C reflow guidance](https://www.w3.org/WAI/WCAG22/Understanding/reflow.html).

Prefer roomy primary controls, around 44px. The minimum target criterion uses
24 CSS pixels or qualifying spacing/exceptions; do not claim every smaller inline
link fails automatically. Inspect real hit areas and adjacent controls.
See [W3C target-size guidance](https://www.w3.org/WAI/WCAG22/Understanding/target-size-minimum.html).

## Before delivery

Operate the export with keyboard, both themes and enlarged text. Check dialog
focus return, error recovery, selected/disabled states and reduced motion.
Record manual, automated and not-run checks separately; declarations and ARIA
attributes alone do not establish accessible behavior.
