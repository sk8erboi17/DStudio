---
name: Larder
description: A cookbook page that works at the stove: cream and tomato, Bodoni titles and numerals, quantities that rescale, ingredients you can tick off and one step marked Now.
modes: [design]
ds4_category: food
ds4_local_mode: native
ds4_output_kinds: html
ds4_upstream: dstudio-original/larder
---
# Larder — original DStudio system, version 1

## Visual thesis
A recipe should be followed, not scrolled past. A large Bodoni title and three facts lead into two columns: ingredients that rescale with servings and can be ticked off, and a numbered method whose next step is marked Now.

Best fit: Recipes, cooking and meal planning, menus, food ordering details and any practical step-by-step guide.

## Load before building
Read `tokens.css`, `components.html`, `assets/preview.js` and `references/recipes.md` using `pack_file(type="design_system", name="larder", path="…")`. These are local authored assets, not an external template or framework. The preview uses example content, not real customers, metrics, transactions or availability.

## Fit the brief

Identify the audience, the primary action and the source of each factual claim.
Preserve explicit user copy, colors, fonts and supplied assets. The composition
below is a starting point: adapt its density, order and proportions to the task.
Record consequential missing decisions; do not invent customers, results or services.
Use only the relevant craft guidance, starting with `craft("state-coverage")`.
Its `references/design-plan.md` provides the short plan and action/result checklist.

## Compose, do not clone
Masthead (kind of dish, servings and time; a large title, a short lede, prep, cook and oven facts) → ingredients (servings stepper with explicit bounds, ruled checkbox rows with bold quantities, a gathered count) beside the method (large numerals, one Now marker, a done tick per step, a progress line and one primary action). No photo cards and no icon rows of nutrition figures. Below 900px the method follows the ingredients.

The reference is a worked example, not a universal layout. Keep the thesis and derive content order from the user's task. Never copy the example identity (the tomato and white bean braise) into a deliverable. Two unrelated briefs must not become the same skeleton with different text.

## Tokens and typography
`tokens.css` is the executable source of truth. Bind --bg, --surface, --surface-2, --fg, --muted, --border, --border-strong, --accent, --accent-hover and --on-accent; use --success/--danger with a textual label. The accent is tomato for the Now marker, the current numeral and the one primary action; it lightens in dark so it stays readable as text. Light and dark palettes are coordinated, not inverted. Measure the actual rendered foreground/background pairs in every offered theme; a token value or color notation does not prove contrast. Display and numerals: "Bodoni 72", "Bodoni MT", "Bodoni Moda", Didot, Georgia, serif. Body and controls: system-ui, -apple-system, "Segoe UI", sans-serif. All stacks work offline; actual glyphs depend on installed fonts. Never claim a fallback is a supplied brand font. Explicit user typography wins.

## Signature components
`.servings` with `.step[aria-disabled]` and an `output`, `.ingredients` of `label.choice` rows with `.qty`, `.method` of `.method-step` rows (`.step-no`, `.now-tag`, `[data-now]`, `[data-done]`).

## States and honesty
Copy only the components the brief needs. The component view demonstrates primary/secondary/disabled buttons, labelled inputs, an inline error, empty/loading/success states, disclosure and a keyboard-dismissible dialog that returns focus. Keep :focus-visible, 44px targets where practical, reduced motion and reflow at 320px and 200% text. Never express state by color alone. Scaled quantities are rounded and the page says so; never claim nutrition, allergens or prices that are not supplied. Ticks are local.

Prototype interactions must say they are local previews; wire real operations only when they are implemented. A successful animation is not proof that an action succeeded. Copy referenced CSS/JS into the generated project with relative links: an export must not depend on DStudio API URLs. Do not place text over gradients or background images.

## Avoid
Food-photo placeholders as decoration, star ratings, nutrition icon rows, timers that do not run, a card per step, more than one primary action per view.

## Behavior contract

Servings derive every displayed quantity from the same recipe and units. Preserve gathered ingredients and completed steps when scaling; bounds and rounding are explicit. Selecting Now does not complete a step.

Separate editable drafts from committed state. Define each action's input,
validation, owner, visible result and failure/cancellation behavior in the plan.
Derived views must share the committed data; never let a progress animation or
model self-review stand in for a saved result. Keep queues, retained input and
history bounded. In a preview, state belongs to this document and reload resets it;
production persistence and external effects require their own implemented contract.

## Acceptance
Render at 390, 768 and 1440px in both appearances; check 320px and 200% text for overflow and clipping. Operate every control with the keyboard; Escape closes dialogs and focus returns. Measure contrast on rendered pairs. Exercise loading/error/empty/success with real behavior or a clearly labelled demo state. Scale servings from 1 to 12 and past both bounds (a message must explain); quantities must stay readable fractions or rounded weights. Tick ingredients and steps; the counts and the Now marker must follow. A passing preview is not a claim about generated model quality.

After checking the exported files, report what was exercised, what remains
unverified and the actual saved entry path. Recheck affected controls and layouts
after any HTML, CSS or JavaScript repair; do not infer a pass from unchanged markup.
