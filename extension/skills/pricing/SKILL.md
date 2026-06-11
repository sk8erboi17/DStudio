---
name: pricing
description: A pricing page — 2-4 plan tiers compared at a glance, one recommended, with a value-framed feature matrix and FAQ that removes the last objection.
modes: [design]
when_to_use: The user wants a pricing page, plans/tiers comparison, or "how much does it cost" screen.
ds4_category: general
ds4_local_mode: reference
ds4_output_kinds: html
ds4_upstream: dstudio/pricing
---

# SKILL: pricing

The job: make the choice obvious and remove fear. A pricing page that lists features
without guiding the eye makes people leave. Anchor, recommend, reassure.

> Pricing is conversion copy as much as layout. Pull `skill(product-marketing)` for the
> audience/positioning, `skill(copywriting)` for plan names/value framing/CTAs, and
> `skill(cro)` for the conversion structure (anchoring, the recommended tier, objection-
> killing FAQ). Real plans, real limits — no placeholders.

## Shape

1. **Header** — one line on what they're paying for + a billing toggle (Monthly / Annual,
   annual shows the saving, e.g. "2 months free"). The toggle actually changes the prices.
2. **Plan cards** — 2-4 tiers side by side. Each: name, one-line who-it's-for, big price
   (with /mo and the billing note), a primary CTA, then the key features as a short list.
   **Mark ONE plan recommended** ("Most popular") — lift it (border accent + subtle
   elevation + a badge), it anchors the decision.
3. **Feature matrix** (optional but strong) — a comparison table: rows = capabilities,
   columns = plans, cells = ✓ / value / —. Group rows by category. Sticky plan header.
4. **FAQ** — 4-6 questions that kill objections (cancel anytime, refunds, switching plans,
   taxes, what counts as a seat/usage).
5. **Final reassurance** — money-back / no card required / contact sales for enterprise.

## Craft

- **Anchor pricing**: order low→high or high→low deliberately; the recommended tier sits
  where the eye lands. A higher "anchor" tier makes the recommended one feel reasonable.
- **Frame value, not features**: "Up to 10,000 contacts", not "Contacts: yes". Numbers and
  limits, concretely.
- **One primary CTA style**; the recommended plan's CTA is the loudest, others are quieter
  (outline). Never 4 identical loud buttons.
- **Enterprise tier** = "Talk to us" with a contact CTA, not a price.
- **Honesty**: real plan names, real-feeling limits, no "$0 forever*" with hidden asterisks
  that contradict the rest.

## States

Billing toggle (monthly/annual recompute), hover on cards/CTAs, a "current plan" state if
it's an in-app upgrade screen, and the matrix degrading to stacked cards on mobile.

## Self-check before artifact (fix anything < 3/5)

- **Obvious choice**: is the recommended plan unmistakable in <1s?
- **Value clarity**: can a stranger tell what each tier gets them, concretely?
- **Toggle works**: does annual actually change prices + show the saving?
- **Objections**: does the FAQ remove the real reasons to hesitate?
- **Restraint**: one loud CTA, one accent, anchored hierarchy — not 4 shouting cards?

Gate: contrast ≥4.5:1, tap ≥44px, body ≥16px, matrix → cards at 390, no lorem, prices and
limits are concrete (no placeholders).
