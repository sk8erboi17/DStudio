---
name: Canvas
description: A quiet workbench: neutral greys, a central artboard on a dot grid, explicit tools, a precise inspector and bounded undo.
modes: [design]
ds4_category: creative-workspace
ds4_local_mode: native
ds4_output_kinds: html
ds4_upstream: dstudio-original/canvas
---
# Canvas — original DStudio system, version 2

## Visual thesis
The work is the centre. Compact chrome frames an editable artboard; labelled tools and an inspector explain what can change without competing with the composition.

Best fit: Object editors, creative workspaces, diagram tools and visual arrangement prototypes.

## Load before building
Read `tokens.css`, `components.html`, `assets/preview.js` and `references/recipes.md` using `pack_file(type="design_system", name="canvas", path="…")`. These are local authored assets, not an external template or framework. The preview uses example content, not real customers, metrics, transactions or availability.

## Fit the brief

Identify the audience, the primary action and the source of each factual claim.
Preserve explicit user copy, colors, fonts and supplied assets. The composition
below is a starting point: adapt its density, order and proportions to the task.
Record consequential missing decisions; do not invent customers, results or services.
Use only the relevant craft guidance, starting with `craft("state-coverage")`.
Its `references/design-plan.md` provides the short plan and action/result checklist.

## Compose, do not clone
Toolbar (document, history, object count, help) → tools rail | stage with sheet | inspector → status bar. Below 1100px the inspector moves under the stage; below 700px the tools become a row.

The reference is a worked example, not a universal layout. Keep the thesis and derive content order from the user's task. Never copy the example identity (Untitled study and its objects) into a deliverable. Two unrelated briefs must not become the same skeleton with different text.

## Tokens and typography
`tokens.css` is the executable source of truth. Bind --bg, --surface, --surface-2, --fg, --muted, --border, --border-strong, --accent, --accent-hover and --on-accent; use --success/--danger with a textual label. Chartreuse (`--accent`) is a fill and a selection halo with dark text, never text on light surfaces; use `--accent-ink` for accent-coloured text. Light and dark palettes are coordinated, not inverted. Measure the actual rendered foreground/background pairs in every offered theme; a token value or color notation does not prove contrast. Display: system-ui, -apple-system, "Segoe UI", sans-serif. Body: the same stack at 13–15px; values in "SF Mono", "Cascadia Mono", Menlo, Consolas. All stacks work offline; actual glyphs depend on installed fonts. Never claim a fallback is a supplied brand font. Explicit user typography wins.

## Signature components
`.canvas-tools`, `.artboard`, `.canvas-object[data-kind][aria-pressed]`, `.inspector-grid`, `.chip`, `.kbd`.

## States and honesty
Copy only the components the brief needs. The component view demonstrates primary/secondary/disabled buttons, labelled inputs, an inline error, empty/loading/success states, disclosure and a keyboard-dismissible dialog that returns focus. Keep :focus-visible, 44px targets where practical, reduced motion and reflow at 320px and 200% text. Never express state by color alone. Edits are local, bounded (12 objects, 30 history states) and announced; nothing is saved.

Prototype interactions must say they are local previews; wire real operations only when they are implemented. A successful animation is not proof that an action succeeded. Copy referenced CSS/JS into the generated project with relative links: an export must not depend on DStudio API URLs. Do not place text over gradients or background images.

## Avoid
Unlabelled floating toolbars, icon-only tools, unbounded history claims, selection shown by color alone and autosave promises.

## Behavior contract

Selection, inspector and artboard share object identities. Commit a drag only on completion; Escape/cancellation keeps prior coordinates. Undo/redo applies committed edits with explicit history bounds.

Separate editable drafts from committed state. Define each action's input,
validation, owner, visible result and failure/cancellation behavior in the plan.
Derived views must share the committed data; never let a progress animation or
model self-review stand in for a saved result. Keep queues, retained input and
history bounded. In a preview, state belongs to this document and reload resets it;
production persistence and external effects require their own implemented contract.

## Acceptance
Render at 390, 768 and 1440px in both appearances; check 320px and 200% text for overflow and clipping. Operate every control with the keyboard; Escape closes dialogs and focus returns. Measure contrast on rendered pairs. Exercise loading/error/empty/success with real behavior or a clearly labelled demo state. Select by pointer and keyboard, nudge, drag and cancel a drag, reject invalid values, delete and undo, and reach the object limit. A passing preview is not a claim about generated model quality.

After checking the exported files, report what was exercised, what remains
unverified and the actual saved entry path. Recheck affected controls and layouts
after any HTML, CSS or JavaScript repair; do not infer a pass from unchanged markup.
