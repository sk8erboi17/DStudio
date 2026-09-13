# Canvas: application recipes

## Primary composition

Use a compact document header, a narrow tool rail, a large artboard and a selected-object inspector. At tablet widths put the inspector below; on phones put tools above the artboard. Avoid a landing-page hero inside a working editor.

## Different second brief

An object editor prioritizes selection and precise position fields. A creative workspace may use layers and history as a secondary column, keeping one main working surface. Include only tools that actually change the artifact.

## Observable behavior

The example adds, selects, renames, moves and deletes local objects. Pointer dragging and arrow keys complement numeric position fields. Undo/redo covers committed object changes, not selection-only navigation. At most 12 objects and 30 history states are kept; nothing persists or uploads.

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
