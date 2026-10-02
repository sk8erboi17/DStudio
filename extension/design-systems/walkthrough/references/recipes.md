# Walkthrough: application recipes

## Before markup
Write a one-sentence visual thesis and the user's primary action. Choose a topology from the information hierarchy, then bind this pack's tokens. If alternatives are requested, vary spatial hierarchy and density, not only the accent color.

## Primary recipe
Top line (name and three anchors) → hero: eyebrow, a large headline with a concrete promise, one sentence, one primary action and a text link → tour: numbered step buttons and a detail with Next step, beside a product view drawn in solid fills whose regions take an outline and a numbered pin → plans as ruled rows → questions → a solid closing band repeating the same action. Below 900px the product view follows the steps.

## Adaptation
For a single-feature launch, keep two or three steps. For an internal tool, the plans become access levels and the band becomes a request form.

## Responsive and long content
The product view follows the steps below 900px and its sidebar becomes a row below 30em; plan rows stack. Use minmax(0,1fr), min-width:0 and overflow-wrap for user text; give every single-column grid an explicit minmax(0,1fr) track. Do not put content in horizontal scroll regions. Test a long title and translated button text at 320px and 200% text.

## Honest interaction
Loading: a progress element with a real value or an explicitly indeterminate state. Empty: explain what is missing and offer an implemented next action. Error: keep entered values, say what happened and associate guidance with the control. Success: confirm only what was actually done. The tour changes only the drawing; trial actions confirm nothing beyond the preview.

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
