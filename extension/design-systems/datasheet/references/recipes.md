# Datasheet: application recipes

## Before markup
Write a one-sentence visual thesis and the user's primary action. Choose a topology from the information hierarchy, then bind this pack's tokens. If alternatives are requested, vary spatial hierarchy and density, not only the accent color.

## Primary recipe
Signal strip (product, document number and revision, example label) → hero: eyebrow, the name set huge, a two-sentence claim, one primary action and a text link → numbered sections, each a label column and a content column: 01 specification rows, 02 before/after table, 03 plans as table rows with a billing choice and a note about tax. No illustrations, no feature cards, no testimonials. Below 900px each section stacks; tables become labelled stacks by container width.

## Adaptation
For an API product, specification rows become limits and endpoints. For hardware, the before/after table becomes dimensions and tolerances.

## Responsive and long content
Sections stack below 900px; specification, before/after and plan rows become labelled stacks by container width; the name scales down but stays the largest element. Use minmax(0,1fr), min-width:0 and overflow-wrap for user text; give every single-column grid an explicit minmax(0,1fr) track. Do not put content in horizontal scroll regions. Test a long title and translated button text at 320px and 200% text.

## Honest interaction
Loading: a progress element with a real value or an explicitly indeterminate state. Empty: explain what is missing and offer an implemented next action. Error: keep entered values, say what happened and associate guidance with the control. Success: confirm only what was actually done. Plan changes and the demo request confirm only what happened in the preview.

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
