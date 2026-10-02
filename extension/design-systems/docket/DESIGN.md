---
name: Docket
description: Office stationery for work: manila, carbon black and one highlighter yellow, condensed gothic capitals, typewriter IDs and lanes made of rules, not cards.
modes: [design]
ds4_category: productivity
ds4_local_mode: native
ds4_output_kinds: html
ds4_upstream: dstudio-original/docket
---
# Docket — original DStudio system, version 1

## Visual thesis
A docket you can scan in one pass. Three lanes divided by rules hold tasks as ruled lines — ID, title, owner, date — with a highlighter on the selected task and an inspector that owns status, the limit and the checklist.

Best fit: Task and project tracking, editorial calendars, production schedules, kanban-style workflows and checklists.

## Load before building
Read `tokens.css`, `components.html`, `assets/preview.js` and `references/recipes.md` using `pack_file(type="design_system", name="docket", path="…")`. These are local authored assets, not an external template or framework. The preview uses example content, not real customers, metrics, transactions or availability.

## Fit the brief

Identify the audience, the primary action and the source of each factual claim.
Preserve explicit user copy, colors, fonts and supplied assets. The composition
below is a starting point: adapt its density, order and proportions to the task.
Record consequential missing decisions; do not invent customers, results or services.
Use only the relevant craft guidance, starting with `craft("state-coverage")`.
Its `references/design-plan.md` provides the short plan and action/result checklist.

## Compose, do not clone
Masthead (project, period and a few meta values) over a heavy rule → lanes (To do, Doing with a visible limit, Done) as ruled lists → inspector with the selected task’s note, status as radios, the limit explained in words, a checklist with progress and one primary action. Tasks are lines, not cards; the title selects; the highlighter marks selection, never decoration. Below 1100px the inspector follows the board; below 760px lanes stack.

The reference is a worked example, not a universal layout. Keep the thesis and derive content order from the user's task. Never copy the example identity (the Spring catalogue and the DK tasks) into a deliverable. Two unrelated briefs must not become the same skeleton with different text.

## Tokens and typography
`tokens.css` is the executable source of truth. Bind --bg, --surface, --surface-2, --fg, --muted, --border, --border-strong, --accent, --accent-hover and --on-accent; use --success/--danger with a textual label. `--mark` and `--on-mark` are the highlighter pair: yellow with ink text in both appearances. The accent is carbon black in light, so actions read as ink, and the highlighter yellow in dark. Light and dark palettes are coordinated, not inverted. Measure the actual rendered foreground/background pairs in every offered theme; a token value or color notation does not prove contrast. Display: "Franklin Gothic Medium", "Franklin Gothic", "ITC Franklin Gothic", "Libre Franklin", "Arial Narrow", "Helvetica Neue", Arial, sans-serif, in capitals. IDs and dates: "American Typewriter", "Courier Prime", "Courier New", ui-monospace. Body and controls: system-ui, -apple-system, "Segoe UI", sans-serif. All stacks work offline; actual glyphs depend on installed fonts. Never claim a fallback is a supplied brand font. Explicit user typography wins.

## Signature components
`.board` of `.lane` sections (`h2` with `.lane-count`, `[data-full]`), `.tasks` of `.task` rows (`.task-id`, `.prio`, `.task-open`, `.task-meta`, `[data-status=done]`), `.empty-lane` and the `--mark` highlighter pair.

## States and honesty
Copy only the components the brief needs. The component view demonstrates primary/secondary/disabled buttons, labelled inputs, an inline error, empty/loading/success states, disclosure and a keyboard-dismissible dialog that returns focus. Keep :focus-visible, 44px targets where practical, reduced motion and reflow at 320px and 200% text. Never express state by color alone. Moving a task changes only the local preview and says so. A limit is enforced and explained in words, not only by a disabled control.

Prototype interactions must say they are local previews; wire real operations only when they are implemented. A successful animation is not proof that an action succeeded. Copy referenced CSS/JS into the generated project with relative links: an export must not depend on DStudio API URLs. Do not place text over gradients or background images.

## Avoid
Drop-shadowed cards per task, a colored chip per tag, avatar stacks, drag as the only way to move, progress rings, more than one highlighter color, more than one primary action per view.

## Behavior contract

A task exists in one lane. Recheck the Doing limit before moving it; a rejected move preserves the old lane and checklist. Inspector, lane counts and task identity agree.

Separate editable drafts from committed state. Define each action's input,
validation, owner, visible result and failure/cancellation behavior in the plan.
Derived views must share the committed data; never let a progress animation or
model self-review stand in for a saved result. Keep queues, retained input and
history bounded. In a preview, state belongs to this document and reload resets it;
production persistence and external effects require their own implemented contract.

## Acceptance
Render at 390, 768 and 1440px in both appearances; check 320px and 200% text for overflow and clipping. Operate every control with the keyboard; Escape closes dialogs and focus returns. Measure contrast on rendered pairs. Exercise loading/error/empty/success with real behavior or a clearly labelled demo state. Move tasks into Doing until the limit is reached, then select another To do task: Doing must be unavailable with the reason written beside it. Tick a checklist item; the progress count must update. A passing preview is not a claim about generated model quality.

After checking the exported files, report what was exercised, what remains
unverified and the actual saved entry path. Recheck affected controls and layouts
after any HTML, CSS or JavaScript repair; do not infer a pass from unchanged markup.
