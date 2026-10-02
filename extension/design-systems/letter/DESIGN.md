---
name: Letter
description: A landing page written as a letter: warm paper and sepia ink, one book serif, a quoted headline, a salutation, ruled benefits, the price as a sentence and a signature.
modes: [design]
ds4_category: landing
ds4_local_mode: native
ds4_output_kinds: html
ds4_upstream: dstudio-original/letter
---
# Letter — original DStudio system, version 1

## Visual thesis
Persuade the way a person would. One column at reading measure: a quoted headline, a dateline and a salutation, three benefits as a ruled list, the price written as a sentence with one billing choice, one primary action, a signature and the questions people really ask.

Best fit: Landing pages for small software products and management tools, founder-led launches, waitlists, pricing pages for one plan and announcements.

## Load before building
Read `tokens.css`, `components.html`, `assets/preview.js` and `references/recipes.md` using `pack_file(type="design_system", name="letter", path="…")`. These are local authored assets, not an external template or framework. The preview uses example content, not real customers, metrics, transactions or availability.

## Fit the brief

Identify the audience, the primary action and the source of each factual claim.
Preserve explicit user copy, colors, fonts and supplied assets. The composition
below is a starting point: adapt its density, order and proportions to the task.
Record consequential missing decisions; do not invent customers, results or services.
Use only the relevant craft guidance, starting with `craft("state-coverage")`.
Its `references/design-plan.md` provides the short plan and action/result checklist.

## Compose, do not clone
Thin top rule (name, three anchors) → letter column: eyebrow, quoted headline, dateline, salutation, two or three short paragraphs, ruled benefits → price section between double rules (billing choice, the price as a sentence, one primary action and a quieter text link, an honest note) → signature → questions as disclosures. No hero image, no feature cards, no logo wall, no testimonial carousel.

The reference is a worked example, not a universal layout. Keep the thesis and derive content order from the user's task. Never copy the example identity (Abaco and the four people who sign the letter) into a deliverable. Two unrelated briefs must not become the same skeleton with different text.

## Tokens and typography
`tokens.css` is the executable source of truth. Bind --bg, --surface, --surface-2, --fg, --muted, --border, --border-strong, --accent, --accent-hover and --on-accent; use --success/--danger with a textual label. The accent is sepia ink for links, benefit terms and the one primary action; it lightens to parchment gold in dark. Light and dark palettes are coordinated, not inverted. Measure the actual rendered foreground/background pairs in every offered theme; a token value or color notation does not prove contrast. Everything: "Hoefler Text", "Sitka Text", Cambria, Georgia, serif — small caps for benefit terms and the signature. All stacks work offline; actual glyphs depend on installed fonts. Never claim a fallback is a supplied brand font. Explicit user typography wins.

## Signature components
`.letter` column with a hanging quoted `h1`, `.dateline`, `.benefits`, `.price-sentence`, `.inline-choices`, `.signature`, disclosures for questions.

## States and honesty
Copy only the components the brief needs. The component view demonstrates primary/secondary/disabled buttons, labelled inputs, an inline error, empty/loading/success states, disclosure and a keyboard-dismissible dialog that returns focus. Keep :focus-visible, 44px targets where practical, reduced motion and reflow at 320px and 200% text. Never express state by color alone. Prices are examples and the trial starts nothing in the preview. Never invent testimonials, customer counts or logos; a letter is signed only by people who exist in the brief.

Prototype interactions must say they are local previews; wire real operations only when they are implemented. A successful animation is not proof that an action succeeded. Copy referenced CSS/JS into the generated project with relative links: an export must not depend on DStudio API URLs. Do not place text over gradients or background images.

## Avoid
Gradient heroes, feature-card rows, logo walls, testimonial carousels, three-tier pricing grids, countdown timers, more than one primary action.

## Behavior contract

The chosen billing interval, price sentence and trial-dialog summary agree. Preserve supplied copy and source claims; FAQ controls work with a keyboard. A trial preview cannot claim an account was created.

Separate editable drafts from committed state. Define each action's input,
validation, owner, visible result and failure/cancellation behavior in the plan.
Derived views must share the committed data; never let a progress animation or
model self-review stand in for a saved result. Keep queues, retained input and
history bounded. In a preview, state belongs to this document and reload resets it;
production persistence and external effects require their own implemented contract.

## Acceptance
Render at 390, 768 and 1440px in both appearances; check 320px and 200% text for overflow and clipping. Operate every control with the keyboard; Escape closes dialogs and focus returns. Measure contrast on rendered pairs. Exercise loading/error/empty/success with real behavior or a clearly labelled demo state. Switch billing; the price sentence must change and be announced. Open each question with the keyboard. Start the trial; the dialog must say nothing was sent. A passing preview is not a claim about generated model quality.

After checking the exported files, report what was exercised, what remains
unverified and the actual saved entry path. Recheck affected controls and layouts
after any HTML, CSS or JavaScript repair; do not infer a pass from unchanged markup.
