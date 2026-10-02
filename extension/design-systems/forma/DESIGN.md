---
name: Forma
description: A gallery wall for work: chalk and ink, one ultramarine, geometric capitals and unequal plates with museum labels.
modes: [design]
ds4_category: portfolio
ds4_local_mode: native
ds4_output_kinds: html
ds4_upstream: dstudio-original/forma
---
# Forma — original DStudio system, version 2

## Visual thesis
The work carries the page. One statement in large geometric capitals, unequal plates on a 12-column grid with museum-style labels, a measured index of works and whitespace that is structural, not leftover.

Best fit: Studios, architecture, portfolios, product presentations and exhibitions.

## Load before building
Read `tokens.css`, `components.html`, `assets/preview.js` and `references/recipes.md` using `pack_file(type="design_system", name="forma", path="…")`. These are local authored assets, not an external template or framework. The preview uses example content, not real customers, metrics, transactions or availability.

## Fit the brief

Identify the audience, the primary action and the source of each factual claim.
Preserve explicit user copy, colors, fonts and supplied assets. The composition
below is a starting point: adapt its density, order and proportions to the task.
Record consequential missing decisions; do not invent customers, results or services.
Use only the relevant craft guidance, starting with `craft("state-coverage")`.
Its `references/design-plan.md` provides the short plan and action/result checklist.

## Compose, do not clone
Nav with a spaced wordmark → meta row and one huge statement → staggered plates (7/5, then 4/7 columns, offset vertically) → index of works with a kind filter → studio text and one enquiry action. Below 900px plates stack in order without offsets.

The reference is a worked example, not a universal layout. Keep the thesis and derive content order from the user's task. Never copy the example identity (Halde studio and its works) into a deliverable. Two unrelated briefs must not become the same skeleton with different text.

## Tokens and typography
`tokens.css` is the executable source of truth. Bind --bg, --surface, --surface-2, --fg, --muted, --border, --border-strong, --accent, --accent-hover and --on-accent; use --success/--danger with a textual label. Radii are zero by design. The accent appears as one word, one plate or one action per view. Light and dark palettes are coordinated, not inverted. Measure the actual rendered foreground/background pairs in every offered theme; a token value or color notation does not prove contrast. Display: Futura, "Futura PT", "Century Gothic", "Avenir Next", "Trebuchet MS", sans-serif, set in capitals. Body: "Avenir Next", "Segoe UI", system-ui; captions in a monospace stack. All stacks work offline; actual glyphs depend on installed fonts. Never claim a fallback is a supplied brand font. Explicit user typography wins.

## Signature components
`.meta-row`, `.plate` with `.plate-field` (ratio via `--ratio`, color via `--field`, marks as `<i>`) and `.label` (number, title, place · year · materials), `.seg` filter, `.index-list`.

## States and honesty
Copy only the components the brief needs. The component view demonstrates primary/secondary/disabled buttons, labelled inputs, an inline error, empty/loading/success states, disclosure and a keyboard-dismissible dialog that returns focus. Keep :focus-visible, 44px targets where practical, reduced motion and reflow at 320px and 200% text. Never express state by color alone. Plates are original geometric studies or image slots: label them and never present them as photographs of real buildings.

Prototype interactions must say they are local previews; wire real operations only when they are implemented. A successful animation is not proof that an action succeeded. Copy referenced CSS/JS into the generated project with relative links: an export must not depend on DStudio API URLs. Do not place text over gradients or background images.

## Avoid
Equal-thumbnail card grids, hover zoom on every image, gradient overlays, centred hero text over imagery, more than one display statement per view.

## Behavior contract

Keep project identity, captions and detail destinations attached to the selected work. An alternate composition must change hierarchy for its content, not only recolor the same gallery.

Separate editable drafts from committed state. Define each action's input,
validation, owner, visible result and failure/cancellation behavior in the plan.
Derived views must share the committed data; never let a progress animation or
model self-review stand in for a saved result. Keep queues, retained input and
history bounded. In a preview, state belongs to this document and reload resets it;
production persistence and external effects require their own implemented contract.

## Acceptance
Render at 390, 768 and 1440px in both appearances; check 320px and 200% text for overflow and clipping. Operate every control with the keyboard; Escape closes dialogs and focus returns. Measure contrast on rendered pairs. Exercise loading/error/empty/success with real behavior or a clearly labelled demo state. Filter the index and confirm the status counts the works shown. A passing preview is not a claim about generated model quality.

After checking the exported files, report what was exercised, what remains
unverified and the actual saved entry path. Recheck affected controls and layouts
after any HTML, CSS or JavaScript repair; do not infer a pass from unchanged markup.
