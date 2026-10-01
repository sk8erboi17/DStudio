---
name: Commons
description: A neighbourhood noticeboard: soft white and lake blue, rounded headings, readable threads, member context and a visible review queue.
modes: [design]
ds4_category: community
ds4_local_mode: native
ds4_output_kinds: html
ds4_upstream: dstudio-original/commons
---
# Commons — original DStudio system, version 2

## Visual thesis
People and conversations, not a marketing hero. A community rail with membership and sections anchors a central stream; context and guidelines sit in a quieter column.

Best fit: Communities, discussion spaces, member directories and collaborative review.

## Load before building
Read `tokens.css`, `components.html`, `assets/preview.js` and `references/recipes.md` using `pack_file(type="design_system", name="commons", path="…")`. These are local authored assets, not an external template or framework. The preview uses example content, not real customers, metrics, transactions or availability.

## Fit the brief

Identify the audience, the primary action and the source of each factual claim.
Preserve explicit user copy, colors, fonts and supplied assets. The composition
below is a starting point: adapt its density, order and proportions to the task.
Record consequential missing decisions; do not invent customers, results or services.
Use only the relevant craft guidance, starting with `craft("state-coverage")`.
Its `references/design-plan.md` provides the short plan and action/result checklist.

## Compose, do not clone
Masthead (name, description, members, one join action) over a heavy rule → section tabs | stream (search and ruled thread rows whose title opens the thread, or one thread with numbered replies and a reply form) | context notes. Rules, alignment and type do the grouping — no cards; secondary actions are text buttons. Below 1180px context follows the stream; below 820px everything stacks.

The reference is a worked example, not a universal layout. Keep the thesis and derive content order from the user's task. Never copy the example identity (Westside Makers and its members) into a deliverable. Two unrelated briefs must not become the same skeleton with different text.

## Tokens and typography
`tokens.css` is the executable source of truth. Bind --bg, --surface, --surface-2, --fg, --muted, --border, --border-strong, --accent, --accent-hover and --on-accent; use --success/--danger with a textual label. Avatar tones (`--tone-1…4`) carry initials with `--on-tone` at full contrast. Light and dark palettes are coordinated, not inverted. Measure the actual rendered foreground/background pairs in every offered theme; a token value or color notation does not prove contrast. Display: ui-rounded, "SF Pro Rounded", "Arial Rounded MT Bold", "Segoe UI", system-ui. Body: system-ui, -apple-system, "Segoe UI", sans-serif. All stacks work offline; actual glyphs depend on installed fonts. Never claim a fallback is a supplied brand font. Explicit user typography wins.

## Signature components
`.avatar[data-tone]`, `.threads` + `.thread-row` with a `.thread-title` button and `.thread-count`, `.replies` (numbered, rule-separated), `.tabs`, `.note`, `.person`, `.report`, `.link-btn`.

## States and honesty
Copy only the components the brief needs. The component view demonstrates primary/secondary/disabled buttons, labelled inputs, an inline error, empty/loading/success states, disclosure and a keyboard-dismissible dialog that returns focus. Keep :focus-visible, 44px targets where practical, reduced motion and reflow at 320px and 200% text. Never express state by color alone. Replies are plain text, local and never published; membership and moderation changes are local and reversible.

Prototype interactions must say they are local previews; wire real operations only when they are implemented. A successful animation is not proof that an action succeeded. Copy referenced CSS/JS into the generated project with relative links: an export must not depend on DStudio API URLs. Do not place text over gradients or background images.

## Avoid
Rounded cards around posts, a bordered button per row, like counts as the main hierarchy, infinite feeds, engagement badges, anonymous moderation and HTML in user text.

## Behavior contract

Keep replies and moderation attached to the correct thread/member. Render entered text literally; reversible local review must preserve prior replies and identify uncommitted external actions.

Separate editable drafts from committed state. Define each action's input,
validation, owner, visible result and failure/cancellation behavior in the plan.
Derived views must share the committed data; never let a progress animation or
model self-review stand in for a saved result. Keep queues, retained input and
history bounded. In a preview, state belongs to this document and reload resets it;
production persistence and external effects require their own implemented contract.

## Acceptance
Render at 390, 768 and 1440px in both appearances; check 320px and 200% text for overflow and clipping. Operate every control with the keyboard; Escape closes dialogs and focus returns. Measure contrast on rendered pairs. Exercise loading/error/empty/success with real behavior or a clearly labelled demo state. Search, open a thread, reject an empty reply, add a literal-text reply, join and leave, open a profile, and resolve then restore a report. A passing preview is not a claim about generated model quality.

After checking the exported files, report what was exercised, what remains
unverified and the actual saved entry path. Recheck affected controls and layouts
after any HTML, CSS or JavaScript repair; do not infer a pass from unchanged markup.
