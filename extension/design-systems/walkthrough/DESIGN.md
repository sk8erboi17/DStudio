---
name: Walkthrough
description: A landing page that shows the product working: calm grey and product blue, a large plain headline, numbered steps that light up the matching part of a drawn product view, plans as rows and one repeated action.
modes: [design]
ds4_category: landing
ds4_local_mode: native
ds4_output_kinds: html
ds4_upstream: dstudio-original/walkthrough
---
# Walkthrough — original DStudio system, version 1

## Visual thesis
Show, in order, how the product is used. A plain promise leads into a tour: four numbered steps beside a drawn product view, where the selected step outlines and pins its region. Plans follow as rows, then real questions and the same single action again.

Best fit: Landing pages for management software, SaaS tools, internal products, onboarding pages and feature launches where the interface is the argument.

## Load before building
Read `tokens.css`, `components.html`, `assets/preview.js` and `references/recipes.md` using `pack_file(type="design_system", name="walkthrough", path="…")`. These are local authored assets, not an external template or framework. The preview uses example content, not real customers, metrics, transactions or availability.

## Fit the brief

Identify the audience, the primary action and the source of each factual claim.
Preserve explicit user copy, colors, fonts and supplied assets. The composition
below is a starting point: adapt its density, order and proportions to the task.
Record consequential missing decisions; do not invent customers, results or services.
Use only the relevant craft guidance, starting with `craft("state-coverage")`.
Its `references/design-plan.md` provides the short plan and action/result checklist.

## Compose, do not clone
Top line (name and three anchors) → hero: eyebrow, a large headline with a concrete promise, one sentence, one primary action and a text link → tour: numbered step buttons and a detail with Next step, beside a product view drawn in solid fills whose regions take an outline and a numbered pin → plans as ruled rows → questions → a solid closing band repeating the same action. Below 900px the product view follows the steps.

The reference is a worked example, not a universal layout. Keep the thesis and derive content order from the user's task. Never copy the example identity (Rota and week 42) into a deliverable. Two unrelated briefs must not become the same skeleton with different text.

## Tokens and typography
`tokens.css` is the executable source of truth. Bind --bg, --surface, --surface-2, --fg, --muted, --border, --border-strong, --accent, --accent-hover and --on-accent; use --success/--danger with a textual label. `--mock-*` colors draw the product view; `--b-early`, `--b-late`, `--b-night` and `--b-gap` are its block fills, and only `--b-gap` carries text, measured against `--mock-ink`. The accent is product blue for the selected step, the region outline, pins and the one action. Light and dark palettes are coordinated, not inverted. Measure the actual rendered foreground/background pairs in every offered theme; a token value or color notation does not prove contrast. Display: "SF Pro Display", "Segoe UI Variable Display", "Segoe UI", system-ui, semibold and tightly tracked. Body and controls: system-ui, -apple-system, "Segoe UI", sans-serif. All stacks work offline; actual glyphs depend on installed fonts. Never claim a fallback is a supplied brand font. Explicit user typography wins.

## Signature components
`.tour` with `.tour-step[aria-pressed]` and `.tour-n`, `.mock` (`.mock-bar`, `.mock-pub`, `.mock-body`, `.mock-side`, `.mock-main`, `.mock-days`, `.mock-grid` blocks, `.mock-gaps` and `.mock-flag`), `[data-region][data-active]` with `.pin`, `.plan-rows` of `.plan-row`, `.link-btn`.

## States and honesty
Copy only the components the brief needs. The component view demonstrates primary/secondary/disabled buttons, labelled inputs, an inline error, empty/loading/success states, disclosure and a keyboard-dismissible dialog that returns focus. Keep :focus-visible, 44px targets where practical, reduced motion and reflow at 320px and 200% text. Never express state by color alone. The product view is a drawing and is hidden from assistive technology; the steps carry the meaning. Never present a drawing as a screenshot of a shipped product, and never invent usage numbers.

Prototype interactions must say they are local previews; wire real operations only when they are implemented. A successful animation is not proof that an action succeeded. Copy referenced CSS/JS into the generated project with relative links: an export must not depend on DStudio API URLs. Do not place text over gradients or background images.

## Avoid
Gradient hero backgrounds, floating device mockups, blurred screenshots behind text, feature-card grids, logo walls, autoplaying carousels, a second competing action.

## Behavior contract

Step, highlighted region, explanatory copy and current-state indicator agree. Next wraps or ends explicitly; hidden steps do not receive focus. Repeated calls to action target the same real or labelled-demo operation.

Separate editable drafts from committed state. Define each action's input,
validation, owner, visible result and failure/cancellation behavior in the plan.
Derived views must share the committed data; never let a progress animation or
model self-review stand in for a saved result. Keep queues, retained input and
history bounded. In a preview, state belongs to this document and reload resets it;
production persistence and external effects require their own implemented contract.

## Acceptance
Render at 390, 768 and 1440px in both appearances; check 320px and 200% text for overflow and clipping. Operate every control with the keyboard; Escape closes dialogs and focus returns. Measure contrast on rendered pairs. Exercise loading/error/empty/success with real behavior or a clearly labelled demo state. Select every step and use Next step through the whole tour; the outlined region, pin and text must follow. Start the trial from the hero and from the closing band. A passing preview is not a claim about generated model quality.

After checking the exported files, report what was exercised, what remains
unverified and the actual saved entry path. Recheck affected controls and layouts
after any HTML, CSS or JavaScript repair; do not infer a pass from unchanged markup.
