---
name: Accessibility baseline
description: The floor every artifact must clear — WCAG 2.2 AA: real contrast, keyboard reach, focus, labels, alt, target size, reduced motion. Verify on the rendered result, not the source.
---

# CRAFT: accessibility baseline

Target **WCAG 2.2 AA** as the working ceiling — it clears the legal floor (EAA / ADA / EN
301 549). Below it is craft debt. These are the machine-checkable gates; clear them before
shipping, and verify against the **rendered** result, not the CSS source.

## Color contrast (the one most often missed)

- **Body / normal text ≥ 4.5:1**; large text (≥24px, or ≥18.66px bold) ≥ 3:1; UI components
  and graphical objects (icons, input borders, focus rings) ≥ 3:1.
- **Compute it on the actual rendered colors** — resolve `var()`, `color-mix()`, gradients,
  and any `rgba`/`opacity` over the parent. A "muted" text token (`oklch` lightness ~55–70%)
  on a light background is the classic failure: it reads ~3:1. Darken it (aim L ≤ 50% on
  light themes) rather than keeping the pretty-but-illegible gray.
- Don't rely on color alone to convey meaning (add text/icon/shape).

## Keyboard, focus, structure

- **Everything interactive is reachable and operable by keyboard**, in a logical order.
- **Visible focus**: a clear `:focus-visible` ring (≥3:1 against the background) on every
  link, button, input, and custom control. Never `outline: none` without a replacement.
- **One `<h1>`**, headings in order (no skipping levels) — they are the document outline.
- Use **semantic elements** (`<nav> <main> <button> <a> <ul><li> <table>`); a `<div>` with a
  click handler is not a button. Landmarks (`header/nav/main/footer`) for structure.

## Labels, names, media

- Every input has a real **`<label>`** (not placeholder-only). Icon-only buttons get an
  `aria-label`. Links have meaningful text (not "click here").
- Images have **`alt`** — descriptive for content, `alt=""` for decoration. Never an emoji or
  a filename as the accessible name.

## Touch & motion

- **Target size ≥ 24×24px** (AA), and ≥44×44px is the craft target for primary touch
  controls, with spacing so they aren't mis-tapped.
- **`@media (prefers-reduced-motion: reduce)`**: drop non-essential animation, parallax,
  auto-play, and bounce; keep simple fades. No content that flashes > 3×/sec.
- Body text is resizable/zoomable (use rem/em, no `user-scalable=no`).

## Self-check before artifact

- Contrast computed on the rendered colors, body ≥ 4.5:1 (esp. the muted/secondary text)?
- Keyboard: reach + visible focus on every control?
- One h1, ordered headings, semantic landmarks?
- Labels on inputs, alt on images, names on icon buttons?
- Targets ≥ 24px (44px for primary), reduced-motion honored?
