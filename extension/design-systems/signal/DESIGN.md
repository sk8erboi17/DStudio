---
name: Signal
description: An instrument panel: charcoal surfaces, mint signals, tabular readings and a persistent work queue.
modes: [design]
ds4_category: tools
ds4_local_mode: native
ds4_output_kinds: html
ds4_upstream: dstudio-original/signal
---
# Signal — original DStudio system, version 1

## Visual thesis
A working instrument. A slim navigation rail, strong numeric readout, visible units and operational rows give the page its hierarchy.

Best fit: Developer tools, labs, project operations, inventory, analytical products.

## Load before building
Read `tokens.css`, `components.html`, `assets/preview.js` and `references/recipes.md` using `pack_file(type="design_system", name="signal", path="…")`. These are local authored assets, not an external template or framework. The preview has example content, not real customers, metrics, transactions or available bookings.

## Compose, do not clone
Desktop 180px rail and flexible main canvas. Align readings on a baseline, always put units beside values. Scroll dense tables inside a labelled region at narrow widths; never overflow the page.

For public-facing pages replace the rail with a compact top bar and show one real workflow before feature claims. Never invent uptime or performance data.

The reference is a worked example, not a universal layout. Preserve the design thesis while deriving content order from the user's task. Do not copy the preview's fictional identity into the deliverable. Two unrelated briefs must not become the same skeleton with different text.

## Tokens and typography
`tokens.css` is the executable source of truth. Bind --bg, --surface, --surface-2, --fg, --muted, --border, --accent and --on-accent; use --success/--danger with textual status labels. It contains coordinated light and dark palettes, not blind color inversion. Display: "SFMono-Regular", Consolas, "Liberation Mono", monospace. Body: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif. All stacks work offline; actual glyphs depend on installed fonts. Never claim a fallback is a supplied brand font. Explicit user typography wins.

## Components and states
Copy only the components required by the brief. The component view demonstrates primary/secondary/disabled buttons, labelled inputs, an error, empty/loading/success states, details and a real keyboard-dismissible dialog. Keep :focus-visible, 44px touch targets where practical, reduced motion and mobile reflow. Do not use color alone to express state.

Prototype interactions must identify themselves as local previews; wire actual backend operations only when implemented. Never claim that a successful animation proves an action succeeded. Copy referenced CSS/JS into the generated project and use relative links there: the exported design must not depend on DStudio API URLs.

## Avoid
No fake live badges, meaningless sparklines, terminal cosplay, giant marketing hero or decorative telemetry.

## Acceptance
Render at 390, 768 and 1440px in both appearances. Check 320px and 200% text scaling for overflow. Operate controls with keyboard, close the dialog with Escape and verify focus returns. Check readable contrast on actual rendered pairs. Test loading/error/empty/success with real behavior or clearly labelled demo state. Do not convert a local preview into claims about generated model quality.
