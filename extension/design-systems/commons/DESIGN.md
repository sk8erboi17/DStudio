---
name: Commons
description: A conversation-first community space with readable threads, member context and an explicit review queue.
modes: [design]
ds4_category: community
ds4_local_mode: native
ds4_output_kinds: html
ds4_upstream: dstudio-original/commons
---
# Commons — original DStudio system, version 1

## Visual thesis

People and conversations, not a marketing hero. A compact vertical community rail anchors a central discussion stream and a quieter context column.

Best fit: Communities, discussion spaces, member directories and collaborative review.

## Load before building

Read `tokens.css`, `components.html`, `assets/preview.js` and
`references/recipes.md` through `pack_file(type="design_system", name="commons", path="…")`.
These are original local assets, not a framework or external service.

## Compose, do not clone

Place community identity and section navigation in a narrow rail, thread content in a readable middle column and membership/context beside it. At narrow widths put navigation above the stream and context below it. Keep thread authors, labels and reply counts distinct from controls.

For a membership brief, center the people directory and make threads secondary. For review work, use a queue-detail layout with reversible, visibly local decisions rather than moderation controls mixed into every card.

Derive the actual content order and controls from the brief. Do not copy the
fictional preview identity into the output. Two different briefs need different
compositions, not just new words or colors. Explicit user choices take precedence.

## Tokens and typography

The executable `tokens.css` defines coordinated light/dark roles for background,
surfaces, foreground, muted text, borders, accent and status. Display uses
"Trebuchet MS", Arial, sans-serif; body uses "Segoe UI", Arial, sans-serif. These are local fallback stacks,
not bundled brand fonts. Preserve readable contrast, focus indicators and labels.

## Interaction and ownership

The preview filters three fictional threads, opens discussions, adds up to ten local replies per thread, toggles demo membership and resolves/restores two fixture reports. Profile and review states are examples, never actions on real people or accounts.

State is owned by the preview document and lost on reload. The agent must implement
actual persistence or external actions separately when requested; a preview
confirmation never proves a purchase, publication, file save or backend operation.
Keep limits and error states explicit. User text enters text nodes, not HTML.

## Acceptance and export

Render at 320/390/768/1440 px in light and dark. Test 200% text, keyboard navigation,
form validation, choices, empty state, dialog Escape/focus return and all domain
controls. Radio/checkbox labels keep a separate indicator column when wrapping.
Do not hide overflowing page content. Map/artboard viewports may scroll locally
when clearly labelled, with a fully keyboard-operable alternative.

Copy the needed CSS and JS beside the generated HTML and update relative links.
Export must work without DStudio, remote fonts, CDNs or APIs. Omit the catalog lab
bar from client work. Fixed preview fixtures and successful static tests do not
constitute model-generated quality evidence.
