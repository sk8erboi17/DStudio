---
name: Relay
description: Correspondence, not chatter: porcelain and teal ink, a reading serif for messages, names in the margin, quiet day rules and unread marked in words.
modes: [design]
ds4_category: messaging
ds4_local_mode: native
ds4_output_kinds: html
ds4_upstream: dstudio-original/relay
---
# Relay — original DStudio system, version 1

## Visual thesis
Conversations should read like letters. A ruled list of conversations sits beside a transcript set in a reading serif, with sender and time in the margin, and a composer that is a writing surface rather than a bubble.

Best fit: Messaging, inboxes, support conversations, comment threads, client correspondence and any product where people write to each other.

## Load before building
Read `tokens.css`, `components.html`, `assets/preview.js` and `references/recipes.md` using `pack_file(type="design_system", name="relay", path="…")`. These are local authored assets, not an external template or framework. The preview uses example content, not real customers, metrics, transactions or availability.

## Fit the brief

Identify the audience, the primary action and the source of each factual claim.
Preserve explicit user copy, colors, fonts and supplied assets. The composition
below is a starting point: adapt its density, order and proportions to the task.
Record consequential missing decisions; do not invent customers, results or services.
Use only the relevant craft guidance, starting with `craft("state-coverage")`.
Its `references/design-plan.md` provides the short plan and action/result checklist.

## Compose, do not clone
Conversation column (title, search with an announced count, ruled rows: who, time, a clipped last line and an unread word) beside the open conversation: heading with participants and one quiet text action → transcript with day rules and margin names → composer with a visible label, a note about delivery and one primary send action. No bubbles, avatar stacks or card wrappers. Below 900px the list sits above the conversation; below 30em of transcript width names move above each message.

The reference is a worked example, not a universal layout. Keep the thesis and derive content order from the user's task. Never copy the example identity (Mira Okafor, Halden Print Works and the example messages) into a deliverable. Two unrelated briefs must not become the same skeleton with different text.

## Tokens and typography
`tokens.css` is the executable source of truth. Bind --bg, --surface, --surface-2, --fg, --muted, --border, --border-strong, --accent, --accent-hover and --on-accent; use --success/--danger with a textual label. The accent is teal ink for your own name, the open-row rule and the unread mark; in dark it lightens so it stays readable as text. Light and dark palettes are coordinated, not inverted. Measure the actual rendered foreground/background pairs in every offered theme; a token value or color notation does not prove contrast. Display and messages: Palatino, "Palatino Linotype", "Book Antiqua", "URW Palladio L", Georgia, serif. Lists and controls: system-ui, -apple-system, "Segoe UI", sans-serif. All stacks work offline; actual glyphs depend on installed fonts. Never claim a fallback is a supplied brand font. Explicit user typography wins.

## Signature components
`.convos` of `.convo` rows with a `.convo-open` control (`.convo-who`, `.convo-time`, `.convo-snippet`, `.convo-new`), a `.transcript` container with `.day` rules and `.msg` (`.msg-meta`, `.msg-body`), `.compose` with `.compose-foot`, `.link-btn`.

## States and honesty
Copy only the components the brief needs. The component view demonstrates primary/secondary/disabled buttons, labelled inputs, an inline error, empty/loading/success states, disclosure and a keyboard-dismissible dialog that returns focus. Keep :focus-visible, 44px targets where practical, reduced motion and reflow at 320px and 200% text. Never express state by color alone. Sending appends text locally and says nothing was delivered; never show delivered, read or typing states that did not happen. Message text is inserted as text, never as HTML.

Prototype interactions must say they are local previews; wire real operations only when they are implemented. A successful animation is not proof that an action succeeded. Copy referenced CSS/JS into the generated project with relative links: an export must not depend on DStudio API URLs. Do not place text over gradients or background images.

## Avoid
Two-color chat bubbles, avatar walls, fake typing indicators, red unread circles, decorative emoji reactions, a card around each message, more than one primary action per view.

## Behavior contract

Replies belong to the conversation selected at commit. Keep drafts and reading/selection stable during incoming updates; reject empty replies and render text literally. An unread flag is not a delivery receipt.

The authored preview admits at most 20 new replies per conversation, with each
trimmed reply limited to 1000 JavaScript string units. Rejection keeps prior
messages and the typed draft; no delivery or persistence is implied. Choose and
test product bounds against the real owner's contract rather than copying demo
limits into an unrelated application.

Separate editable drafts from committed state. Define each action's input,
validation, owner, visible result and failure/cancellation behavior in the plan.
Derived views must share the committed data; never let a progress animation or
model self-review stand in for a saved result. Keep queues, retained input and
history bounded. In a preview, state belongs to this document and reload resets it;
production persistence and external effects require their own implemented contract.

## Acceptance
Render at 390, 768 and 1440px in both appearances; check 320px and 200% text for overflow and clipping. Operate every control with the keyboard; Escape closes dialogs and focus returns. Measure contrast on rendered pairs. Exercise loading/error/empty/success with real behavior or a clearly labelled demo state. Search conversations to one and to none; the count and the empty state must be announced. Send an empty reply (an inline error must appear) and a real one (it must appear as text). A passing preview is not a claim about generated model quality.

After checking the exported files, report what was exercised, what remains
unverified and the actual saved entry path. Recheck affected controls and layouts
after any HTML, CSS or JavaScript repair; do not infer a pass from unchanged markup.
