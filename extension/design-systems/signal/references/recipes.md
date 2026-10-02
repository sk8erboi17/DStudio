# Signal: application recipes

## Before markup
Write a one-sentence visual thesis and the user's primary action. Choose a topology from the information hierarchy, then bind this pack's tokens. If alternatives are requested, vary spatial hierarchy and density, not only the accent color.

## Primary recipe
Top rule (product, breadcrumb, sync time) → rail and main. Main: heading → up to four readings on a ruled strip → queue with filter beside an inspector → activity log. Use rules and alignment, not cards; the row title selects the row; one primary action lives in the inspector. Below 1180px the inspector follows the queue; below 900px the rail wraps above and rows become labelled stacks.

## Adaptation
For a settings tool, the queue becomes grouped key-value rows. For monitoring, keep readings with units and a timestamped log; draw a chart only when it answers a stated question.

## Responsive and long content
Rows reflow into stacks with ID and state first; the rail wraps into a row. Keep numerals tabular. Use minmax(0,1fr), min-width:0 and overflow-wrap for user text. Do not put content in horizontal scroll regions; reflow rows into labelled stacks instead. Test a long title and translated button text at 320px and 200% text.

## Honest interaction
Loading: a progress element with a real value or an explicitly indeterminate state. Empty: explain what is missing and offer an implemented next action. Error: keep entered values, say what happened and associate guidance with the control. Success: confirm only what was actually done. A filter always states how many items match.

## Export
Copy the needed CSS and JS beside the generated entry file and update relative paths. The lab toolbar belongs to the catalog only; omit it from client work. No CDN, remote font, brand imitation or borrowed component package is required.

## Turn this recipe into a project

Treat the supplied layout and breakpoints as examples. First identify the primary
operation and choose a reading/action order for this brief; remove sample identity
and irrelevant lab controls. For a second direction, change the topology, density
or type roles in response to a different need, while keeping the system's thesis.

Use the state-coverage design-plan reference to map each visible action to its
validated change and observable result. Include invalid input, no results, Back,
cancellation and repeated use where applicable. Keep user text literal and name
what survives a reload. Test the resulting local export with network unavailable,
then record actual findings and remaining gaps; the recipe is not a test receipt.
