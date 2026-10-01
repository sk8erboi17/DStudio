---
name: Market
description: A good shop counter: stone and aubergine, honest prices, finish plinths, a filter rail, comparison and an itemised basket.
modes: [design]
ds4_category: commerce
ds4_local_mode: native
ds4_output_kinds: html
ds4_upstream: dstudio-original/market
---
# Market — original DStudio system, version 2

## Visual thesis
Products, differences and totals before persuasion. A plain masthead leads into a filter rail and a shelf; every object shows its price, finish and a way to compare, and the basket adds up in view.

Best fit: Catalogs, product comparison, configurators and local order prototypes.

## Load before building
Read `tokens.css`, `components.html`, `assets/preview.js` and `references/recipes.md` using `pack_file(type="design_system", name="market", path="…")`. These are local authored assets, not an external template or framework. The preview uses example content, not real customers, metrics, transactions or availability.

## Fit the brief

Identify the audience, the primary action and the source of each factual claim.
Preserve explicit user copy, colors, fonts and supplied assets. The composition
below is a starting point: adapt its density, order and proportions to the task.
Record consequential missing decisions; do not invent customers, results or services.
Use only the relevant craft guidance, starting with `craft("state-coverage")`.
Its `references/design-plan.md` provides the short plan and action/result checklist.

## Compose, do not clone
Masthead with basket → heading and plain-language note → filter rail (search, collection, reset, live count) beside the shelf → comparison tray. The basket is a dialog with quantity controls, total, clear and an empty state. Below 900px the rail moves above the shelf.

The reference is a worked example, not a universal layout. Keep the thesis and derive content order from the user's task. Never copy the example identity (Marlow Goods and its four objects) into a deliverable. Two unrelated briefs must not become the same skeleton with different text.

## Tokens and typography
`tokens.css` is the executable source of truth. Bind --bg, --surface, --surface-2, --fg, --muted, --border, --border-strong, --accent, --accent-hover and --on-accent; use --success/--danger with a textual label. Finish plinths use fixed material colors in both appearances; drawings switch line color for contrast. Light and dark palettes are coordinated, not inverted. Measure the actual rendered foreground/background pairs in every offered theme; a token value or color notation does not prove contrast. Display: "Avenir Next", "Segoe UI", system-ui, sans-serif (semibold, tight tracking). Body: the same stack; prices with tabular figures. All stacks work offline; actual glyphs depend on installed fonts. Never claim a fallback is a supplied brand font. Explicit user typography wins.

## Signature components
`.product` with `.product-art[data-finish]`, `.product-heading` and price, a finish select, compare `label.choice`, `.compare-item`, `.basket-list` with `.basket-controls`, `.basket-total`.

## States and honesty
Copy only the components the brief needs. The component view demonstrates primary/secondary/disabled buttons, labelled inputs, an inline error, empty/loading/success states, disclosure and a keyboard-dismissible dialog that returns focus. Keep :focus-visible, 44px targets where practical, reduced motion and reflow at 320px and 200% text. Never express state by color alone. Prices are illustrative; basket and comparison are local and vanish on reload. Never show checkout as available.

Prototype interactions must say they are local previews; wire real operations only when they are implemented. A successful animation is not proof that an action succeeded. Copy referenced CSS/JS into the generated project with relative links: an export must not depend on DStudio API URLs. Do not place text over gradients or background images.

## Avoid
Countdown timers, fake discounts, unsourced star ratings, carousels and imitation product photos.

## Behavior contract

Compute quantities, line totals and basket totals from the same item/variant state. Filter and comparison changes cannot silently change the basket; removing an item retains usable focus.

Separate editable drafts from committed state. Define each action's input,
validation, owner, visible result and failure/cancellation behavior in the plan.
Derived views must share the committed data; never let a progress animation or
model self-review stand in for a saved result. Keep queues, retained input and
history bounded. In a preview, state belongs to this document and reload resets it;
production persistence and external effects require their own implemented contract.

## Acceptance
Render at 390, 768 and 1440px in both appearances; check 320px and 200% text for overflow and clipping. Operate every control with the keyboard; Escape closes dialogs and focus returns. Measure contrast on rendered pairs. Exercise loading/error/empty/success with real behavior or a clearly labelled demo state. Filter by search and collection, compare at most three, raise a quantity to its limit and clear the basket; focus stays inside the basket dialog. A passing preview is not a claim about generated model quality.

After checking the exported files, report what was exercised, what remains
unverified and the actual saved entry path. Recheck affected controls and layouts
after any HTML, CSS or JavaScript repair; do not infer a pass from unchanged markup.
