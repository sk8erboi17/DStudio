---
name: impeccable-design-polish
description: |
  Follow-up design polish skill inspired by Impeccable. Use after a web or HTML artifact exists to audit, critique, polish, animate, harden, and prepare the page for a live/share pass.
ds4_category: general
ds4_local_mode: reference
ds4_output_kinds: html
ds4_upstream: open-design/impeccable-design-polish
ds4_modified_notice: Adapted for DStudio/DS4; added ds4_* metadata and local-first blueprint classification where needed.
ds4_source_repo: https://github.com/nexu-io/open-design
ds4_source_ref: main
ds4_source_commit: 2ff2d79bd54832696799984c05506fa4ed5dfcf3
---
# Impeccable Design Polish

Use this skill as the post-generation pass for an existing design. It should not restart the project from scratch; it should make the current artifact sharper, more usable, and closer to something a designer would ship.

## Follow-Up Modes

- **Audit**: identify the highest-impact issues in hierarchy, spacing, color, type, interaction states, responsiveness, and accessibility.
- **Critique**: explain what feels generic, overdesigned, underdesigned, or inconsistent.
- **Polish**: directly edit the artifact to improve the top issues while preserving the user's intent.
- **Animate**: add restrained, useful motion only where it improves feedback or storytelling.
- **Harden**: repair mobile overflow, text clipping, contrast problems, missing states, broken links, and fragile layout assumptions.
- **Live**: prepare the artifact for presentation or sharing, including final visual QA and clear next actions.

## Operating Rules

1. Inspect the current HTML/page before editing. Do not guess from the prompt alone.
2. Keep the existing content, brand, and scenario unless the user explicitly asks to change them.
3. Prefer a few decisive fixes over broad cosmetic churn.
4. Remove common AI tells:
   - purple-blue glow gradients with no product reason
   - generic 3-card feature rows
   - oversized rounded cards everywhere
   - empty marketing adjectives
   - inconsistent spacing and type scale
   - decorative effects that do not support comprehension
5. Preserve accessibility: focus states, contrast, semantic controls, readable text, and reduced-motion fallbacks.
6. Finish with the artifact in a better runnable state, not just a critique list.

## Best Pairings

- Pair with `design-taste-frontend` or `gpt-taste` for stronger anti-slop redesign work.
- Pair with `emilkowalski-motion` or GSAP skills for motion-specific polish.
- Pair with image/video skills when the artifact needs real visual assets rather than CSS-only decoration.

