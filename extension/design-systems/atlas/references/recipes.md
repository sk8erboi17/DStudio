# Atlas: application recipes

## Primary composition

Give the map and place list equal importance, with a concise trip header and an itinerary below. Show the selected place in both views. Stack map, list and route on mobile, preserving a complete list alternative to map interaction.

## Different second brief

For a directory, emphasize filters and detailed place cards; keep the map as context. For an itinerary builder, emphasize route order and remove/reorder controls. A museum guide can use floor-plan coordinates without pretending they are geographic.

## Observable behavior

Four fictional places on a schematic map share selection with the list. Filtering never removes an existing route stop. The local itinerary contains each place at most once, supports move/remove/reset, and draws its selected order. Coordinates and walking times are illustrative, not navigation advice.

Keep one owner for selection and edited data; derive all representations from it.
Validate finite coordinates and bounded input before publication. Discard cancelled
private candidates. History has explicit count/byte bounds and no external effects.

## Reflow and input

Let text and controls grow independently of the viewport. Use shrinkable grid
children, visible labels and logical reading order. Stack side panels at narrow
widths. Do not hide overflowing page text. Operate every pointer action using a
keyboard alternative too; return focus after closing a dialog or removing an item.
Respect reduced motion and confirm only effects actually committed.

## Export and quality

Copy required dependencies beside the HTML and update relative paths. Omit the
catalog-only controls and fictional sample identity. Run the exported project
without DStudio or network. Inspect generated output visually and operate controls;
if a benchmark artifact is defective, let the Agent revise or regenerate it.
Never manually repair the HTML and describe it as model output.
