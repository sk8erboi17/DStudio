---
name: Forma
description: A spatial portfolio: precise cobalt, oversized sans type, squared frames and a deliberate project rhythm.
modes: [design]
ds4_category: portfolio
ds4_local_mode: native
ds4_output_kinds: html
ds4_upstream: dstudio-original/forma
---
# Forma — original DStudio system, version 1

## Visual thesis
Architecture expressed with type and planes. One large statement, a measured project index and unequal display areas; whitespace is structural.

Best fit: Studios, portfolios, architecture, product presentations.

## Load before building
Read `tokens.css`, `components.html`, `assets/preview.js` and `references/recipes.md` using `pack_file(type="design_system", name="forma", path="…")`. These are local authored assets, not an external template or framework. The preview has example content, not real customers, metrics, transactions or available bookings.

## Compose, do not clone
12-column desktop grid with an 8/4 project split, oversized but clamped sans headline, flush-left captions and explicit project numbers. Stack at 760px while keeping project order.

For a service use the same number/project rhythm for stages and deliverables. Use supplied photography when it exists; geometric studies are labelled as studies.

The reference is a worked example, not a universal layout. Preserve the design thesis while deriving content order from the user's task. Do not copy the preview's fictional identity into the deliverable. Two unrelated briefs must not become the same skeleton with different text.

## Tokens and typography
`tokens.css` is the executable source of truth. Bind --bg, --surface, --surface-2, --fg, --muted, --border, --accent and --on-accent; use --success/--danger with textual status labels. It contains coordinated light and dark palettes, not blind color inversion. Display: "Helvetica Neue", Arial, sans-serif. Body: Arial, Helvetica, sans-serif. All stacks work offline; actual glyphs depend on installed fonts. Never claim a fallback is a supplied brand font. Explicit user typography wins.

## Components and states
Copy only the components required by the brief. The component view demonstrates primary/secondary/disabled buttons, labelled inputs, an error, empty/loading/success states, details and a real keyboard-dismissible dialog. Keep :focus-visible, 44px touch targets where practical, reduced motion and mobile reflow. Do not use color alone to express state.

Prototype interactions must identify themselves as local previews; wire actual backend operations only when implemented. Never claim that a successful animation proves an action succeeded. Copy referenced CSS/JS into the generated project and use relative links there: the exported design must not depend on DStudio API URLs.

## Avoid
No glass panels, full-page gradients, generic feature bento, fake client logos or unlabelled abstract art masquerading as product imagery.

## Acceptance
Render at 390, 768 and 1440px in both appearances. Check 320px and 200% text scaling for overflow. Operate controls with keyboard, close the dialog with Escape and verify focus returns. Check readable contrast on actual rendered pairs. Test loading/error/empty/success with real behavior or clearly labelled demo state. Do not convert a local preview into claims about generated model quality.
