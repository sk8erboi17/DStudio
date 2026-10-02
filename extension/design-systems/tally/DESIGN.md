---
name: Tally
description: An invoice book with carbon copies: cool paper, carbon-blue numbers, a Copperplate letterhead, a status-filtered register and an invoice sheet whose totals add up while you edit.
modes: [design]
ds4_category: invoicing
ds4_local_mode: native
ds4_output_kinds: html
ds4_upstream: dstudio-original/tally
---
# Tally — original DStudio system, version 1

## Visual thesis
The document is the interface. A register of invoices, filtered by status with text tabs, sits beside the invoice itself on paper: letterhead, parties, ruled lines with editable quantities while it is a draft, tax on its own line and a heavy rule under the total.

Best fit: Invoicing and billing, quotes and estimates, purchase orders, receipts, credit notes and small-business accounting back offices.

## Load before building
Read `tokens.css`, `components.html`, `assets/preview.js` and `references/recipes.md` using `pack_file(type="design_system", name="tally", path="…")`. These are local authored assets, not an external template or framework. The preview uses example content, not real customers, metrics, transactions or availability.

## Fit the brief

Identify the audience, the primary action and the source of each factual claim.
Preserve explicit user copy, colors, fonts and supplied assets. The composition
below is a starting point: adapt its density, order and proportions to the task.
Record consequential missing decisions; do not invent customers, results or services.
Use only the relevant craft guidance, starting with `craft("state-coverage")`.
Its `references/design-plan.md` provides the short plan and action/result checklist.

## Compose, do not clone
Masthead (business, a secondary new-invoice action) → register: status text tabs, an announced count and ruled rows (number that opens it, client and due date, total, shaped status) → the sheet: letterhead and number, parties and dates, line items, subtotal, VAT and total, payment terms → one primary action that depends on status, the status word and a status line. Below 1000px the sheet follows the register; below 30em of width rows and lines become stacks.

The reference is a worked example, not a universal layout. Keep the thesis and derive content order from the user's task. Never copy the example identity (Studio Ferri and its example clients) into a deliverable. Two unrelated briefs must not become the same skeleton with different text.

## Tokens and typography
`tokens.css` is the executable source of truth. Bind --bg, --surface, --surface-2, --fg, --muted, --border, --border-strong, --accent, --accent-hover and --on-accent; use --success/--danger with a textual label. The accent is carbon blue for invoice numbers, the selected tab and the one primary action; it lightens to periwinkle in dark. Overdue uses --danger with a triangle; paid uses --success with a disc. Light and dark palettes are coordinated, not inverted. Measure the actual rendered foreground/background pairs in every offered theme; a token value or color notation does not prove contrast. Letterhead and titles: Copperplate, "Copperplate Gothic Light", "Copperplate Gothic", Georgia, serif, used sparingly. Body, figures and controls: "Segoe UI", system-ui, -apple-system, with tabular numerals. Numbers: "SF Mono", ui-monospace, Menlo, Consolas. All stacks work offline; actual glyphs depend on installed fonts. Never claim a fallback is a supplied brand font. Explicit user typography wins.

## Signature components
`.tabs-text`, a `.register` container of `.inv` rows (`.inv-no`, `.inv-client`, `.inv-amt`, `.inv-state[data-state=draft|sent|overdue|paid]`), `.sheet` (`.sheet-head`, `.letterhead`, `.sheet-no`, `.parties`, `.lines` with `.line-cols` and `.line-row`, `.totals` with `.grand`, `.terms`).

## States and honesty
Copy only the components the brief needs. The component view demonstrates primary/secondary/disabled buttons, labelled inputs, an inline error, empty/loading/success states, disclosure and a keyboard-dismissible dialog that returns focus. Keep :focus-visible, 44px targets where practical, reduced motion and reflow at 320px and 200% text. Never express state by color alone. Sending and marking paid change only the preview and say no email, e-invoice or bank check happened. An invalid quantity is explained and never changes the total.

Prototype interactions must say they are local previews; wire real operations only when they are implemented. A successful animation is not proof that an action succeeded. Copy referenced CSS/JS into the generated project with relative links: an export must not depend on DStudio API URLs. Do not place text over gradients or background images.

## Avoid
Dashboard tiles of revenue, aging charts without a question, colored pills as the only status, editing a sent invoice in place, fake signatures or stamps, more than one primary action per view.

## Behavior contract

Compute invoice line amounts and totals from validated quantities, prices and tax rules. Invalid edits preserve the last valid draft; paid/sent labels require an actual effect or an explicit local-demo label.

Separate editable drafts from committed state. Define each action's input,
validation, owner, visible result and failure/cancellation behavior in the plan.
Derived views must share the committed data; never let a progress animation or
model self-review stand in for a saved result. Keep queues, retained input and
history bounded. In a preview, state belongs to this document and reload resets it;
production persistence and external effects require their own implemented contract.

## Acceptance
Render at 390, 768 and 1440px in both appearances; check 320px and 200% text for overflow and clipping. Operate every control with the keyboard; Escape closes dialogs and focus returns. Measure contrast on rendered pairs. Exercise loading/error/empty/success with real behavior or a clearly labelled demo state. Filter by every status; the count must be announced. Edit a draft quantity to a valid and an invalid value; the totals and the register must follow only the valid one. Send the draft and mark an overdue invoice as paid. A passing preview is not a claim about generated model quality.

After checking the exported files, report what was exercised, what remains
unverified and the actual saved entry path. Recheck affected controls and layouts
after any HTML, CSS or JavaScript repair; do not infer a pass from unchanged markup.
