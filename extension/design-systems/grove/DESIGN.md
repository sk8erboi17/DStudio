---
name: Grove
description: A calm guide: oat and moss, humanist type, soft corners and one focused next step beside a warm welcome.
modes: [design]
ds4_category: services
ds4_local_mode: native
ds4_output_kinds: html
ds4_upstream: dstudio-original/grove
---
# Grove — original DStudio system, version 2

## Visual thesis
Make the next step understandable. A welcoming introduction with reassurance sits beside one focused task card; plain answers and a human fallback follow at the point of use.

Best fit: Learning, health and community services, onboarding, booking and personal tools.

## Load before building
Read `tokens.css`, `components.html`, `assets/preview.js` and `references/recipes.md` using `pack_file(type="design_system", name="grove", path="…")`. These are local authored assets, not an external template or framework. The preview uses example content, not real customers, metrics, transactions or availability.

## Fit the brief

Identify the audience, the primary action and the source of each factual claim.
Preserve explicit user copy, colors, fonts and supplied assets. The composition
below is a starting point: adapt its density, order and proportions to the task.
Record consequential missing decisions; do not invent customers, results or services.
Use only the relevant craft guidance, starting with `craft("state-coverage")`.
Its `references/design-plan.md` provides the short plan and action/result checklist.

## Compose, do not clone
Nav → hero split (welcome and reassurance list | task card with steps, choice tiles, live status and one primary action) → three-step path → questions with a person to contact. Below 980px the task card follows the welcome.

The reference is a worked example, not a universal layout. Keep the thesis and derive content order from the user's task. Never copy the example identity (Fernway and its coaches) into a deliverable. Two unrelated briefs must not become the same skeleton with different text.

## Tokens and typography
`tokens.css` is the executable source of truth. Bind --bg, --surface, --surface-2, --fg, --muted, --border, --border-strong, --accent, --accent-hover and --on-accent; use --success/--danger with a textual label. Buttons are pill-shaped; panels use `--radius-panel`. The accent is moss in light and pale sage in dark. Light and dark palettes are coordinated, not inverted. Measure the actual rendered foreground/background pairs in every offered theme; a token value or color notation does not prove contrast. Display: Optima, Candara, "Segoe UI", system-ui, sans-serif. Body: Seravek, "Gill Sans Nova", "Gill Sans", Corbel, "Segoe UI", system-ui. All stacks work offline; actual glyphs depend on installed fonts. Never claim a fallback is a supplied brand font. Explicit user typography wins.

## Signature components
`.card`, `.reassure`, `.steps` with `aria-current`, `.tile` choice tiles with `aria-pressed` and `[data-choice]`, `.choice-status`, `.path`, `.faq`.

## States and honesty
Copy only the components the brief needs. The component view demonstrates primary/secondary/disabled buttons, labelled inputs, an inline error, empty/loading/success states, disclosure and a keyboard-dismissible dialog that returns focus. Keep :focus-visible, 44px targets where practical, reduced motion and reflow at 320px and 200% text. Never express state by color alone. Availability and places are sample values; a selection never books anything.

Prototype interactions must say they are local previews; wire real operations only when they are implemented. A successful animation is not proof that an action succeeded. Copy referenced CSS/JS into the generated project with relative links: an export must not depend on DStudio API URLs. Do not place text over gradients or background images.

## Avoid
Stock-photo smiles, mascots, more than one primary action per task, countdowns or false scarcity, cramped forms.

## Behavior contract

A selected option has one owner and survives Back, validation failure and review. Confirmation must show the actual selected values and state whether a reservation occurred.

Separate editable drafts from committed state. Define each action's input,
validation, owner, visible result and failure/cancellation behavior in the plan.
Derived views must share the committed data; never let a progress animation or
model self-review stand in for a saved result. Keep queues, retained input and
history bounded. In a preview, state belongs to this document and reload resets it;
production persistence and external effects require their own implemented contract.

## Acceptance
Render at 390, 768 and 1440px in both appearances; check 320px and 200% text for overflow and clipping. Operate every control with the keyboard; Escape closes dialogs and focus returns. Measure contrast on rendered pairs. Exercise loading/error/empty/success with real behavior or a clearly labelled demo state. Select a tile with the keyboard; the status must name the choice. A passing preview is not a claim about generated model quality.

After checking the exported files, report what was exercised, what remains
unverified and the actual saved entry path. Recheck affected controls and layouts
after any HTML, CSS or JavaScript repair; do not infer a pass from unchanged markup.
