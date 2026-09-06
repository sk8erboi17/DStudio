# Grove: application recipes

## Before markup
Write a one-sentence visual thesis and the user's primary action. Select a page topology based on information hierarchy, then bind this pack's tokens. Sketch a second topology if the user asks for alternatives; vary spatial hierarchy, not merely accent color.

## Primary recipe
A generous 55/45 welcome and action split, a single dominant next action and concise helper text. Stack the action first after the introduction on mobile. Forms remain single-column.

## Adaptation
For complex tasks split the form into named steps with a review stage. For destructive actions describe consequences and provide undo only when the operation is genuinely reversible.

## Responsive and long content
At narrow widths reduce display type with clamp(), stack unequal columns in reading order and preserve labels/units. Use minmax(0,1fr), min-width:0 and overflow-wrap for user text. Tabular data may have a labelled local horizontal scroll region; never hide page overflow to mask layout defects. Test a long title and translated button text.

## Honest interaction
Loading: a progress element with a real value or an explicitly indeterminate state. Empty: explain what is missing and offer an implemented next action. Error: retain entered values, describe what happened, associate instructions with the control. Success: confirm only the action actually performed. Use native details and dialog where suitable; Escape closes, focus returns, primary actions remain named.

## Export
Copy the necessary CSS and JS beside the generated entry file and update relative paths. The sample's lab toolbar belongs only to the catalog; omit it from finished client work. No CDN, remote font, brand imitation or borrowed component package is required.
