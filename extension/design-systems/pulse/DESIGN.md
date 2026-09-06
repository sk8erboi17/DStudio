---
name: Pulse
description: An expressive programme: acid-yellow fields, condensed headlines, hard rules and a scannable timetable.
modes: [design]
ds4_category: culture
ds4_local_mode: native
ds4_output_kinds: html
ds4_upstream: dstudio-original/pulse
---
# Pulse — original DStudio system, version 1

## Visual thesis
A public programme with poster energy. Giant condensed type meets strict practical information: dates, locations, accessible controls and a timetable.

Best fit: Events, workshops, cultural programmes, expressive launches.

## Load before building
Read `tokens.css`, `components.html`, `assets/preview.js` and `references/recipes.md` using `pack_file(type="design_system", name="pulse", path="…")`. These are local authored assets, not an external template or framework. The preview has example content, not real customers, metrics, transactions or available bookings.

## Compose, do not clone
Full-width typographic stage, large day number beside a ruled programme, hard-edged buttons with honest 2px offset shadow. Mobile keeps times and titles together; never rotate essential text.

For a product use a chronological demo rather than a timetable. Dial display size down for dense tasks, but retain strong rules and clear action contrast.

The reference is a worked example, not a universal layout. Preserve the design thesis while deriving content order from the user's task. Do not copy the preview's fictional identity into the deliverable. Two unrelated briefs must not become the same skeleton with different text.

## Tokens and typography
`tokens.css` is the executable source of truth. Bind --bg, --surface, --surface-2, --fg, --muted, --border, --accent and --on-accent; use --success/--danger with textual status labels. It contains coordinated light and dark palettes, not blind color inversion. Display: Impact, "Arial Narrow", "Franklin Gothic Medium", sans-serif. Body: Arial, Helvetica, sans-serif. All stacks work offline; actual glyphs depend on installed fonts. Never claim a fallback is a supplied brand font. Explicit user typography wins.

## Components and states
Copy only the components required by the brief. The component view demonstrates primary/secondary/disabled buttons, labelled inputs, an error, empty/loading/success states, details and a real keyboard-dismissible dialog. Keep :focus-visible, 44px touch targets where practical, reduced motion and mobile reflow. Do not use color alone to express state.

Prototype interactions must identify themselves as local previews; wire actual backend operations only when implemented. Never claim that a successful animation proves an action succeeded. Copy referenced CSS/JS into the generated project and use relative links there: the exported design must not depend on DStudio API URLs.

## Avoid
No flashing, autoplay, infinitely moving marquees, ransom-note type mixing, unreadable neon on white or fake sell-out urgency.

## Acceptance
Render at 390, 768 and 1440px in both appearances. Check 320px and 200% text scaling for overflow. Operate controls with keyboard, close the dialog with Escape and verify focus returns. Check readable contrast on actual rendered pairs. Test loading/error/empty/success with real behavior or clearly labelled demo state. Do not convert a local preview into claims about generated model quality.
