# Manual: application recipes

## Before markup
Write a one-sentence visual thesis and the user's primary action. Choose a topology from the information hierarchy, then bind this pack's tokens. If alternatives are requested, vary spatial hierarchy and density, not only the accent color.

## Primary recipe
Top rule (product, version, search) → section rail with numbered sections and an announced match count → article: breadcrumb, numbered title, lead, numbered subsections with steps, a note set on a rule, a code panel (language tabs, a select-code action, status), ruled parameters and feedback → outline of the page with one primary action. Below 1180px the outline follows the article; below 820px the rail sits above it.

## Adaptation
For a changelog, sections become versions and the code panel shows the migration. For a help centre, the rail becomes topics and the outline becomes related articles.

## Responsive and long content
Code wraps instead of scrolling; parameters become stacks below 34em of width; the rail and the outline move around the article. Use minmax(0,1fr), min-width:0 and overflow-wrap for user text. Do not put content in horizontal scroll regions. Test a long title and translated button text at 320px and 200% text.

## Honest interaction
Loading: a progress element with a real value or an explicitly indeterminate state. Empty: explain what is missing and offer an implemented next action. Error: keep entered values, say what happened and associate guidance with the control. Success: confirm only what was actually done. Select-code and feedback confirm only what happened in the page.

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
