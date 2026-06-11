---
name: Layout & responsive integrity
description: When you change a size, aspect ratio or breakpoint, restructure the container — never leave an element floating with dead space. Layout edits are structural, not local.
---

# CRAFT: layout & responsive integrity

The most common layout bug in an edited design: changing **one** element's size or aspect
ratio without restructuring the container that depended on the old proportions. The element
shrinks or stretches into the wrong shape and leaves **dead space**. A resize is a
**structural** change, not a one-property tweak.

## The cardinal rule of resizing

When the user asks to change a size, aspect ratio, or orientation (e.g. "make it 9:16",
"taller", "two columns"), **re-flow the whole region**, not just the target element:

1. **Change the element's dimension AND its container's layout together.** Ask: "with the
   new shape, where does everything else go?" If the answer leaves whitespace, the layout is
   wrong.
2. **Match the layout to the new proportion:**
   - Wide media (16:9, 4:3) → media on **top**, content below (vertical card). `width: 100%`.
   - Tall/portrait media (9:16, 3:4) → media on the **left**, content to the **right**
     (horizontal card: `.card { display: flex }`, media `flex: 0 0 <fixed-width>`, content
     `flex: 1`). A full-width 9:16 in a wide card is ~2× taller than the card — almost never
     what's wanted.
3. **No dead space.** If an element doesn't fill its track, either it should (`width: 100%`)
   or the track should shrink to it — never a narrow box stranded in a wide cell.

## Aspect-ratio mechanics (the trap)

`aspect-ratio` + `max-height` (or `max-width`) **without an explicit `width`** makes the
browser derive the *other* dimension from the cap, so a block silently collapses to a small
box (e.g. `aspect-ratio: 9/16; max-height: 220px` → width ≈ 124px, stranded left). Fixes:

- Give the element a real width (`width: 100%`, or a fixed width in a flex track), then let
  `aspect-ratio` set the height. Use `object-fit: cover` for media so it fills without
  distortion.
- Use `aspect-ratio` to *shape* an element, `max-height`/`max-width` only as a guard — not
  as the thing that determines the size.

## General layout hygiene

- **Containers own their children's flow.** A grid/flex parent decides placement; children
  don't float arbitrarily. Center, stretch, or pin deliberately.
- **No `height: 100vh`** for full-height (mobile address bar) → `min-height: 100dvh`.
- **No fixed pixel heights on text containers** — content grows; use min-height + padding.
- **Breakpoints are real layouts** (390 / 768 / 1280), not a shrunk desktop. Reasses column
  counts, media placement, and nav at each — and re-check there's no dead space or overflow.
- **No horizontal scroll** at any width (unless a deliberate scroller). Test 390px.

## Self-check after any size/layout edit

- Did I restructure the **container**, or only the element? (If only the element → wrong.)
- Is there any **dead/empty space** next to the resized element? (If yes → re-flow.)
- Does the new proportion suit a vertical or horizontal arrangement — and did I pick it?
- Re-checked 390 / 768 / 1280: no overflow, no stranded boxes, media uses `object-fit`?
