---
name: Manual
description: A reference you can work from: off-white and olive, Lucida text, numbered sections, a dark code panel with language tabs, ruled parameters and notes without boxes.
modes: [design]
ds4_category: documentation
ds4_local_mode: native
ds4_output_kinds: html
ds4_upstream: dstudio-original/manual
---
# Manual — original DStudio system, version 1

## Visual thesis
Documentation is a tool. Numbered sections in a rail, an article with a 72-character measure, real steps, a code panel that switches language and can be selected, ruled parameters and an outline of the page; nothing decorative competes with reading.

Best fit: Developer documentation, API references, product manuals, help centres, changelogs and internal handbooks.

## Load before building
Read `tokens.css`, `components.html`, `assets/preview.js` and `references/recipes.md` using `pack_file(type="design_system", name="manual", path="…")`. These are local authored assets, not an external template or framework. The preview uses example content, not real customers, metrics, transactions or availability.

## Fit the brief

Identify the audience, the primary action and the source of each factual claim.
Preserve explicit user copy, colors, fonts and supplied assets. The composition
below is a starting point: adapt its density, order and proportions to the task.
Record consequential missing decisions; do not invent customers, results or services.
Use only the relevant craft guidance, starting with `craft("state-coverage")`.
Its `references/design-plan.md` provides the short plan and action/result checklist.

## Compose, do not clone
Top rule (product, version, search) → section rail with numbered sections and an announced match count → article: breadcrumb, numbered title, lead, numbered subsections with steps, a note set on a rule, a code panel (language tabs, a select-code action, status), ruled parameters and feedback → outline of the page with one primary action. Below 1180px the outline follows the article; below 820px the rail sits above it.

The reference is a worked example, not a universal layout. Keep the thesis and derive content order from the user's task. Never copy the example identity (the example API, its keys and endpoints) into a deliverable. Two unrelated briefs must not become the same skeleton with different text.

## Tokens and typography
`tokens.css` is the executable source of truth. Bind --bg, --surface, --surface-2, --fg, --muted, --border, --border-strong, --accent, --accent-hover and --on-accent; use --success/--danger with a textual label. `--code-bg`, `--code-fg`, `--code-muted`, `--code-key`, `--code-str` and `--code-rule` form the code palette; it stays dark in both appearances and is measured against its own ground. The accent is olive in light and pale khaki in dark. Light and dark palettes are coordinated, not inverted. Measure the actual rendered foreground/background pairs in every offered theme; a token value or color notation does not prove contrast. Text and headings: "Lucida Grande", "Lucida Sans Unicode", "Lucida Sans", Geneva, Verdana, sans-serif. Code: Monaco, "Lucida Console", "SF Mono", ui-monospace, Menlo, Consolas, monospace. All stacks work offline; actual glyphs depend on installed fonts. Never claim a fallback is a supplied brand font. Explicit user typography wins.

## Signature components
`.toc-list` with `[aria-current]`, `.doc` typography with `.sec-no`, `.steps`, `.note`, `.code` (`.code-tabs`, `pre`, `.c-key`, `.c-str`, `.c-com`, `.code-foot`, `.code-status`), `.params` container rows, `kbd` and `.link-btn`.

## States and honesty
Copy only the components the brief needs. The component view demonstrates primary/secondary/disabled buttons, labelled inputs, an inline error, empty/loading/success states, disclosure and a keyboard-dismissible dialog that returns focus. Keep :focus-visible, 44px targets where practical, reduced motion and reflow at 320px and 200% text. Never express state by color alone. Selecting code is a real selection; never claim something reached the clipboard unless it did. Feedback is local and says nothing was sent. Example keys and hosts must be visibly fake.

Prototype interactions must say they are local previews; wire real operations only when they are implemented. A successful animation is not proof that an action succeeded. Copy referenced CSS/JS into the generated project with relative links: an export must not depend on DStudio API URLs. Do not place text over gradients or background images.

## Avoid
Callout boxes with a colored left border, emoji admonitions, gradient hero banners, horizontally scrolling code, syntax colors that fail contrast, a card per section, more than one primary action per view.

## Behavior contract

Language tabs, selected code and section destinations agree. Preserve exact code bytes and text selection; search exposes a recoverable empty result. Feedback reports whether it was sent or only recorded locally.

Separate editable drafts from committed state. Define each action's input,
validation, owner, visible result and failure/cancellation behavior in the plan.
Derived views must share the committed data; never let a progress animation or
model self-review stand in for a saved result. Keep queues, retained input and
history bounded. In a preview, state belongs to this document and reload resets it;
production persistence and external effects require their own implemented contract.

## Acceptance
Render at 390, 768 and 1440px in both appearances; check 320px and 200% text for overflow and clipping. Operate every control with the keyboard; Escape closes dialogs and focus returns. Measure contrast on rendered pairs. Exercise loading/error/empty/success with real behavior or a clearly labelled demo state. Switch the code language and select the code; the status must say what happened. Search the sections to some and to none; the count must be announced. Send page feedback. A passing preview is not a claim about generated model quality.

After checking the exported files, report what was exercised, what remains
unverified and the actual saved entry path. Recheck affected controls and layouts
after any HTML, CSS or JavaScript repair; do not infer a pass from unchanged markup.
