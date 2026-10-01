---
name: Roster
description: A wall planner for shifts: graph-paper white and violet ink, a wide legible sans, people by days, named shift blocks, hours against contract, written gaps and leave you can approve.
modes: [design]
ds4_category: workforce
ds4_local_mode: native
ds4_output_kinds: html
ds4_upstream: dstudio-original/roster
---
# Roster — original DStudio system, version 1

## Visual thesis
The week on one sheet. People run down the side and days across; each cell is a named shift block and the control that selects it. Hours sit against contract at the end of each row and gaps are counted underneath; rules are enforced and explained beside the choice.

Best fit: Shift planning, staff rotas, HR and workforce tools, room or equipment booking grids and any people-by-time schedule.

## Load before building
Read `tokens.css`, `components.html`, `assets/preview.js` and `references/recipes.md` using `pack_file(type="design_system", name="roster", path="…")`. These are local authored assets, not an external template or framework. The preview uses example content, not real customers, metrics, transactions or availability.

## Fit the brief

Identify the audience, the primary action and the source of each factual claim.
Preserve explicit user copy, colors, fonts and supplied assets. The composition
below is a starting point: adapt its density, order and proportions to the task.
Record consequential missing decisions; do not invent customers, results or services.
Use only the relevant craft guidance, starting with `craft("state-coverage")`.
Its `references/design-plan.md` provides the short plan and action/result checklist.

## Compose, do not clone
Masthead (team, period, a written summary of gaps, one primary publish action) → the week: header row, one row per person (name and role, seven cells, hours against contract), a cover row with counts per shift → below: the selected cell with shift radios, the rule that applies and a status line, beside leave requests with approve and decline text actions. Below 58em of grid width each person becomes a block of labelled day cells.

The reference is a worked example, not a universal layout. Keep the thesis and derive content order from the user's task. Never copy the example identity (Riverside kitchen and its example staff) into a deliverable. Two unrelated briefs must not become the same skeleton with different text.

## Tokens and typography
`tokens.css` is the executable source of truth. Bind --bg, --surface, --surface-2, --fg, --muted, --border, --border-strong, --accent, --accent-hover and --on-accent; use --success/--danger with a textual label. `--early-*`, `--late-*`, `--night-*` and `--leave-*` are measured background/text pairs for shift blocks in both appearances; `--grid` is the faint cell rule. The accent is violet ink for selection and the one primary action. Light and dark palettes are coordinated, not inverted. Measure the actual rendered foreground/background pairs in every offered theme; a token value or color notation does not prove contrast. Everything: Verdana, Tahoma, "DejaVu Sans", sans-serif — wide and legible at small sizes, bold and tightly tracked for titles. All stacks work offline; actual glyphs depend on installed fonts. Never claim a fallback is a supplied brand font. Explicit user typography wins.

## Signature components
`.week` container with `.week-head`, `.person` rows (`.who`, `.cell[aria-pressed]`, `.shift[data-shift=early|late|night|leave]`, `.off`, `.hours`, `[data-over]`), `.cover` with `.cover-day` and `.short`, `.requests` with `.request` and `.request-state`, `.link-btn`.

## States and honesty
Copy only the components the brief needs. The component view demonstrates primary/secondary/disabled buttons, labelled inputs, an inline error, empty/loading/success states, disclosure and a keyboard-dismissible dialog that returns focus. Keep :focus-visible, 44px targets where practical, reduced motion and reflow at 320px and 200% text. Never express state by color alone. The rota is a draft: changes and approvals say nothing was published. Rules disable a choice only with the reason written beside it.

Prototype interactions must say they are local previews; wire real operations only when they are implemented. A successful animation is not proof that an action succeeded. Copy referenced CSS/JS into the generated project with relative links: an export must not depend on DStudio API URLs. Do not place text over gradients or background images.

## Avoid
Drag as the only way to move a shift, color-only shift types, avatars in every cell, horizontally scrolling grids, calendar chrome copied from a known product, more than one primary action per view.

## Behavior contract

Hours, coverage, leave and rest constraints derive from the same person/day shifts. A rejected assignment keeps the old shift. Approval changes only the intended leave and exposes the resulting coverage gap.

Separate editable drafts from committed state. Define each action's input,
validation, owner, visible result and failure/cancellation behavior in the plan.
Derived views must share the committed data; never let a progress animation or
model self-review stand in for a saved result. Keep queues, retained input and
history bounded. In a preview, state belongs to this document and reload resets it;
production persistence and external effects require their own implemented contract.

## Acceptance
Render at 390, 768 and 1440px in both appearances; check 320px and 200% text for overflow and clipping. Operate every control with the keyboard; Escape closes dialogs and focus returns. Measure contrast on rendered pairs. Exercise loading/error/empty/success with real behavior or a clearly labelled demo state. Select cells and change shifts; hours, over-contract text and cover counts must follow. Select an early shift after a night (it must be unavailable with a reason). Approve the pending leave; the cells must become leave and a new gap must be counted. A passing preview is not a claim about generated model quality.

After checking the exported files, report what was exercised, what remains
unverified and the actual saved entry path. Recheck affected controls and layouts
after any HTML, CSS or JavaScript repair; do not infer a pass from unchanged markup.
