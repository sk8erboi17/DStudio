# Transit: application recipes

## Before markup
Write a one-sentence visual thesis and the user's primary action. Choose a topology from the information hierarchy, then bind this pack's tokens. If alternatives are requested, vary spatial hierarchy and density, not only the accent color.

## Primary recipe
Signage band (product, what the data is) → planner: the route as the title, From, swap, To, departure time and a search action → departure rows (the time is the control, named line badges, arrival and duration, platform sign, a shaped state) beside the selected journey (time range, legs drawn on line-colored rails, changes in words, ticket radios, total and one primary action). Below 1000px the journey follows the rows; below 36em of list width rows become stacks.

## Adaptation
For a departures screen, drop the planner and let the rows lead. For ticketing, the drawn journey becomes the order summary.

## Responsive and long content
Rows stack with time and state first; line badges wrap; the drawn journey keeps time, rail and text columns at every width. Use minmax(0,1fr), min-width:0 and overflow-wrap for user text. Do not put content in horizontal scroll regions. Test a long title and translated button text at 320px and 200% text.

## Honest interaction
Loading: a progress element with a real value or an explicitly indeterminate state. Empty: explain what is missing and offer an implemented next action. Error: keep entered values, say what happened and associate guidance with the control. Success: confirm only what was actually done. Search results say they are examples; holding a journey books nothing.

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
