---
name: slide-deck
description: A presentation — fixed 1920×1080 slides with arrow-key navigation, one idea per slide, print-to-PDF friendly.
modes: [design]
when_to_use: The user wants a deck, presentation, pitch, keynote, or slides.
ds4_category: deck-document
ds4_local_mode: native
ds4_output_kinds: deck
ds4_upstream: dstudio/slide-deck
---

# SKILL: slide-deck

You are building a deck that reads from the back of the room and exports cleanly to PDF.
One idea per slide. If a slide needs two ideas, it is two slides.

## Frame & navigation

- Slides are **fixed 1920×1080** stages (16:9), centered and letterboxed in the viewport,
  scaled to fit (`transform: scale()` on a fixed-size stage). Never reflow text to fit.
- **One slide visible at a time.** Arrow keys (←/→) and Space advance; a visible slide
  counter (`03 / 12`) sits in a corner. Optional dot/progress rail.
- A **print stylesheet** that lays one slide per page (`@media print { each slide:
  page-break-after: always; show all }`) so ⌘P → "Save as PDF" produces the deck.

## Typography for the room

- Headlines ≥ 64px, body ≥ 28px, captions ≥ 22px. If you're tempted below these, cut
  words instead of shrinking type.
- ≤ 20 words of body per slide. A slide is a billboard, not a document. Speaker detail
  lives in notes, not on the slide.
- 2 weights, a strong type pairing (display for headers, clean sans for body).

## Slide types (vary them — a deck of identical title+bullets is slop)

- **Title / section divider** — big statement, lots of space.
- **Statement** — one sentence, centered, nothing else.
- **Big number** — a single metric at 200px+ with a one-line caption.
- **Two-up** — claim left, visual/proof right.
- **List** — ≤5 items, each a short phrase, not a paragraph. Reveal-on-advance optional.
- **Quote** — attributed, set large.
- **Diagram / flow** — boxes + arrows in inline SVG.
- **Closing / CTA** — the ask, contact, one line.

Use ≥4 different slide types across the deck; never more than ~6 list slides in a row.

## Build notes

- Self-contained: one HTML file, system fonts, inline SVG, CSS gradients. No external
  fetch (it must present offline).
- A consistent grid/margin across slides (e.g. 120px safe margin) so things don't jump.
- Subtle entrance per slide (fade/slide ≤300ms); never animate the body text in word by
  word. Respect `prefers-reduced-motion`.
- Optional theme accent used on dividers and the counter only.

## Self-check before artifact (fix anything < 3/5)

- **One idea/slide**: would any slide be clearer split in two?
- **Readability**: legible from across a room (sizes above)?
- **Variety**: ≥4 slide types, no long run of identical layouts?
- **Navigation**: arrows + counter work; first/last slides clamp?
- **Export**: ⌘P renders one clean slide per page?

Gate: nav keyboard-reachable, counter visible, contrast ≥4.5:1, no text clipped at
1920×1080, print path produces the full deck.
