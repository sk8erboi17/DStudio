---
name: Atlas
description: A map-and-list workspace for finding places and composing an itinerary, with a fully local schematic map.
modes: [design]
ds4_category: places
ds4_local_mode: native
ds4_output_kinds: html
ds4_upstream: dstudio-original/atlas
---
# Atlas — original DStudio system, version 1

## Visual thesis

Move between spatial context and a readable list without losing the current place. An illustrated map, compact field notes and an editable route share one selection.

Best fit: Place directories, exhibition guides, campus information and itinerary prototypes.

## Load before building

Read `tokens.css`, `components.html`, `assets/preview.js` and
`references/recipes.md` with `pack_file(type="design_system", name="atlas", path="…")`.
These are original local assets, not an external framework or service.

## Compose, do not clone

Give the map and place list equal importance, with a concise trip header and an itinerary below. Show the selected place in both views. Stack map, list and route on mobile, preserving a complete list alternative to map interaction.

For a directory, emphasize filters and detailed place cards; keep the map as context. For an itinerary builder, emphasize route order and remove/reorder controls. A museum guide can use floor-plan coordinates without pretending they are geographic.

Derive structure and interactions from the brief. Do not copy the fictional
preview identity into a deliverable. Explicit user choices take precedence.

## Tokens and typography

`tokens.css` owns coordinated light and dark semantic roles. Display uses
Georgia, "Times New Roman", serif; body uses "Helvetica Neue", Arial, sans-serif. Local fallback fonts are not
bundled brand fonts. Preserve readable contrast, named controls and visible focus.

## Interaction and ownership

Four fictional places on a schematic map share selection with the list. Filtering never removes an existing route stop. The local itinerary contains each place at most once, supports move/remove/reset, and draws its selected order. Coordinates and walking times are illustrative, not navigation advice.

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
