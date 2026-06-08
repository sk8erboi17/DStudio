---
name: Anti-AI-slop
description: Kill the tells of machine-generated design — emoji icons, placeholder copy, fake logos, gratuitous gradients/shadows, repeated data, and the "default Tailwind" look. Be specific.
---

# CRAFT: anti-AI-slop

The default output of a model is generic. Slop is the set of tells that say "a machine made
this without taste." Your job is to remove every one and make it *specific*.

## Never ship these

- **Emoji as icons or content.** 🎨 🎙️ 💬 ⬇ 👁 as buttons, thumbnails, bullets, or section
  markers. Use **inline SVG** (a real icon) or text. Emoji as an accessible name is also an
  a11y failure.
- **Placeholder copy.** No `lorem ipsum`, `[REPLACE]`, "Feature One / Feature Two", "Your
  text here", "Item 1 / Item 2". Write real, specific copy with real numbers.
- **Fake logos / fake brands / clip-art.** No grey rectangles labelled "LOGO", no invented
  company marks in a "trusted by" row. If you'd be faking trust, omit the section.
- **Repeated / inconsistent data.** Don't reuse the same number for different things (e.g.
  "12.4k watching" and "12.4k downloads"). Don't pair an icon with the wrong meaning (an eye
  "views" icon next to a duration). Vary names, sizes, and values plausibly.

## Earn every effect

- **One accent, used sparingly** (5–10% of the surface). If everything is colored/bold,
  nothing stands out.
- **Effects must be earned:** aggressive gradients, drop shadows on every card,
  glassmorphism-by-default, and rainbow borders are tells. Default to flat + space + a single
  considered detail.
- **Real visuals, not symbol soup.** A "thumbnail" is a framed image area with `object-fit`,
  not a centered emoji on a gradient.

## Beat the "default template" look

- Vary layout: across a page use **≥4 distinct layout families** (full-bleed, split, grid,
  bento, centered prose) — not eight identical stacked cards.
- Specificity over decoration: name real things, use real proportions, write copy a human in
  that domain would write. A page that could belong to any product belongs to none.

## Self-check before artifact

- Zero emoji used as icons/content? Zero placeholders? Zero fake logos?
- No reused/contradictory data, no mismatched icon meanings?
- One accent, effects earned, real visuals (not emoji-on-gradient)?
- Would a designer with taste recognize this as deliberate, not generated?
