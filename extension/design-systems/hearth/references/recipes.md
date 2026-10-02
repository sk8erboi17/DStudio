# Hearth: application recipes

## Before markup
Write a one-sentence visual thesis and the user's primary action. Choose a topology from the information hierarchy, then bind this pack's tokens. If alternatives are requested, vary spatial hierarchy and density, not only the accent color.

## Primary recipe
Masthead (home, an honest note that nothing is connected) → rooms as text tabs → devices as ruled rows (name in the slab serif, state in words, a switch that says On or Off, brightness when a light is on) beside heating (one dial: current reading, target and unit; a stepper that explains its limits) and scenes as radios with a short description, then one primary action. No tile grid and no card per device. Below 960px the climate column follows the devices.

## Adaptation
For a single device, drop the rooms and keep one device list and the dial. For energy, the dial becomes a reading with units beside a dated log.

## Responsive and long content
Rooms wrap; device rows keep name and switch on one line with brightness below; the dial shrinks with its column. Use minmax(0,1fr), min-width:0 and overflow-wrap for user text. Do not put content in horizontal scroll regions. Test a long title and translated button text at 320px and 200% text.

## Honest interaction
Loading: a progress element with a real value or an explicitly indeterminate state. Empty: explain what is missing and offer an implemented next action. Error: keep entered values, say what happened and associate guidance with the control. Success: confirm only what was actually done. Every control confirms only a local change and says that no device was contacted.

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
