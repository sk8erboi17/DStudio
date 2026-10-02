---
name: Tempo
description: A hi-fi for a library: aluminium and black, one LED green, tight grotesk type, a speaker-grille sleeve, precise transport keys and an honest silent preview.
modes: [design]
ds4_category: media
ds4_local_mode: native
ds4_output_kinds: html
ds4_upstream: dstudio-original/tempo
---
# Tempo — original DStudio system, version 1

## Visual thesis
Controls with the precision of good equipment. A grille-textured sleeve and a deck of keys sit beside a large album title and a numbered tracklist; one LED green marks what is playing and nothing else. Dark is the default appearance; light is fully supported.

Best fit: Music and podcast players, media libraries, audio tools, radio and playback-centred products.

## Load before building
Read `tokens.css`, `components.html`, `assets/preview.js` and `references/recipes.md` using `pack_file(type="design_system", name="tempo", path="…")`. These are local authored assets, not an external template or framework. The preview uses example content, not real customers, metrics, transactions or availability.

## Fit the brief

Identify the audience, the primary action and the source of each factual claim.
Preserve explicit user copy, colors, fonts and supplied assets. The composition
below is a starting point: adapt its density, order and proportions to the task.
Record consequential missing decisions; do not invent customers, results or services.
Use only the relevant craft guidance, starting with `craft("state-coverage")`.
Its `references/design-plan.md` provides the short plan and action/result checklist.

## Compose, do not clone
Top bar (product, library sections, a note that the preview is silent) → sleeve and deck (now playing, position with elapsed and remaining time, three transport keys, shuffle and repeat toggles, volume) beside the album: eyebrow, a large title, artist, facts and a numbered tracklist whose titles are the play controls. The LED marks the current track and on-states only. Below 900px the columns stack.

The reference is a worked example, not a universal layout. Keep the thesis and derive content order from the user's task. Never copy the example identity (Night Rooms, The Low Hours and the example tracks) into a deliverable. Two unrelated briefs must not become the same skeleton with different text.

## Tokens and typography
`tokens.css` is the executable source of truth. Bind --bg, --surface, --surface-2, --fg, --muted, --border, --border-strong, --accent, --accent-hover and --on-accent; use --success/--danger with a textual label. `--led` is the indicator fill; `--grille` and `--grille-dot` draw the decorative sleeve and never sit behind text. The accent is a deep green in light and LED green in dark. Light and dark palettes are coordinated, not inverted. Measure the actual rendered foreground/background pairs in every offered theme; a token value or color notation does not prove contrast. Everything: "Helvetica Neue", Helvetica, "Nimbus Sans", Arial, sans-serif, bold and tightly tracked for titles. Times: "SF Mono", ui-monospace, Menlo, Consolas, with tabular figures. All stacks work offline; actual glyphs depend on installed fonts. Never claim a fallback is a supplied brand font. Explicit user typography wins.

## Signature components
`.grille`, `.deck`, `.keys` with `.key` and `.key--play`, `.ico` (`play`, `pause`, `prev`, `next`), `.toggle[aria-pressed]`, `.tracks` of `.track` rows (`.track-no`, `.track-play`, `.track-len`, `.led[data-on]`) and `.seek-times`.

## States and honesty
Copy only the components the brief needs. The component view demonstrates primary/secondary/disabled buttons, labelled inputs, an inline error, empty/loading/success states, disclosure and a keyboard-dismissible dialog that returns focus. Keep :focus-visible, 44px targets where practical, reduced motion and reflow at 320px and 200% text. Never express state by color alone. The preview plays no audio and time does not advance; say so wherever playback is controlled. Never animate a progress bar or a waveform to imply playback.

Prototype interactions must say they are local previews; wire real operations only when they are implemented. A successful animation is not proof that an action succeeded. Copy referenced CSS/JS into the generated project with relative links: an export must not depend on DStudio API URLs. Do not place text over gradients or background images.

## Avoid
Blurred album-art backgrounds, gradients behind text, neon glow, waveform decoration without data, unnamed icon-only controls, a second accent color.

## Behavior contract

Track, duration, seek position and transport labels agree. Bound seek and volume; next/previous, repeat and shuffle have explicit end behavior. A silent demo must not claim audible playback.

Separate editable drafts from committed state. Define each action's input,
validation, owner, visible result and failure/cancellation behavior in the plan.
Derived views must share the committed data; never let a progress animation or
model self-review stand in for a saved result. Keep queues, retained input and
history bounded. In a preview, state belongs to this document and reload resets it;
production persistence and external effects require their own implemented contract.

## Acceptance
Render at 390, 768 and 1440px in both appearances; check 320px and 200% text for overflow and clipping. Operate every control with the keyboard; Escape closes dialogs and focus returns. Measure contrast on rendered pairs. Exercise loading/error/empty/success with real behavior or a clearly labelled demo state. Play and pause, step to the next and previous track, choose a track from the list and move the position slider; labels, times and the status line must follow. Turn shuffle and repeat on and off. A passing preview is not a claim about generated model quality.

After checking the exported files, report what was exercised, what remains
unverified and the actual saved entry path. Recheck affected controls and layouts
after any HTML, CSS or JavaScript repair; do not infer a pass from unchanged markup.
