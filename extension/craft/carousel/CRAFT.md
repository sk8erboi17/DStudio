---
name: Carousel / horizontal scroller
description: How to build a carousel that doesn't suck — scroll-snap, fixed-width cards with capped media height, real prev/next + keyboard, no overlapping elements, no dead space.
---

# CRAFT: carousel / horizontal scroller

A carousel is a horizontal, scroll-snapping row of fixed-width cards — not a row of
full-width media stretched to whatever height the aspect ratio demands. The common failures
(seen in the wild): cards so tall they fill the screen, the play icon sitting on top of the
label, and scroll that only works with a mouse. Build it with structure.

## Structure (the correct recipe)

```css
.carousel {
  display: flex;
  gap: 16px;
  overflow-x: auto;
  scroll-snap-type: x mandatory;     /* snaps each card into place */
  scroll-padding: 0 24px;
  -webkit-overflow-scrolling: touch;
  padding-bottom: 8px;               /* room for the scrollbar */
}
.carousel-card {
  flex: 0 0 clamp(220px, 72vw, 300px);  /* FIXED width — never stretch to fill */
  scroll-snap-align: start;
  /* the card is a normal vertical card: media on top, content below */
}
.carousel-card .thumb {
  width: 100%;
  aspect-ratio: 16 / 9;              /* pick a sane ratio for the carousel */
  max-height: 200px;                 /* CAP it — a 9:16 thumb at 280px wide is ~500px tall */
  object-fit: cover;                 /* media fills without distortion */
}
```

- **Cards have a FIXED width** (`flex: 0 0 …`), so they don't stretch and the row scrolls.
  Use `clamp()` so they shrink gracefully on mobile but never go full-width.
- **Cap the media height.** This is the #1 carousel bug: a portrait (9:16) thumbnail at full
  card width becomes ~2× taller than it should. Either use a landscape ratio (16:9 / 4:3) for
  the carousel, or keep portrait but `max-height` it so the card stays a comfortable height.
  See `craft(layout-responsive)`.
- **`scroll-snap`** makes it feel like a carousel, not a janky free-scroll.

## Don't overlap centered elements

If a card has BOTH a centered play button and a centered label, they collide ("A▶T",
"TA▶K"). Give them **different anchors**: label top-left (or as a small chip), play button
centered, duration bottom-right, LIVE badge top-left. One thing per corner; the play button
is the only centered element. Use `position: absolute` with distinct `top/left/right/bottom`,
not three things all at `top:50%; left:50%`.

## Controls & accessibility (not optional)

- **Visible prev / next buttons** that scroll by ~one card width (`scrollBy({left: cardW,
  behavior: 'smooth'})`) — a scrollbar alone isn't a control, and touch-drag isn't reachable.
  Disable the buttons at the ends.
- **Keyboard**: the scroller (or its cards/buttons) must be focusable and operable with the
  arrow keys; don't trap focus. Cards that are links are real `<a>`s.
- **Semantics**: `role="region"` (or `aria-roledescription="carousel"`) + an `aria-label`
  ("Top clips"). If you build slides/dots, announce position ("3 of 8").
- **Optional dots/progress** reflect and control position; keep the scrollbar usable or hide
  it cleanly (`scrollbar-width: thin`) — never remove the only way to scroll.
- **Reduced motion**: no auto-advance by default; if you add it, pause on hover/focus and
  disable under `prefers-reduced-motion`.

## Content & polish

- Show a **peek** of the next card (so it's obviously scrollable) — the last visible card is
  partly cut, or add an edge fade.
- Real varied data, real `object-fit` media (not an emoji on a gradient — see
  `craft(anti-slop)`). Muted meta text still ≥4.5:1 (`craft(accessibility)`).

## Self-check before artifact

- Cards **fixed-width** (scroll), media height **capped** (no screen-tall cards)?
- Nothing overlapping — label, play, duration on **different** anchors?
- **Prev/next buttons** + keyboard, not mouse/scrollbar only? `aria-label` on the region?
- Snap works, a peek of the next card shows it scrolls, no dead space?
- Reduced-motion: no forced auto-advance?
