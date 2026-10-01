---
name: Folio
description: A quarterly on screen: warm paper, a reading serif, running heads, ruled contents and marginal notes.
modes: [design]
ds4_category: editorial
ds4_local_mode: native
ds4_output_kinds: html
ds4_upstream: dstudio-original/folio
---
# Folio — original DStudio system, version 2

## Visual thesis
A publication, not a grid of cards. A running head and a double rule frame a large serif headline beside a ruled contents column; the long read keeps a 64-character measure with notes in the margin.

Best fit: Essays, research notes, documentation, journals and independent publications.

## Load before building
Read `tokens.css`, `components.html`, `assets/preview.js` and `references/recipes.md` using `pack_file(type="design_system", name="folio", path="…")`. These are local authored assets, not an external template or framework. The preview uses example content, not real customers, metrics, transactions or availability.

## Fit the brief

Identify the audience, the primary action and the source of each factual claim.
Preserve explicit user copy, colors, fonts and supplied assets. The composition
below is a starting point: adapt its density, order and proportions to the task.
Record consequential missing decisions; do not invent customers, results or services.
Use only the relevant craft guidance, starting with `craft("state-coverage")`.
Its `references/design-plan.md` provides the short plan and action/result checklist.

## Compose, do not clone
Running head → masthead over a double rule → opening spread (8:4, headline and standfirst beside the contents) → essay in three columns (heading, prose, marginalia) → ruled archive list → colophon. Below 980px the marginalia follow the prose; below 760px the contents move under the headline. Never justify body text.

The reference is a worked example, not a universal layout. Keep the thesis and derive content order from the user's task. Never copy the example identity (Common Ground, Mara Ellis) into a deliverable. Two unrelated briefs must not become the same skeleton with different text.

## Tokens and typography
`tokens.css` is the executable source of truth. Bind --bg, --surface, --surface-2, --fg, --muted, --border, --border-strong, --accent, --accent-hover and --on-accent; use --success/--danger with a textual label. `--rule` is the ink-strength line for running heads and double rules; `--border` is the quiet divider. Light and dark palettes are coordinated, not inverted. Measure the actual rendered foreground/background pairs in every offered theme; a token value or color notation does not prove contrast. Display: "Iowan Old Style", "Sitka Display", Charter, "Palatino Linotype", Georgia, serif. Body: Charter, "Iowan Old Style", "Sitka Text", Cambria, Georgia, serif; labels in "Avenir Next", "Gill Sans", "Segoe UI". All stacks work offline; actual glyphs depend on installed fonts. Never claim a fallback is a supplied brand font. Explicit user typography wins.

## Signature components
`.running-head`, `.masthead` + `.wordmark`, `.kicker`, `.standfirst`, `.byline`, `.contents` (number, title, folio), `.prose` with `.lead` and `.pull`, `.note-ref` + `.marginalia`, `.ruled-list`, `.ruled-table`.

## States and honesty
Copy only the components the brief needs. The component view demonstrates primary/secondary/disabled buttons, labelled inputs, an inline error, empty/loading/success states, disclosure and a keyboard-dismissible dialog that returns focus. Keep :focus-visible, 44px targets where practical, reduced motion and reflow at 320px and 200% text. Never express state by color alone.

Prototype interactions must say they are local previews; wire real operations only when they are implemented. A successful animation is not proof that an action succeeded. Copy referenced CSS/JS into the generated project with relative links: an export must not depend on DStudio API URLs. Do not place text over gradients or background images.

## Avoid
Rounded dashboard cards, invented endorsements, giant quote marks, ornamental drop caps, paper textures and magazine pastiche. One accent; italic display only for emphasis.

## Behavior contract

Keep reading order, section destinations and search results consistent. Opening a detail must retain the originating reading position and return focus when closed.

Separate editable drafts from committed state. Define each action's input,
validation, owner, visible result and failure/cancellation behavior in the plan.
Derived views must share the committed data; never let a progress animation or
model self-review stand in for a saved result. Keep queues, retained input and
history bounded. In a preview, state belongs to this document and reload resets it;
production persistence and external effects require their own implemented contract.

## Acceptance
Render at 390, 768 and 1440px in both appearances; check 320px and 200% text for overflow and clipping. Operate every control with the keyboard; Escape closes dialogs and focus returns. Measure contrast on rendered pairs. Exercise loading/error/empty/success with real behavior or a clearly labelled demo state. Check that marginal notes follow their paragraph on narrow screens. A passing preview is not a claim about generated model quality.

After checking the exported files, report what was exercised, what remains
unverified and the actual saved entry path. Recheck affected controls and layouts
after any HTML, CSS or JavaScript repair; do not infer a pass from unchanged markup.
