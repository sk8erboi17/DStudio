---
name: design-md
description: |
  Create and manage DESIGN.md files. Useful for capturing design direction, tokens, and visual rules in a single source of truth.
triggers:
  - "design.md"
  - "design doc"
  - "design tokens doc"
  - "visual rules doc"
od:
  mode: design-system
  category: design-systems
  upstream: "https://github.com/google-labs-code/skills"
ds4_category: general
ds4_local_mode: reference
ds4_output_kinds: html
ds4_upstream: open-design/design-md
ds4_modified_notice: Adapted for DStudio/DS4; added ds4_* metadata and local-first blueprint classification where needed.
ds4_source_repo: https://github.com/nexu-io/open-design
ds4_source_ref: main
ds4_source_commit: 2ff2d79bd54832696799984c05506fa4ed5dfcf3
---
# design-md

> Curated from Google Labs (Stitch).

## What it does

Create and manage DESIGN.md files. Useful for capturing design direction, tokens, and visual rules in a single source of truth.

## Source

- Upstream: https://github.com/google-labs-code/skills
- Category: `design-systems`

## How to use

This catalogue entry advertises the skill in Open Design so the agent
discovers it during planning. To run the full upstream workflow with
its original assets, scripts, and references, install the upstream
bundle into your active agent's skills directory:

```bash
# Inspect the upstream README for exact paths
open https://github.com/google-labs-code/skills
```

Then ask the agent to invoke this skill by name (`design-md`) or with
one of the trigger phrases listed in this skill's frontmatter.
