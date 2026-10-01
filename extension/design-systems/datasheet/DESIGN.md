---
name: Datasheet
description: A landing page as a technical datasheet: white, black and one signal orange, condensed DIN capitals, a revision strip, numbered sections, ruled specifications, a before/after table and plans as a table.
modes: [design]
ds4_category: landing
ds4_local_mode: native
ds4_output_kinds: html
ds4_upstream: dstudio-original/datasheet
---
# Datasheet — original DStudio system, version 1

## Visual thesis
Let the product be specified, not sold. A revision strip and a huge condensed name lead into numbered sections: specification rows, what it replaces with honest illustrative times, and plans as rows of one table. One orange and one primary action.

Best fit: Landing pages for B2B and management software, hardware and technical products, developer tools, procurement-led sales and spec-heavy launches.

## Load before building
Read `tokens.css`, `components.html`, `assets/preview.js` and `references/recipes.md` using `pack_file(type="design_system", name="datasheet", path="…")`. These are local authored assets, not an external template or framework. The preview uses example content, not real customers, metrics, transactions or availability.

## Fit the brief

Identify the audience, the primary action and the source of each factual claim.
Preserve explicit user copy, colors, fonts and supplied assets. The composition
below is a starting point: adapt its density, order and proportions to the task.
Record consequential missing decisions; do not invent customers, results or services.
Use only the relevant craft guidance, starting with `craft("state-coverage")`.
Its `references/design-plan.md` provides the short plan and action/result checklist.

## Compose, do not clone
Signal strip (product, document number and revision, example label) → hero: eyebrow, the name set huge, a two-sentence claim, one primary action and a text link → numbered sections, each a label column and a content column: 01 specification rows, 02 before/after table, 03 plans as table rows with a billing choice and a note about tax. No illustrations, no feature cards, no testimonials. Below 900px each section stacks; tables become labelled stacks by container width.

The reference is a worked example, not a universal layout. Keep the thesis and derive content order from the user's task. Never copy the example identity (Unit 7 and datasheet DS-07) into a deliverable. Two unrelated briefs must not become the same skeleton with different text.

## Tokens and typography
`tokens.css` is the executable source of truth. Bind --bg, --surface, --surface-2, --fg, --muted, --border, --border-strong, --accent, --accent-hover and --on-accent; use --success/--danger with a textual label. `--signal` and `--on-signal` are the orange strip and tag pair, always with black text. The accent is a darker orange for links and the primary action so it stays readable on white; it lightens in dark. Light and dark palettes are coordinated, not inverted. Measure the actual rendered foreground/background pairs in every offered theme; a token value or color notation does not prove contrast. Display: "DIN Condensed", Bahnschrift, "Arial Narrow", "Roboto Condensed", sans-serif, in capitals. Body: system-ui, -apple-system, "Segoe UI". Labels and figures: "SF Mono", "Cascadia Mono", ui-monospace, Menlo, Consolas. All stacks work offline; actual glyphs depend on installed fonts. Never claim a fallback is a supplied brand font. Explicit user typography wins.

## Signature components
`.strip`, `.sec-h` with `.sec-n`, `.spec` rows, `.versus` with `.versus-row` (`.before`, `.after`), `.plans` with `.plan` rows (`.plan-name`, `.tag`, `.plan-price`).

## States and honesty
Copy only the components the brief needs. The component view demonstrates primary/secondary/disabled buttons, labelled inputs, an inline error, empty/loading/success states, disclosure and a keyboard-dismissible dialog that returns focus. Keep :focus-visible, 44px targets where practical, reduced motion and reflow at 320px and 200% text. Never express state by color alone. Times and prices are examples and say so; never present illustrative numbers as measured results. Booking a demo books nothing in the preview.

Prototype interactions must say they are local previews; wire real operations only when they are implemented. A successful animation is not proof that an action succeeded. Copy referenced CSS/JS into the generated project with relative links: an export must not depend on DStudio API URLs. Do not place text over gradients or background images.

## Avoid
Gradients, glowing product renders, feature-card grids, floating pricing cards, logo walls, invented benchmarks, more than one primary action.

## Behavior contract

Specifications retain units, revisions and source identity. Billing updates every plan and explanatory note together; comparison rows refer to the same configurations. A demo dialog cannot claim a service ran.

Separate editable drafts from committed state. Define each action's input,
validation, owner, visible result and failure/cancellation behavior in the plan.
Derived views must share the committed data; never let a progress animation or
model self-review stand in for a saved result. Keep queues, retained input and
history bounded. In a preview, state belongs to this document and reload resets it;
production persistence and external effects require their own implemented contract.

## Acceptance
Render at 390, 768 and 1440px in both appearances; check 320px and 200% text for overflow and clipping. Operate every control with the keyboard; Escape closes dialogs and focus returns. Measure contrast on rendered pairs. Exercise loading/error/empty/success with real behavior or a clearly labelled demo state. Switch the billing period; every plan price and the note must change. Follow the specification link. Open the demo dialog; it must say nothing was sent. A passing preview is not a claim about generated model quality.

After checking the exported files, report what was exercised, what remains
unverified and the actual saved entry path. Recheck affected controls and layouts
after any HTML, CSS or JavaScript repair; do not infer a pass from unchanged markup.
