---
name: email-html
description: A table-based HTML email that survives Gmail, Outlook and Apple Mail — inline styles, no flexbox/grid, bulletproof buttons.
modes: [design]
when_to_use: The user wants an HTML email, newsletter, campaign, or transactional message.
---

# SKILL: email-html

HTML email is 2003 web on purpose. Mail clients (especially Outlook/Word engine) strip
`<style>` blocks, ignore flex/grid, drop background images, and rewrite your CSS. Build
defensively or it breaks in the one client that matters.

## Hard rules (these are not stylistic — they are survival)

- **Layout with `<table>`**, not divs. Outer 100% wrapper table → inner fixed-width
  (`600px`) centered table → rows. No flexbox, no grid, no `position`.
- **Inline every style** on the element (`style="..."`). Keep a `<style>` head block only
  for progressive enhancement (media queries, dark mode) — assume it can be stripped.
- **Width 600px** for the content column; everything fluid below that for mobile.
- **Tables need** `role="presentation" cellpadding="0" cellspacing="0" border="0"`.
- **Images**: always `alt` text, explicit `width`/`height`, `display:block`. Assume images
  are blocked by default — the email must make sense as text-only. No background-image for
  anything load-bearing.
- **Fonts**: web-safe stacks only (Arial/Helvetica, Georgia). Web fonts won't load in most
  clients; provide a real fallback.
- **Spacing** via cell padding or empty spacer rows (`<tr><td height="24">`), not margin.

## Bulletproof button

A real `<a>` styled as a button inside a table cell with padding (so Outlook renders the
fill), not a CSS-padded inline link:

```
<table role="presentation" cellpadding="0" cellspacing="0">
  <tr><td bgcolor="#ACCENT" style="border-radius:8px;">
    <a href="#" style="display:inline-block;padding:14px 28px;color:#fff;
       font-family:Arial,sans-serif;font-size:16px;text-decoration:none;">Call to action</a>
  </td></tr>
</table>
```

## Structure

Masthead (logo/brand, text-based) → hero (headline + one line + button) → body (1–3
blocks, each a row) → secondary CTA → footer (address, unsubscribe, preferences). One
primary action; the rest are quiet links.

## Enhancement (optional, must degrade)

- `@media (max-width:600px)` to stack columns and grow tap targets — but the email must
  already work without it.
- `@media (prefers-color-scheme: dark)` + `meta name="color-scheme"` for dark mode;
  never rely on it for legibility.

## Self-check before artifact (fix anything < 3/5)

- **Survival**: tables + inline styles, zero flex/grid/position?
- **Images-off**: does it read and is the CTA clickable with images blocked?
- **One action**: a single bulletproof primary button?
- **Mobile**: ≥44px tap targets, single column at 600px, ≥16px body?
- **Footer**: unsubscribe + physical address present (compliance)?

Gate: 600px column, inline styles, alt text on every image, contrast ≥4.5:1, no external
CSS dependency for legibility.
