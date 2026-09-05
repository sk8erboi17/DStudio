# Forma: application recipes

## Before markup
Write a one-sentence visual thesis and the user's primary action. Select a page topology based on information hierarchy, then bind this pack's tokens. Sketch a second topology if the user asks for alternatives; vary spatial hierarchy, not merely accent color.

## Primary recipe
12-column desktop grid with an 8/4 project split, oversized but clamped sans headline, flush-left captions and explicit project numbers. Stack at 760px while keeping project order.

## Adaptation
For a service use the same number/project rhythm for stages and deliverables. Use supplied photography when it exists; geometric studies are labelled as studies.

## Responsive and long content
At narrow widths reduce display type with clamp(), stack unequal columns in reading order and preserve labels/units. Use minmax(0,1fr), min-width:0 and overflow-wrap for user text. Tabular data may have a labelled local horizontal scroll region; never hide page overflow to mask layout defects. Test a long title and translated button text.

## Honest interaction
Loading: a progress element with a real value or an explicitly indeterminate state. Empty: explain what is missing and offer an implemented next action. Error: retain entered values, describe what happened, associate instructions with the control. Success: confirm only the action actually performed. Use native details and dialog where suitable; Escape closes, focus returns, primary actions remain named.

## Export
Copy the necessary CSS and JS beside the generated entry file and update relative paths. The sample's lab toolbar belongs only to the catalog; omit it from finished client work. No CDN, remote font, brand imitation or borrowed component package is required.
