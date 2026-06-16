---
name: emilkowalski-motion
description: |
  Motion-design follow-up skill inspired by Emil Kowalski's animation guidance. Use after an interface exists to add tasteful micro-interactions, state transitions, and page motion with product-grade restraint.
ds4_category: general
ds4_local_mode: reference
ds4_output_kinds: html
ds4_upstream: open-design/emilkowalski-motion
ds4_modified_notice: Adapted for DStudio/DS4; added ds4_* metadata and local-first blueprint classification where needed.
ds4_source_repo: https://github.com/nexu-io/open-design
ds4_source_ref: main
ds4_source_commit: 2ff2d79bd54832696799984c05506fa4ed5dfcf3
---
# Emil Kowalski Motion Follow-Up

Use this skill after a design artifact already exists. The goal is to make the interface feel alive without turning it into a motion demo.

## Workflow

1. Inspect the current HTML, component, or selected page element before adding animation.
2. Pick the smallest set of motion moments that clarify state or hierarchy:
   - entry reveal for the primary content
   - hover / active feedback for important controls
   - transition between UI states
   - scroll reveal only when it helps the story
3. Prefer `transform` and `opacity`. Avoid animating layout properties such as `top`, `left`, `width`, or `height`.
4. Use one motion language across the artifact. Do not mix unrelated easings, durations, or physics.
5. Add `prefers-reduced-motion` fallbacks for any automatic or scroll-linked motion.
6. Keep copy, data, and layout intent intact unless the user explicitly asks for a redesign.

## Motion Rules

- Default UI transitions should feel quick and useful: 140-220ms for most controls.
- Larger page reveals can be slower, but must not block reading.
- Avoid endless decorative loops unless they communicate status or progress.
- Do not add custom cursors, noisy particle effects, or motion that competes with content.
- Stagger only small groups. Long staggered lists make interfaces feel slow.

## Implementation Notes

- For plain HTML, CSS keyframes and small JavaScript observers are enough.
- For React or framework code, use the local stack already present in the repo.
- If GSAP is available and the motion needs sequencing, pair this with `gsap-core`, `gsap-timeline`, or `gsap-scrolltrigger`.
- Always clean up observers, timers, and animation instances.

