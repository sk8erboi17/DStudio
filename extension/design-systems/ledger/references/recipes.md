# Ledger: application recipes

## Before markup
Write a one-sentence visual thesis and the user's primary action. Choose a topology from the information hierarchy, then bind this pack's tokens. If alternatives are requested, vary spatial hierarchy and density, not only the accent color.

## Primary recipe
Masthead (title, an honest note about where figures come from) beside a statement: brought forward, in, out and a double-ruled carried-forward total → entries with a category filter, an announced count and one primary action → ruled ledger rows (date, payee, category, out, in, running balance, reconcile tick) → side column with the cleared balance and envelopes. No cards: rules, columns and figures do the work. Below 1100px the side column follows the entries; below 44em of container width a row becomes a stack with a signed amount.

## Adaptation
For invoices the book becomes line items (quantity, unit, amount) and the statement becomes subtotal, tax and a double-ruled total. For budgets the envelopes lead and the book follows.

## Responsive and long content
Rows reflow into stacks with payee, signed amount and balance first; the statement drops under the title. Keep figures tabular and right-aligned in every layout. Use minmax(0,1fr), min-width:0 and overflow-wrap for user text. Do not put content in horizontal scroll regions. Test a long title and translated button text at 320px and 200% text.

## Honest interaction
Loading: a progress element with a real value or an explicitly indeterminate state. Empty: explain what is missing and offer an implemented next action. Error: keep entered values, say what happened and associate guidance with the control. Success: confirm only what was actually done. A reconcile tick changes only the local preview and says so; a filter always states how many entries match.

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
