---
name: Playful
description: Friendly and gamified — rounded everything, bright saturated colors, chunky shadows, bouncy motion, big mascot energy. Encouraging, fun, approachable (Duolingo-ish).
---

# DESIGN SYSTEM: Playful

Joyful, encouraging, a little gamey. Big rounded shapes, candy-bright color, chunky 3D-ish
buttons, springy motion, friendly copy. The opposite of corporate — but still legible and
purposeful. Delight that rewards, never noise that annoys.

## Color (light canonical, bright)

- `--bg: oklch(0.99 0.005 250)`        /* clean white / very light */
- `--surface: oklch(1 0 0)`
- `--surface-2: oklch(0.96 0.02 250)`
- `--border: oklch(0.88 0.02 250)`
- `--fg: oklch(0.28 0.03 270)`         /* soft dark, not pure black */
- `--muted: oklch(0.55 0.03 270)`
- `--accent: oklch(0.72 0.19 145)`     /* bright friendly green (or swap) */
- a **multi-color palette** is on-brand: green/blue/purple/orange/pink, each saturated and
  used for categories, streaks, rewards. semantic green=correct, red=oops (gentle), gold=reward.

## Typography

- Stack: a rounded sans — `"Nunito", "Baloo 2", "Quicksand", system-ui, sans-serif` (fallback
  to system rounded). Friendly, generous.
- Big, bold headings (700-800), comfy body 16-18px, weights 400/600/700. Roomy line-height.
- Numbers and rewards can be oversized and bouncy.

## Spacing & layout

- 8px grid, generous padding, lots of breathing room. Cards are big and inviting.
- Radius: **large and round** — 16-24px cards, fully rounded buttons/pills/avatars.
- **Chunky depth**: solid offset shadows or thick bottom borders on buttons
  (`box-shadow: 0 4px 0 <darker-accent>`) that "press down" on click. Tactile, toy-like.
- Mascot / illustration / emoji as identity and reward moments (used with intent).

## Components

- Buttons: big, rounded, saturated fill, a darker bottom edge/shadow; press = translate down
  (the shadow shrinks). Satisfying.
- Inputs: rounded, friendly, clear focus in the accent; playful but legible labels.
- Progress: chunky rounded bars, streak counters, badges, confetti on success.
- Cards/tiles for lessons/items; hover = lift + slight tilt.

## Motion

- **Bouncy and rewarding**: spring/overshoot easing, 250-450ms; pop-in, wiggle on success,
  confetti, button press-down. Motion = feedback and reward. Respect `prefers-reduced-motion`
  (drop bounces/confetti, keep simple fades).

## Voice

Warm, encouraging, second person, a little cheeky. "Nice! Keep your streak going 🔥".
Celebrate effort. Gentle, kind error copy ("Oops, try again!").

## Anti-patterns (never)

Muted corporate grays, sharp corners, flat lifeless buttons, tiny cramped type, sarcasm,
overusing confetti/emoji to the point of noise, illegible low-contrast brights.
