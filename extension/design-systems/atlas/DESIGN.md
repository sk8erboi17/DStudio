---
name: Atlas
description: Map and list as one object: map paper, cartographic magenta, numbered pins, matching cards and an editable route.
modes: [design]
ds4_category: places
ds4_local_mode: native
ds4_output_kinds: html
ds4_upstream: dstudio-original/atlas
---
# Atlas — original DStudio system, version 2

## Visual thesis
Move between spatial context and a readable list without losing the current place. A schematic map with numbered pins, place cards and a reorderable route share one selection.

Best fit: Place directories, exhibition and campus guides, itineraries and visitor information.

## Load before building
Read `tokens.css`, `components.html`, `assets/preview.js` and `references/recipes.md` using `pack_file(type="design_system", name="atlas", path="…")`. These are local authored assets, not an external template or framework. The preview uses example content, not real customers, metrics, transactions or availability.

## Fit the brief

Identify the audience, the primary action and the source of each factual claim.
Preserve explicit user copy, colors, fonts and supplied assets. The composition
below is a starting point: adapt its density, order and proportions to the task.
Record consequential missing decisions; do not invent customers, results or services.
Use only the relevant craft guidance, starting with `craft("state-coverage")`.
Its `references/design-plan.md` provides the short plan and action/result checklist.

## Compose, do not clone
Header with a type filter → sticky map (7 columns) beside the place directory, with the route under it. Directory and route are ruled lists, not cards: the place name selects it on the map, one text action adds it, and stops reorder with ↑ ↓ ×. Below 980px: map, route, then list.

The reference is a worked example, not a universal layout. Keep the thesis and derive content order from the user's task. Never copy the example identity (Slow Walks and its four places) into a deliverable. Two unrelated briefs must not become the same skeleton with different text.

## Tokens and typography
`tokens.css` is the executable source of truth. Bind --bg, --surface, --surface-2, --fg, --muted, --border, --border-strong, --accent, --accent-hover and --on-accent; use --success/--danger with a textual label. `--land`, `--water`, `--park`, `--street` and `--block` paint the schematic map in both appearances; the route is `--accent`. Light and dark palettes are coordinated, not inverted. Measure the actual rendered foreground/background pairs in every offered theme; a token value or color notation does not prove contrast. Display: "DIN Alternate", Bahnschrift, "Avenir Next", "Segoe UI", system-ui. Body: "Avenir Next", "Segoe UI", system-ui; notes in a monospace stack. All stacks work offline; actual glyphs depend on installed fonts. Never claim a fallback is a supplied brand font. Explicit user typography wins.

## Signature components
`.atlas-map` (SVG base plus HTML pins), `.map-pin` with `aria-pressed`, `.map-label`, `.map-scale`, `.map-north`, `.legend`, `.place-list` + `.place-row[data-selected]` (number, `.place-name` button, `.add-stop`), `.route-list` + `.route-stop` with `.route-tools`, `.link-btn`.

## States and honesty
Copy only the components the brief needs. The component view demonstrates primary/secondary/disabled buttons, labelled inputs, an inline error, empty/loading/success states, disclosure and a keyboard-dismissible dialog that returns focus. Keep :focus-visible, 44px targets where practical, reduced motion and reflow at 320px and 200% text. Never express state by color alone. The map is schematic: no live directions, distances or opening hours unless supplied. Visit times are illustrative.

Prototype interactions must say they are local previews; wire real operations only when they are implemented. A successful animation is not proof that an action succeeded. Copy referenced CSS/JS into the generated project with relative links: an export must not depend on DStudio API URLs. Do not place text over gradients or background images.

## Avoid
Card stacks for places, two bordered buttons per place, embedded tile maps or remote map APIs, pins without list equivalents, color-only categories and SVG text that cannot reflow.

## Behavior contract

Map, place list, selected detail and ordered itinerary derive from the same place identities. Reordering preserves membership and selection; a schematic cannot claim live routing.

Separate editable drafts from committed state. Define each action's input,
validation, owner, visible result and failure/cancellation behavior in the plan.
Derived views must share the committed data; never let a progress animation or
model self-review stand in for a saved result. Keep queues, retained input and
history bounded. In a preview, state belongs to this document and reload resets it;
production persistence and external effects require their own implemented contract.

## Acceptance
Render at 390, 768 and 1440px in both appearances; check 320px and 200% text for overflow and clipping. Operate every control with the keyboard; Escape closes dialogs and focus returns. Measure contrast on rendered pairs. Exercise loading/error/empty/success with real behavior or a clearly labelled demo state. Select from the map and from the list, add, reorder and remove stops, filter without losing the route, and reset. A passing preview is not a claim about generated model quality.

After checking the exported files, report what was exercised, what remains
unverified and the actual saved entry path. Recheck affected controls and layouts
after any HTML, CSS or JavaScript repair; do not infer a pass from unchanged markup.
