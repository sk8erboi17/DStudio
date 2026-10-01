---
name: Depot
description: Shelf labels for a warehouse: concrete grey and label white, narrow capitals, bordered bin codes, big quantities, levels with the reorder point drawn on the bar and a bin card for adjustments.
modes: [design]
ds4_category: operations
ds4_local_mode: native
ds4_output_kinds: html
ds4_upstream: dstudio-original/depot
---
# Depot — original DStudio system, version 1

## Visual thesis
Stock you can read from the end of an aisle. Ruled item rows carry SKU, name, a printed bin label, a large on-hand figure and a level bar with the reorder point marked; a bin card beside them owns adjustments and the movement log.

Best fit: Inventory and warehouse management, stock control, purchasing, small-business back offices and asset registers.

## Load before building
Read `tokens.css`, `components.html`, `assets/preview.js` and `references/recipes.md` using `pack_file(type="design_system", name="depot", path="…")`. These are local authored assets, not an external template or framework. The preview uses example content, not real customers, metrics, transactions or availability.

## Fit the brief

Identify the audience, the primary action and the source of each factual claim.
Preserve explicit user copy, colors, fonts and supplied assets. The composition
below is a starting point: adapt its density, order and proportions to the task.
Record consequential missing decisions; do not invent customers, results or services.
Use only the relevant craft guidance, starting with `craft("state-coverage")`.
Its `references/design-plan.md` provides the short plan and action/result checklist.

## Compose, do not clone
Masthead (warehouse, a secondary intake action) → tools (search, a low-stock filter, an announced count) → ruled item rows (SKU, name that opens the bin card, bin label, on-hand figure with unit, level bar with reorder tick and a shaped state) beside the bin card (facts, an adjustment form with an inline error and one primary action, movements). No tiles, no cards per item. Below 1100px the bin card follows the list; below 46em of list width rows become stacks.

The reference is a worked example, not a universal layout. Keep the thesis and derive content order from the user's task. Never copy the example identity (the main warehouse and its example SKUs) into a deliverable. Two unrelated briefs must not become the same skeleton with different text.

## Tokens and typography
`tokens.css` is the executable source of truth. Bind --bg, --surface, --surface-2, --fg, --muted, --border, --border-strong, --accent, --accent-hover and --on-accent; use --success/--danger with a textual label. `--warn` names low stock together with a triangle; out of stock uses `--danger` and a square. The accent is petrol in light and a light cyan in dark. Light and dark palettes are coordinated, not inverted. Measure the actual rendered foreground/background pairs in every offered theme; a token value or color notation does not prove contrast. Display and figures: "PT Sans Narrow", "Arial Narrow", "Roboto Condensed", "Helvetica Neue", sans-serif, in capitals. Body: "PT Sans", "Segoe UI", system-ui. Codes: "PT Mono", "SF Mono", ui-monospace, Menlo, Consolas. All stacks work offline; actual glyphs depend on installed fonts. Never claim a fallback is a supplied brand font. Explicit user typography wins.

## Signature components
`.bin`, a `.stock` container with `.stock-cols` and `.skus` of `.sku-row` (`.sku-code`, `.sku-open`, `.bin-cell`, `.qty`, `.level` with `.level-bar` and its reorder tick, `.stock-state[data-state=ok|low|out]`), `.facts` and `.moves`.

## States and honesty
Copy only the components the brief needs. The component view demonstrates primary/secondary/disabled buttons, labelled inputs, an inline error, empty/loading/success states, disclosure and a keyboard-dismissible dialog that returns focus. Keep :focus-visible, 44px targets where practical, reduced motion and reflow at 320px and 200% text. Never express state by color alone. Quantities are example values; an adjustment changes only the preview and says no stock system was changed. Stock cannot go below zero and the reason is written beside the field.

Prototype interactions must say they are local previews; wire real operations only when they are implemented. A successful animation is not proof that an action succeeded. Copy referenced CSS/JS into the generated project with relative links: an export must not depend on DStudio API URLs. Do not place text over gradients or background images.

## Avoid
KPI tiles, donut charts of stock value, a card per item, color-only states, editable quantities directly in the list, more than one primary action per view.

## Behavior contract

Stock changes, bin detail, movements and low/out filters derive from one item quantity. Reject invalid adjustments before mutation and preserve the previous amount/history; announce the actual applied delta.

The authored preview allows 0–999999 whole units and retains at most 32 movements
per bin, including the example history. Unsafe numbers, negative results or a
full history reject the adjustment without changing stock/history or clearing
the field. These are demonstration bounds; a real stock owner needs its own
tested admission, persistence and recovery rules.

Separate editable drafts from committed state. Define each action's input,
validation, owner, visible result and failure/cancellation behavior in the plan.
Derived views must share the committed data; never let a progress animation or
model self-review stand in for a saved result. Keep queues, retained input and
history bounded. In a preview, state belongs to this document and reload resets it;
production persistence and external effects require their own implemented contract.

## Acceptance
Render at 390, 768 and 1440px in both appearances; check 320px and 200% text for overflow and clipping. Operate every control with the keyboard; Escape closes dialogs and focus returns. Measure contrast on rendered pairs. Exercise loading/error/empty/success with real behavior or a clearly labelled demo state. Search to one item and to none; filter to low or out of stock; the count must be announced. Record an invalid and a valid adjustment; the row, state, bin card and movements must follow. A passing preview is not a claim about generated model quality.

After checking the exported files, report what was exercised, what remains
unverified and the actual saved entry path. Recheck affected controls and layouts
after any HTML, CSS or JavaScript repair; do not infer a pass from unchanged markup.
