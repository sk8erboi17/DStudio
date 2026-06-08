---
name: landing-page
description: A marketing / product landing page — hero that fits the first viewport, then sections that build the argument, ending on one CTA.
modes: [design]
when_to_use: The user wants a landing page, marketing page, product page, or "homepage" to sell or explain one thing.
---

# SKILL: landing-page

You are building a single-purpose page whose job is to make **one** promise and drive
**one** action. Everything serves that. A landing page that explains five things sells
nothing.

> **A landing page is words + layout + findability, not just visuals.** Before/while you
> build, pull the marketing skills so it converts and ranks, not just looks good:
> `skill(product-marketing)` first (the positioning/audience/voice brief everything reads),
> then `skill(copywriting)` for the headline/value-prop/CTAs, `skill(cro)` for the
> conversion structure, `skill(seo-audit)` + `skill(schema)` for rankability. Don't ship
> placeholder marketing copy — write real, specific, on-message copy.

## Shape

A landing page is a vertical argument. Default section order (drop any that don't earn
their place — 5 strong sections beat 9 filler ones):

1. **Hero** — fits the first viewport. ≤2-line headline (the promise, not the feature),
   ≤20-word subtext, one primary CTA, one supporting visual or proof. Nothing below the
   fold is needed to understand the offer.
2. **Proof / logos** — why believe you (numbers, names, a quote). Skip if you'd be faking
   it — an empty trust row is worse than none.
3. **How it works / value** — 3 steps or 3 benefits, each concrete. Not "Powerful",
   "Flexible", "Secure" — say what it does.
4. **Feature deep-dive** — 1–3 features shown, not listed. Each gets a real visual.
5. **Objection handling** — pricing, FAQ, or comparison. Remove the last reason to leave.
6. **Final CTA** — restate the promise, repeat the action. The page ends on the button.

## Layout library

- Use **≥4 distinct layout families** across the page (full-bleed hero, split 2-col,
  3-col cards, centered prose, bento grid). Eight identical stacked cards = AI slop.
- Hero options: centered (bold claim), split (claim left / visual right), or full-bleed
  background with overlaid copy. Pick by tone.
- Section rhythm: vary background (bg ↔ surface), alternate text/visual sides, change
  column counts. Whitespace between sections ≥ the height of a heading block.
- CTA appears at least twice (hero + footer), styled identically, never more than one
  primary per viewport.

## Type & color

- Headline weight 590–600, body 400, labels 510–550. Type scale ×1.2–1.25, ≤6 sizes.
- One accent for CTAs and key links (5–10% of the page). Neutrals do the rest.
- Fluid type with `clamp()`; `min-height: 100dvh` for the hero (never `100vh`).

## Self-check before artifact (fix anything < 3/5)

- **Promise**: can a stranger state what this offers and why, from the hero alone?
- **Focus**: exactly one primary action, repeated — not three competing CTAs?
- **Specificity**: real copy, real numbers, real feature names — zero placeholders?
- **Hierarchy**: one obvious first-glance landing point per viewport?
- **Restraint**: one accent, effects earned, ≤3 weights?
- **States**: hover/focus on every interactive element; mobile (390) is a real layout.

Gate: body ≥16px, contrast ≥4.5:1, tap ≥44px, no horizontal scroll, no lorem.
