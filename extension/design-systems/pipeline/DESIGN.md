---
name: Pipeline
description: A dossier for every deal: warm paper and claret ink, company names in a display serif, a ruled stage strip that filters, deal rows with the next step and a factual timeline.
modes: [design]
ds4_category: sales
ds4_local_mode: native
ds4_output_kinds: html
ds4_upstream: dstudio-original/pipeline
---
# Pipeline — original DStudio system, version 1

## Visual thesis
Selling is a sequence of next steps. A ruled stage strip with counts and value doubles as the filter; deal rows carry company, stage, value and the next step with its date; the dossier beside them shows the path, the facts, one action to advance and a timeline of what happened.

Best fit: CRM, sales pipelines, account management, recruiting pipelines, grant or admissions tracking and any staged process with people and values.

## Load before building
Read `tokens.css`, `components.html`, `assets/preview.js` and `references/recipes.md` using `pack_file(type="design_system", name="pipeline", path="…")`. These are local authored assets, not an external template or framework. The preview uses example content, not real customers, metrics, transactions or availability.

## Fit the brief

Identify the audience, the primary action and the source of each factual claim.
Preserve explicit user copy, colors, fonts and supplied assets. The composition
below is a starting point: adapt its density, order and proportions to the task.
Record consequential missing decisions; do not invent customers, results or services.
Use only the relevant craft guidance, starting with `craft("state-coverage")`.
Its `references/design-plan.md` provides the short plan and action/result checklist.

## Compose, do not clone
Masthead (team, open count and value, a secondary new-deal action) → stage strip (count and value per stage; pressing one filters) → deal rows (company that opens the dossier, contact, stage, value, next step with date and an overdue triangle) beside the dossier (stage path, facts, one primary advance action and a quiet lost action, status, activity form with inline error, timeline). Below 1100px the dossier follows the list; below 44em of list width rows become stacks.

The reference is a worked example, not a universal layout. Keep the thesis and derive content order from the user's task. Never copy the example identity (the example sales team and its companies) into a deliverable. Two unrelated briefs must not become the same skeleton with different text.

## Tokens and typography
`tokens.css` is the executable source of truth. Bind --bg, --surface, --surface-2, --fg, --muted, --border, --border-strong, --accent, --accent-hover and --on-accent; use --success/--danger with a textual label. The accent is claret for the selected stage, the current step and the one primary action; it lightens to rose in dark. Overdue uses --danger with a triangle and the word overdue. Light and dark palettes are coordinated, not inverted. Measure the actual rendered foreground/background pairs in every offered theme; a token value or color notation does not prove contrast. Display and figures: "Big Caslon", Cambria, "Hoefler Text", Georgia, serif. Body and controls: system-ui, -apple-system, "Segoe UI", sans-serif. All stacks work offline; actual glyphs depend on installed fonts. Never claim a fallback is a supplied brand font. Explicit user typography wins.

## Signature components
`.stages` of `.stage` buttons (`.stage-name`, `.stage-sum`), a `.deals` container with `.deal-cols` and `.deal-list` of `.deal` rows (`.deal-co`, `.deal-open`, `.deal-stage`, `.num`, `.next[data-late]`), `.path` with `[data-done]` and `[aria-current=step]`, `.timeline`, `.link-btn`.

## States and honesty
Copy only the components the brief needs. The component view demonstrates primary/secondary/disabled buttons, labelled inputs, an inline error, empty/loading/success states, disclosure and a keyboard-dismissible dialog that returns focus. Keep :focus-visible, 44px targets where practical, reduced motion and reflow at 320px and 200% text. Never express state by color alone. Stages, values and activities are examples; advancing, losing and logging say they changed only the preview. Never imply an email was sent or a contract signed.

Prototype interactions must say they are local previews; wire real operations only when they are implemented. A successful animation is not proof that an action succeeded. Copy referenced CSS/JS into the generated project with relative links: an export must not depend on DStudio API URLs. Do not place text over gradients or background images.

## Avoid
Kanban cards with avatars, probability gauges, leaderboards, confetti on a win, colored stage pills as the only signal, more than one primary action per view.

## Behavior contract

Stage, deal status, weighted/open totals and timeline agree. Reject empty activities and keep them attached to the selected deal. Won/lost are explicit transitions, not inferred from an animation.

The authored preview admits at most 20 new activities per deal, each limited to
1000 JavaScript string units after trimming. Rejection keeps the timeline and
typed draft. Stage transitions remain distinct from activity admission; define
appropriate retention and persistence for the actual product owner.

Separate editable drafts from committed state. Define each action's input,
validation, owner, visible result and failure/cancellation behavior in the plan.
Derived views must share the committed data; never let a progress animation or
model self-review stand in for a saved result. Keep queues, retained input and
history bounded. In a preview, state belongs to this document and reload resets it;
production persistence and external effects require their own implemented contract.

## Acceptance
Render at 390, 768 and 1440px in both appearances; check 320px and 200% text for overflow and clipping. Operate every control with the keyboard; Escape closes dialogs and focus returns. Measure contrast on rendered pairs. Exercise loading/error/empty/success with real behavior or a clearly labelled demo state. Filter by each stage and back to all open; the title and count must follow. Advance a deal to Won and mark another as lost; totals, path and timeline must update. Log an empty and a real activity. A passing preview is not a claim about generated model quality.

After checking the exported files, report what was exercised, what remains
unverified and the actual saved entry path. Recheck affected controls and layouts
after any HTML, CSS or JavaScript repair; do not infer a pass from unchanged markup.
