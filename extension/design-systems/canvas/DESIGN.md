---
name: Canvas
description: An object workspace with a central artboard, explicit tools, selection, inspector and bounded undo history.
modes: [design]
ds4_category: creative-workspace
ds4_local_mode: native
ds4_output_kinds: html
ds4_upstream: dstudio-original/canvas
---
# Canvas — original DStudio system, version 1

## Visual thesis

The work is the center. Compact chrome frames an editable artboard; tools and an inspector explain what can change without competing with the composition.

Best fit: Object editors, creative workspaces, diagram tools and visual arrangement prototypes.

## Load before building

Read `tokens.css`, `components.html`, `assets/preview.js` and
`references/recipes.md` with `pack_file(type="design_system", name="canvas", path="…")`.
These are original local assets, not an external framework or service.

## Compose, do not clone

Use a compact document header, a narrow tool rail, a large artboard and a selected-object inspector. At tablet widths put the inspector below; on phones put tools above the artboard. Avoid a landing-page hero inside a working editor.

An object editor prioritizes selection and precise position fields. A creative workspace may use layers and history as a secondary column, keeping one main working surface. Include only tools that actually change the artifact.

Derive structure and interactions from the brief. Do not copy the fictional
preview identity into a deliverable. Explicit user choices take precedence.

## Tokens and typography

`tokens.css` owns coordinated light and dark semantic roles. Display uses
"Helvetica Neue", Arial, sans-serif; body uses "Helvetica Neue", Arial, sans-serif. Local fallback fonts are not
bundled brand fonts. Preserve readable contrast, named controls and visible focus.

## Interaction and ownership

The example adds, selects, renames, moves and deletes local objects. Pointer dragging and arrow keys complement numeric position fields. Undo/redo covers committed object changes, not selection-only navigation. At most 12 objects and 30 history states are kept; nothing persists or uploads.

State belongs to this document and is lost on reload. Keep preparation separate
from committed edits; cancelled interaction must not change the previous result.
Use text nodes for user labels, never HTML. Implement actual persistence and
external actions separately when the brief requires them, with honest receipts.

## Acceptance and export

Test 320/390/768/1440 px, light/dark, 200% text, keyboard, form validation,
selection, empty state, dialog Escape/focus return and every domain control.
Radio/checkbox labels retain a separate indicator column. Never clip page text
to hide overflow. Spatial views require equivalent keyboard-operable controls.

Copy local CSS and JS alongside the exported HTML and use relative links.
Remove the catalog toolbar. No DStudio API, CDN, remote fonts or data service is
required. Static preview tests are not evidence of model-generated quality.
