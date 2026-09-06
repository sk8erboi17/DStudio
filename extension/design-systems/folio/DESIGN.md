---
name: Folio
description: A reading-first journal: warm paper, expressive serif, marginal notes and long horizontal rules.
modes: [design]
ds4_category: editorial
ds4_local_mode: native
ds4_output_kinds: html
ds4_upstream: dstudio-original/folio
---
# Folio — original DStudio system, version 1

## Visual thesis
A publication, not a grid of cards. Place a narrow issue rail beside a large serif headline, then a broad reading column beside a quiet index.

Best fit: Essays, research notes, documentation, independent publications.

## Load before building
Read `tokens.css`, `components.html`, `assets/preview.js` and `references/recipes.md` using `pack_file(type="design_system", name="folio", path="…")`. These are local authored assets, not an external template or framework. The preview has example content, not real customers, metrics, transactions or available bookings.

## Compose, do not clone
Numbered issue rail; asymmetric 2:1 story/index split; 66ch reading measure. Collapse rail into an eyebrow below 760px. Never justify body text.

For a product brief use a numbered explanation plus a working form. For data use a ruled table, never force every row into a story card.

The reference is a worked example, not a universal layout. Preserve the design thesis while deriving content order from the user's task. Do not copy the preview's fictional identity into the deliverable. Two unrelated briefs must not become the same skeleton with different text.

## Tokens and typography
`tokens.css` is the executable source of truth. Bind --bg, --surface, --surface-2, --fg, --muted, --border, --accent and --on-accent; use --success/--danger with textual status labels. It contains coordinated light and dark palettes, not blind color inversion. Display: "Iowan Old Style", "Palatino Linotype", Palatino, Georgia, serif. Body: Georgia, "Times New Roman", serif. All stacks work offline; actual glyphs depend on installed fonts. Never claim a fallback is a supplied brand font. Explicit user typography wins.

## Components and states
Copy only the components required by the brief. The component view demonstrates primary/secondary/disabled buttons, labelled inputs, an error, empty/loading/success states, details and a real keyboard-dismissible dialog. Keep :focus-visible, 44px touch targets where practical, reduced motion and mobile reflow. Do not use color alone to express state.

Prototype interactions must identify themselves as local previews; wire actual backend operations only when implemented. Never claim that a successful animation proves an action succeeded. Copy referenced CSS/JS into the generated project and use relative links there: the exported design must not depend on DStudio API URLs.

## Avoid
No rounded dashboard cards, invented endorsements, giant quote marks, paper textures or ornamental magazine imitations.

## Acceptance
Render at 390, 768 and 1440px in both appearances. Check 320px and 200% text scaling for overflow. Operate controls with keyboard, close the dialog with Escape and verify focus returns. Check readable contrast on actual rendered pairs. Test loading/error/empty/success with real behavior or clearly labelled demo state. Do not convert a local preview into claims about generated model quality.
