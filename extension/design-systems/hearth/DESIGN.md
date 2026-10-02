---
name: Hearth
description: A warm house, plainly controlled: plaster and terracotta, a sturdy slab serif, rooms as text tabs, devices as ruled rows with named switches and a dial that states its limits.
modes: [design]
ds4_category: home
ds4_local_mode: native
ds4_output_kinds: html
ds4_upstream: dstudio-original/hearth
---
# Hearth — original DStudio system, version 1

## Visual thesis
Control without a dashboard of tiles. One room at a time: devices as ruled rows with a named switch and, for lights, a brightness slider; heating as one dial with explicit bounds; scenes as described choices.

Best fit: Smart home and building controls, device settings, connected products, comfort and energy apps.

## Load before building
Read `tokens.css`, `components.html`, `assets/preview.js` and `references/recipes.md` using `pack_file(type="design_system", name="hearth", path="…")`. These are local authored assets, not an external template or framework. The preview uses example content, not real customers, metrics, transactions or availability.

## Fit the brief

Identify the audience, the primary action and the source of each factual claim.
Preserve explicit user copy, colors, fonts and supplied assets. The composition
below is a starting point: adapt its density, order and proportions to the task.
Record consequential missing decisions; do not invent customers, results or services.
Use only the relevant craft guidance, starting with `craft("state-coverage")`.
Its `references/design-plan.md` provides the short plan and action/result checklist.

## Compose, do not clone
Masthead (home, an honest note that nothing is connected) → rooms as text tabs → devices as ruled rows (name in the slab serif, state in words, a switch that says On or Off, brightness when a light is on) beside heating (one dial: current reading, target and unit; a stepper that explains its limits) and scenes as radios with a short description, then one primary action. No tile grid and no card per device. Below 960px the climate column follows the devices.

The reference is a worked example, not a universal layout. Keep the thesis and derive content order from the user's task. Never copy the example identity (Elm Cottage and its rooms) into a deliverable. Two unrelated briefs must not become the same skeleton with different text.

## Tokens and typography
`tokens.css` is the executable source of truth. Bind --bg, --surface, --surface-2, --fg, --muted, --border, --border-strong, --accent, --accent-hover and --on-accent; use --success/--danger with a textual label. The accent is terracotta for on-states, the dial arc and the selected room; it lightens in dark so it remains readable as text. The dial arc is decorative and never carries text. Light and dark palettes are coordinated, not inverted. Measure the actual rendered foreground/background pairs in every offered theme; a token value or color notation does not prove contrast. Display: Rockwell, "Rockwell Nova", "Roboto Slab", Clarendon, Georgia, serif. Body and controls: system-ui, -apple-system, "Segoe UI", sans-serif. All stacks work offline; actual glyphs depend on installed fonts. Never claim a fallback is a supplied brand font. Explicit user typography wins.

## Signature components
`.rooms` text tabs, `.devices` of `.device` rows with `.device-state` and `.device-dim`, `.switch[role=switch]` with `.switch-track` and `.switch-text`, `.dial` (`--pct`, `.dial-now`, `.dial-target`, `.dial-label`) with `.stepper` and `.step[aria-disabled]`.

## States and honesty
Copy only the components the brief needs. The component view demonstrates primary/secondary/disabled buttons, labelled inputs, an inline error, empty/loading/success states, disclosure and a keyboard-dismissible dialog that returns focus. Keep :focus-visible, 44px targets where practical, reduced motion and reflow at 320px and 200% text. Never express state by color alone. Nothing is connected: every change says that no device was changed. Limits stay operable and explain themselves instead of silently disabling the focused control.

Prototype interactions must say they are local previews; wire real operations only when they are implemented. A successful animation is not proof that an action succeeded. Copy referenced CSS/JS into the generated project with relative links: an export must not depend on DStudio API URLs. Do not place text over gradients or background images.

## Avoid
A tile grid of devices, glowing icons, illustrated houses, gradients behind text, switches without a written state, unbounded steppers, more than one primary action per view.

## Behavior contract

Room switches preserve each room's device settings. Brightness and temperature stay within declared bounds; scenes update the intended rooms. Local switches cannot claim a physical-device acknowledgement.

Separate editable drafts from committed state. Define each action's input,
validation, owner, visible result and failure/cancellation behavior in the plan.
Derived views must share the committed data; never let a progress animation or
model self-review stand in for a saved result. Keep queues, retained input and
history bounded. In a preview, state belongs to this document and reload resets it;
production persistence and external effects require their own implemented contract.

## Acceptance
Render at 390, 768 and 1440px in both appearances; check 320px and 200% text for overflow and clipping. Operate every control with the keyboard; Escape closes dialogs and focus returns. Measure contrast on rendered pairs. Exercise loading/error/empty/success with real behavior or a clearly labelled demo state. Switch rooms; turn a light on and off and change its brightness; raise and lower the target past both limits (a message must explain the bound); choose a scene and check that every room follows. A passing preview is not a claim about generated model quality.

After checking the exported files, report what was exercised, what remains
unverified and the actual saved entry path. Recheck affected controls and layouts
after any HTML, CSS or JavaScript repair; do not infer a pass from unchanged markup.
