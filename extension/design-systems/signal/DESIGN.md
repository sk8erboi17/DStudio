---
name: Signal
description: An instrument panel for work: graphite and amber, monospaced readings with units, aligned rows and shaped, named states.
modes: [design]
ds4_category: tools
ds4_local_mode: native
ds4_output_kinds: html
ds4_upstream: dstudio-original/signal
---
# Signal — original DStudio system, version 2

## Visual thesis
A working instrument. A slim rail and a top bar frame readings with visible units, a filterable queue whose rows align and an inspector for the selected item. Dark is the default appearance; light is fully supported.

Best fit: Developer tools, labs, operations, inventory, monitoring and analytical products.

## Load before building
Read `tokens.css`, `components.html`, `assets/preview.js` and `references/recipes.md` using `pack_file(type="design_system", name="signal", path="…")`. These are local authored assets, not an external template or framework. The preview uses example content, not real customers, metrics, transactions or availability.

## Fit the brief

Identify the audience, the primary action and the source of each factual claim.
Preserve explicit user copy, colors, fonts and supplied assets. The composition
below is a starting point: adapt its density, order and proportions to the task.
Record consequential missing decisions; do not invent customers, results or services.
Use only the relevant craft guidance, starting with `craft("state-coverage")`.
Its `references/design-plan.md` provides the short plan and action/result checklist.

## Compose, do not clone
Top rule (product, breadcrumb, sync time) → rail and main. Main: heading → up to four readings on a ruled strip → queue with filter beside an inspector → activity log. Regions are separated by rules and alignment, never boxed in cards; a row title is the control that selects it, and the inspector holds the single primary action. Below 1180px the inspector follows the queue; below 900px the rail wraps above and rows become labelled stacks.

The reference is a worked example, not a universal layout. Keep the thesis and derive content order from the user's task. Never copy the example identity (Northline and its NL items) into a deliverable. Two unrelated briefs must not become the same skeleton with different text.

## Tokens and typography
`tokens.css` is the executable source of truth. Bind --bg, --surface, --surface-2, --fg, --muted, --border, --border-strong, --accent, --accent-hover and --on-accent; use --success/--danger with a textual label. `--info` names review states. The accent is amber in dark and bronze in light so it stays readable as text. Light and dark palettes are coordinated, not inverted. Measure the actual rendered foreground/background pairs in every offered theme; a token value or color notation does not prove contrast. Display: system-ui, -apple-system, "Segoe UI", sans-serif (semibold). Body: the same system stack; numbers in "SF Mono", "Cascadia Mono", "JetBrains Mono", Menlo, Consolas. All stacks work offline; actual glyphs depend on installed fonts. Never claim a fallback is a supplied brand font. Explicit user typography wins.

## Signature components
`.readings` strip with `.reading` (dt, `.num`, `.unit`, note, `.is-alert`), `.state[data-state=active|review|blocked|queued|ready]` with a distinct shape per state, `.kv`, `.log`, queue rows with `[data-record]`, a text-styled row control and a `[data-filter]` input.

## States and honesty
Copy only the components the brief needs. The component view demonstrates primary/secondary/disabled buttons, labelled inputs, an inline error, empty/loading/success states, disclosure and a keyboard-dismissible dialog that returns focus. Keep :focus-visible, 44px targets where practical, reduced motion and reflow at 320px and 200% text. Never express state by color alone. Readings and spark bars are example values: label them and never animate numbers to suggest live data.

Prototype interactions must say they are local previews; wire real operations only when they are implemented. A successful animation is not proof that an action succeeded. Copy referenced CSS/JS into the generated project with relative links: an export must not depend on DStudio API URLs. Do not place text over gradients or background images.

## Avoid
Boxed cards around every region, a button per row, more than one primary action per view, neon glows, gradient KPI cards, decorative charts without a question, color-only status, horizontal-scroll tables, more than four readings above the queue.

## Behavior contract

Keep values, units, severity labels and selected-record details consistent. Filtering changes the visible subset, never the underlying records or their status.

Separate editable drafts from committed state. Define each action's input,
validation, owner, visible result and failure/cancellation behavior in the plan.
Derived views must share the committed data; never let a progress animation or
model self-review stand in for a saved result. Keep queues, retained input and
history bounded. In a preview, state belongs to this document and reload resets it;
production persistence and external effects require their own implemented contract.

## Acceptance
Render at 390, 768 and 1440px in both appearances; check 320px and 200% text for overflow and clipping. Operate every control with the keyboard; Escape closes dialogs and focus returns. Measure contrast on rendered pairs. Exercise loading/error/empty/success with real behavior or a clearly labelled demo state. Filter the queue to one item and to none; the empty message must be announced. A passing preview is not a claim about generated model quality.

After checking the exported files, report what was exercised, what remains
unverified and the actual saved entry path. Recheck affected controls and layouts
after any HTML, CSS or JavaScript repair; do not infer a pass from unchanged markup.
