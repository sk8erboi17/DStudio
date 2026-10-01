---
name: Counter
description: A landing page where you work out the price: cream and black, Impact capitals, two sliders, a pink price tag with black numerals, a breakdown in words and the plans as one table.
modes: [design]
ds4_category: landing
ds4_local_mode: native
ds4_output_kinds: html
ds4_upstream: dstudio-original/counter
---
# Counter — original DStudio system, version 1

## Visual thesis
The price is the pitch. The hero is an estimator: two sliders and two add-ons beside a price tag whose number is the real monthly price, with every euro written out underneath. The plan it chooses is underlined in one comparison table below.

Best fit: Pricing pages and landing pages for management software, usage-priced SaaS, services with calculable quotes and any product whose main objection is cost.

## Load before building
Read `tokens.css`, `components.html`, `assets/preview.js` and `references/recipes.md` using `pack_file(type="design_system", name="counter", path="…")`. These are local authored assets, not an external template or framework. The preview uses example content, not real customers, metrics, transactions or availability.

## Fit the brief

Identify the audience, the primary action and the source of each factual claim.
Preserve explicit user copy, colors, fonts and supplied assets. The composition
below is a starting point: adapt its density, order and proportions to the task.
Record consequential missing decisions; do not invent customers, results or services.
Use only the relevant craft guidance, starting with `craft("state-coverage")`.
Its `references/design-plan.md` provides the short plan and action/result checklist.

## Compose, do not clone
Top line (name and what it is) → hero: eyebrow, a question as the headline, one sentence, sliders with visible values and add-on checkboxes beside the quote (plan name, price tag, breakdown in words, one primary action named after the plan, an honest note) → plans as a single table with the chosen plan underlined → questions about the bill. No feature cards, no logo wall, no “contact sales” hiding the number.

The reference is a worked example, not a universal layout. Keep the thesis and derive content order from the user's task. Never copy the example identity (Tessera and its example plans) into a deliverable. Two unrelated briefs must not become the same skeleton with different text.

## Tokens and typography
`tokens.css` is the executable source of truth. Bind --bg, --surface, --surface-2, --fg, --muted, --border, --border-strong, --accent, --accent-hover and --on-accent; use --success/--danger with a textual label. `--tag` and `--on-tag` are the price-tag pair: pink with black text in both appearances. The accent is a deep rose for the action, links and the chosen-plan underline; it lightens in dark. Light and dark palettes are coordinated, not inverted. Measure the actual rendered foreground/background pairs in every offered theme; a token value or color notation does not prove contrast. Display and the price: Impact, Haettenschweiler, "Arial Narrow Bold", "Franklin Gothic Bold", sans-serif, in capitals. Body and controls: system-ui, -apple-system, "Segoe UI", sans-serif. All stacks work offline; actual glyphs depend on installed fonts. Never claim a fallback is a supplied brand font. Explicit user typography wins.

## Signature components
`.price-tag` (`.price-cur`, `output`, `.price-per`), `.out` for slider values, `.breakdown`, a `.matrix` container of `.m-row` with `[data-plan]` cells and `.is-current`.

## States and honesty
Copy only the components the brief needs. The component view demonstrates primary/secondary/disabled buttons, labelled inputs, an inline error, empty/loading/success states, disclosure and a keyboard-dismissible dialog that returns focus. Keep :focus-visible, 44px targets where practical, reduced motion and reflow at 320px and 200% text. Never express state by color alone. Prices are examples and exclude VAT; the estimate equals the sum of the written lines and nothing is charged in the preview. Never show a crossed-out “original” price or a fake discount timer.

Prototype interactions must say they are local previews; wire real operations only when they are implemented. A successful animation is not proof that an action succeeded. Copy referenced CSS/JS into the generated project with relative links: an export must not depend on DStudio API URLs. Do not place text over gradients or background images.

## Avoid
Three floating pricing cards, a highlighted “most popular” plan that the estimate did not choose, contact-sales walls, countdowns, gradients behind the price, more than one primary action.

## Behavior contract

Seat count, volume, add-ons, plan recommendation, price and breakdown use the same validated inputs. State billing period, rounding and limits; changing a slider cannot commit a purchase.

Separate editable drafts from committed state. Define each action's input,
validation, owner, visible result and failure/cancellation behavior in the plan.
Derived views must share the committed data; never let a progress animation or
model self-review stand in for a saved result. Keep queues, retained input and
history bounded. In a preview, state belongs to this document and reload resets it;
production persistence and external effects require their own implemented contract.

## Acceptance
Render at 390, 768 and 1440px in both appearances; check 320px and 200% text for overflow and clipping. Operate every control with the keyboard; Escape closes dialogs and focus returns. Measure contrast on rendered pairs. Exercise loading/error/empty/success with real behavior or a clearly labelled demo state. Move both sliders across their range and toggle the add-ons; the tag, breakdown, plan name, action label and underlined column must agree at every step. A passing preview is not a claim about generated model quality.

After checking the exported files, report what was exercised, what remains
unverified and the actual saved entry path. Recheck affected controls and layouts
after any HTML, CSS or JavaScript repair; do not infer a pass from unchanged markup.
