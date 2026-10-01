---
name: Pulse
description: A poster that works: newsprint and black, fluorescent orange fields, condensed capitals, 2px rules and a readable timetable.
modes: [design]
ds4_category: culture
ds4_local_mode: native
ds4_output_kinds: html
ds4_upstream: dstudio-original/pulse
---
# Pulse — original DStudio system, version 2

## Visual thesis
A public programme with poster energy. A huge condensed title and an orange band carry the identity; strict practical information — days, times, rooms, access and prices — carries the use.

Best fit: Festivals, events, workshops, cultural programmes and expressive launches.

## Load before building
Read `tokens.css`, `components.html`, `assets/preview.js` and `references/recipes.md` using `pack_file(type="design_system", name="pulse", path="…")`. These are local authored assets, not an external template or framework. The preview uses example content, not real customers, metrics, transactions or availability.

## Fit the brief

Identify the audience, the primary action and the source of each factual claim.
Preserve explicit user copy, colors, fonts and supplied assets. The composition
below is a starting point: adapt its density, order and proportions to the task.
Record consequential missing decisions; do not invent customers, results or services.
Use only the relevant craft guidance, starting with `craft("state-coverage")`.
Its `references/design-plan.md` provides the short plan and action/result checklist.

## Compose, do not clone
Meta bar → giant title → orange band (dates, one sentence, ticket action) → programme heading with a day switch → slots (time, title, room · format · duration, tag, details) → access facts beside tickets. Below 900px the band and access stack.

The reference is a worked example, not a universal layout. Keep the thesis and derive content order from the user's task. Never copy the example identity (Night Shift and its events) into a deliverable. Two unrelated briefs must not become the same skeleton with different text.

## Tokens and typography
`tokens.css` is the executable source of truth. Bind --bg, --surface, --surface-2, --fg, --muted, --border, --border-strong, --accent, --accent-hover and --on-accent; use --success/--danger with a textual label. Orange (`--accent`) is a surface with black type; it is never text on paper. Links and focus use `--fg`. Light and dark palettes are coordinated, not inverted. Measure the actual rendered foreground/background pairs in every offered theme; a token value or color notation does not prove contrast. Display: "Avenir Next Condensed", "DIN Condensed", "Bahnschrift Condensed", "Arial Narrow", sans-serif with font-stretch: condensed, in capitals. Body: "Helvetica Neue", Arial, "Segoe UI", sans-serif; times in a monospace or the display stack. All stacks work offline; actual glyphs depend on installed fonts. Never claim a fallback is a supplied brand font. Explicit user typography wins.

## Signature components
`.band`, `.daybar`, `.slot`, `.tag` and `.tag.is-hot`, `.ticket-list`, `.rule`.

## States and honesty
Copy only the components the brief needs. The component view demonstrates primary/secondary/disabled buttons, labelled inputs, an inline error, empty/loading/success states, disclosure and a keyboard-dismissible dialog that returns focus. Keep :focus-visible, 44px targets where practical, reduced motion and reflow at 320px and 200% text. Never express state by color alone. Availability tags (few left, sold out) are example states; never imply real scarcity.

Prototype interactions must say they are local previews; wire real operations only when they are implemented. A successful animation is not proof that an action succeeded. Copy referenced CSS/JS into the generated project with relative links: an export must not depend on DStudio API URLs. Do not place text over gradients or background images.

## Avoid
Neon gradients, glitch effects, rotated text that hides information, image-only posters and orange text on paper.

## Behavior contract

The selected programme/day and the visible timetable must agree. Retain meaningful titles, times and accessible alternatives when the poster layout stacks.

Separate editable drafts from committed state. Define each action's input,
validation, owner, visible result and failure/cancellation behavior in the plan.
Derived views must share the committed data; never let a progress animation or
model self-review stand in for a saved result. Keep queues, retained input and
history bounded. In a preview, state belongs to this document and reload resets it;
production persistence and external effects require their own implemented contract.

## Acceptance
Render at 390, 768 and 1440px in both appearances; check 320px and 200% text for overflow and clipping. Operate every control with the keyboard; Escape closes dialogs and focus returns. Measure contrast on rendered pairs. Exercise loading/error/empty/success with real behavior or a clearly labelled demo state. Switch days with the keyboard; the status names the day and the number of events. A passing preview is not a claim about generated model quality.

After checking the exported files, report what was exercised, what remains
unverified and the actual saved entry path. Recheck affected controls and layouts
after any HTML, CSS or JavaScript repair; do not infer a pass from unchanged markup.
