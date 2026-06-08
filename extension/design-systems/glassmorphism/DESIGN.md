---
name: Glassmorphism
description: Frosted glass on vibrant aurora gradients — translucent blurred panels, soft light borders, luminous depth. Modern, atmospheric, premium-playful.
---

# DESIGN SYSTEM: Glassmorphism

Layers of frosted glass floating over a vivid, blurred background. Depth through blur and
translucency, not flat surfaces. Atmospheric and modern — used with restraint so it stays
legible, not a soup.

## Color (dark canonical; light works with a bright wash)

- Background = an **aurora gradient mesh**: 2-3 vivid blobs (e.g. violet `oklch(0.6 0.2 290)`,
  cyan `oklch(0.75 0.15 220)`, magenta `oklch(0.65 0.22 350)`) blurred heavily on a deep base
  `oklch(0.18 0.03 280)`.
- `--glass: color-mix(in oklch, white 8%, transparent)`   /* panel fill */
- `--glass-strong: color-mix(in oklch, white 14%, transparent)`
- `--border: color-mix(in oklch, white 20%, transparent)` /* light hairline edge */
- `--fg: oklch(0.97 0.01 280)`        /* near-white text */
- `--muted: oklch(0.80 0.02 280)`
- `--accent: oklch(0.80 0.16 290)`    /* luminous violet/cyan */

## Typography

- Stack: `-apple-system, "Inter", system-ui, sans-serif`. Clean, slightly light weights read
  well on glass. Body 16px, 400; headings 600 with a subtle text glow optional.
- Keep contrast high: white text on glass needs a dark/blurred backdrop behind the panel.

## Spacing & layout

- Radius: large and soft — 16-24px on glass cards. Generous padding.
- **The glass recipe**: `background: var(--glass); backdrop-filter: blur(16-24px) saturate(1.4);
  border: 1px solid var(--border); box-shadow: 0 8px 32px rgba(0,0,0,.25), inset 0 1px 0
  rgba(255,255,255,.15)`. The inset top highlight sells the glass.
- Layer panels at different blur/opacity for depth. Float them over the aurora with space.
- Don't stack glass on glass on glass — 1-2 layers, or it turns to mud.

## Components

- Cards/nav/modals = glass panels. Buttons: glass or a soft luminous gradient fill; hover
  brightens + lifts. Inputs: translucent fill, light border, glowing focus ring.
- Pills, toggles, and badges all share the frosted treatment + light edge.

## Motion

- Smooth, floaty: 250-400ms ease; gentle parallax of the aurora, soft hover lifts, blur/opacity
  transitions. Premium, unhurried. `prefers-reduced-motion` stops the aurora drift.

## Voice

Modern, light, a little aspirational. Sentence case. Calm confidence.

## Anti-patterns (never)

Glass with no dark/vivid backdrop (illegible), too many stacked panels, hard opaque cards,
sharp corners, heavy borders, low-contrast gray-on-gray text, neon overload.
