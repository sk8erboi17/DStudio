# Roster: application recipes

## Before markup
Write a one-sentence visual thesis and the user's primary action. Choose a topology from the information hierarchy, then bind this pack's tokens. If alternatives are requested, vary spatial hierarchy and density, not only the accent color.

## Primary recipe
Masthead (team, period, a written summary of gaps, one primary publish action) → the week: header row, one row per person (name and role, seven cells, hours against contract), a cover row with counts per shift → below: the selected cell with shift radios, the rule that applies and a status line, beside leave requests with approve and decline text actions. Below 58em of grid width each person becomes a block of labelled day cells.

## Adaptation
For room booking, people become rooms and shifts become bookings. For a single person, the grid becomes a list of days with the same blocks.

## Responsive and long content
Below 58em of width each person becomes a block of labelled day cells; the cover row does the same. Use minmax(0,1fr), min-width:0 and overflow-wrap for user text; give every single-column grid an explicit minmax(0,1fr) track. Do not put content in horizontal scroll regions. Test a long title and translated button text at 320px and 200% text.

## Honest interaction
Loading: a progress element with a real value or an explicitly indeterminate state. Empty: explain what is missing and offer an implemented next action. Error: keep entered values, say what happened and associate guidance with the control. Success: confirm only what was actually done. Shift changes and leave decisions confirm only a draft change in the preview.

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
