---
name: Ledger
description: A bound account book: pale ruled paper, navy ink, serif tabular figures, red column rules, double-ruled totals and reconciliation you can tick.
modes: [design]
ds4_category: finance
ds4_local_mode: native
ds4_output_kinds: html
ds4_upstream: dstudio-original/ledger
---
# Ledger — original DStudio system, version 1

## Visual thesis
Money as a book you can audit. A statement with a double-ruled total sits beside the title; entries run as ruled rows with red rules between columns of money and a running balance; reconciliation and envelopes sit in a quiet side column.

Best fit: Personal and small-business finance, budgets, invoices, expenses, statements and any product where totals must add up in view.

## Load before building
Read `tokens.css`, `components.html`, `assets/preview.js` and `references/recipes.md` using `pack_file(type="design_system", name="ledger", path="…")`. These are local authored assets, not an external template or framework. The preview uses example content, not real customers, metrics, transactions or availability.

## Fit the brief

Identify the audience, the primary action and the source of each factual claim.
Preserve explicit user copy, colors, fonts and supplied assets. The composition
below is a starting point: adapt its density, order and proportions to the task.
Record consequential missing decisions; do not invent customers, results or services.
Use only the relevant craft guidance, starting with `craft("state-coverage")`.
Its `references/design-plan.md` provides the short plan and action/result checklist.

## Compose, do not clone
Masthead (title, an honest note about where figures come from) beside a statement: brought forward, in, out and a double-ruled carried-forward total → entries with a category filter, an announced count and one primary action → ruled ledger rows (date, payee, category, out, in, running balance, reconcile tick) → side column with the cleared balance and envelopes. No cards: rules, columns and figures do the work. Below 1100px the side column follows the entries; below 44em of container width a row becomes a stack with a signed amount.

The reference is a worked example, not a universal layout. Keep the thesis and derive content order from the user's task. Never copy the example identity (October, Corner Grocer and the example payees) into a deliverable. Two unrelated briefs must not become the same skeleton with different text.

## Tokens and typography
`tokens.css` is the executable source of truth. Bind --bg, --surface, --surface-2, --fg, --muted, --border, --border-strong, --accent, --accent-hover and --on-accent; use --success/--danger with a textual label. `--rule` is the decorative red column rule and never carries text. The accent is navy ink in light and pale blue in dark so it stays readable as text. Light and dark palettes are coordinated, not inverted. Measure the actual rendered foreground/background pairs in every offered theme; a token value or color notation does not prove contrast. Display and figures: Baskerville, "Baskerville Old Face", "Libre Baskerville", Georgia, serif, always with tabular lining numerals. Body and controls: system-ui, -apple-system, "Segoe UI", sans-serif. All stacks work offline; actual glyphs depend on installed fonts. Never claim a fallback is a supplied brand font. Explicit user typography wins.

## Signature components
`.statement` with `.total-rule`, a `.ledger` container holding `.book-cols` and a `.book` of `.entry` rows (`.e-date`, `.e-payee`, `.e-cat`, `.amt.out`, `.amt.in`, `.amt.bal`, `.e-signed`, `.e-tick`), `.envelopes` with `.env-bar` and `.env-note`, `.figure` and `.neg`.

## States and honesty
Copy only the components the brief needs. The component view demonstrates primary/secondary/disabled buttons, labelled inputs, an inline error, empty/loading/success states, disclosure and a keyboard-dismissible dialog that returns focus. Keep :focus-visible, 44px targets where practical, reduced motion and reflow at 320px and 200% text. Never express state by color alone. Figures are example values: never imply a live bank connection, a real balance or a completed payment. A deficit is stated in words, not only in red.

Prototype interactions must say they are local previews; wire real operations only when they are implemented. A successful animation is not proof that an action succeeded. Copy referenced CSS/JS into the generated project with relative links: an export must not depend on DStudio API URLs. Do not place text over gradients or background images.

## Avoid
Card grids of KPIs, donut charts without a question, colored arrows as the only signal, proportional figures in columns, a pill badge per category, gradients, more than one primary action per view.

## Behavior contract

Filtering does not recompute the historical running balance. Reconciliation derives cleared totals and remaining count from the same integer-cent entries; unticking restores the previous totals.

Separate editable drafts from committed state. Define each action's input,
validation, owner, visible result and failure/cancellation behavior in the plan.
Derived views must share the committed data; never let a progress animation or
model self-review stand in for a saved result. Keep queues, retained input and
history bounded. In a preview, state belongs to this document and reload resets it;
production persistence and external effects require their own implemented contract.

## Acceptance
Render at 390, 768 and 1440px in both appearances; check 320px and 200% text for overflow and clipping. Operate every control with the keyboard; Escape closes dialogs and focus returns. Measure contrast on rendered pairs. Exercise loading/error/empty/success with real behavior or a clearly labelled demo state. Filter entries to one category and back; the count must be announced. Tick and untick a reconcile box; the cleared balance and the remaining count must update. A passing preview is not a claim about generated model quality.

After checking the exported files, report what was exercised, what remains
unverified and the actual saved entry path. Recheck affected controls and layouts
after any HTML, CSS or JavaScript repair; do not infer a pass from unchanged markup.
