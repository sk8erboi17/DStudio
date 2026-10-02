---
name: Transit
description: Signage you can trust: white, black and railway red, a humanist sans, departure rows with big times, named line badges, platform signs and a journey drawn on rails.
modes: [design]
ds4_category: travel
ds4_local_mode: native
ds4_output_kinds: html
ds4_upstream: dstudio-original/transit
---
# Transit — original DStudio system, version 1

## Visual thesis
Read it from across the platform. A planner with an honest note about the data leads into departure rows — a large time, named lines, a platform sign and a shaped state — beside the selected journey drawn as a line diagram with stops, changes and a fare.

Best fit: Journey planners, timetables, departures, ticketing, travel booking and logistics status.

## Load before building
Read `tokens.css`, `components.html`, `assets/preview.js` and `references/recipes.md` using `pack_file(type="design_system", name="transit", path="…")`. These are local authored assets, not an external template or framework. The preview uses example content, not real customers, metrics, transactions or availability.

## Fit the brief

Identify the audience, the primary action and the source of each factual claim.
Preserve explicit user copy, colors, fonts and supplied assets. The composition
below is a starting point: adapt its density, order and proportions to the task.
Record consequential missing decisions; do not invent customers, results or services.
Use only the relevant craft guidance, starting with `craft("state-coverage")`.
Its `references/design-plan.md` provides the short plan and action/result checklist.

## Compose, do not clone
Signage band (product, what the data is) → planner: the route as the title, From, swap, To, departure time and a search action → departure rows (the time is the control, named line badges, arrival and duration, platform sign, a shaped state) beside the selected journey (time range, legs drawn on line-colored rails, changes in words, ticket radios, total and one primary action). Below 1000px the journey follows the rows; below 36em of list width rows become stacks.

The reference is a worked example, not a universal layout. Keep the thesis and derive content order from the user's task. Never copy the example identity (Harbour Street, University and lines L1–L4) into a deliverable. Two unrelated briefs must not become the same skeleton with different text.

## Tokens and typography
`tokens.css` is the executable source of truth. Bind --bg, --surface, --surface-2, --fg, --muted, --border, --border-strong, --accent, --accent-hover and --on-accent; use --success/--danger with a textual label. `--line-1` to `--line-4` fill line badges and rails; badge text color is fixed per line so its contrast does not depend on the appearance. `--warn` names delays together with a triangle. The accent is railway red for the one primary action and the selected-row rule. Light and dark palettes are coordinated, not inverted. Measure the actual rendered foreground/background pairs in every offered theme; a token value or color notation does not prove contrast. Display, body and controls: "Gill Sans", "Gill Sans MT", Seravek, Calibri, "Trebuchet MS", sans-serif. Line badges and platform signs use --font-figures (Seravek, "Avenir Next", "Segoe UI", system-ui) so 1 never reads as I. Times use tabular figures. All stacks work offline; actual glyphs depend on installed fonts. Never claim a fallback is a supplied brand font. Explicit user typography wins.

## Signature components
`.journeys` container of `.journey` rows (`.j-open`, `.j-lines`, `.j-dur`, `.j-plat` with `.plat`, `.state[data-state=ontime|late]`), `.line[data-line=1…4]`, `.legs` with `.stop`, `.ride` and `.rail`, `.link-btn`.

## States and honesty
Copy only the components the brief needs. The component view demonstrates primary/secondary/disabled buttons, labelled inputs, an inline error, empty/loading/success states, disclosure and a keyboard-dismissible dialog that returns focus. Keep :focus-visible, 44px targets where practical, reduced motion and reflow at 320px and 200% text. Never express state by color alone. Timetables are illustrative: never claim live departures, real delays or a booked seat. A delay is a word, a number and a shape.

Prototype interactions must say they are local previews; wire real operations only when they are implemented. A successful animation is not proof that an action succeeded. Copy referenced CSS/JS into the generated project with relative links: an export must not depend on DStudio API URLs. Do not place text over gradients or background images.

## Avoid
Maps as decoration, line colors without names, a card per journey, small times, horizontally scrolling timetables, imitation of a real operator’s marks or signage, more than one primary action per view.

## Behavior contract

Departure, arrival, delay, duration and ordered legs agree. Invalid equal/missing stops preserve the last valid journey. Identify timetable examples separately from live services and actual ticket purchases.

Separate editable drafts from committed state. Define each action's input,
validation, owner, visible result and failure/cancellation behavior in the plan.
Derived views must share the committed data; never let a progress animation or
model self-review stand in for a saved result. Keep queues, retained input and
history bounded. In a preview, state belongs to this document and reload resets it;
production persistence and external effects require their own implemented contract.

## Acceptance
Render at 390, 768 and 1440px in both appearances; check 320px and 200% text for overflow and clipping. Operate every control with the keyboard; Escape closes dialogs and focus returns. Measure contrast on rendered pairs. Exercise loading/error/empty/success with real behavior or a clearly labelled demo state. Swap stops, choose a later departure and select another journey; the title, times, legs and count must follow. Search with the same stop twice; an inline error must appear. Change the ticket; the total must update. A passing preview is not a claim about generated model quality.

After checking the exported files, report what was exercised, what remains
unverified and the actual saved entry path. Recheck affected controls and layouts
after any HTML, CSS or JavaScript repair; do not infer a pass from unchanged markup.
