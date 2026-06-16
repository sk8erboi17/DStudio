---
name: enhance-prompt
description: |
  Improve prompts with design specs and UI/UX vocabulary. Useful for design-to-code workflows and clarifying requests for visual output.
triggers:
  - "enhance prompt"
  - "design prompt"
  - "ui prompt"
  - "design vocabulary"
od:
  mode: design-system
  category: design-systems
  upstream: "https://github.com/google-labs-code/skills"
ds4_category: general
ds4_local_mode: reference
ds4_output_kinds: html
ds4_upstream: open-design/enhance-prompt
ds4_modified_notice: Adapted for DStudio/DS4; added ds4_* metadata and local-first blueprint classification where needed.
ds4_source_repo: https://github.com/nexu-io/open-design
ds4_source_ref: main
ds4_source_commit: 2ff2d79bd54832696799984c05506fa4ed5dfcf3
---
# enhance-prompt

> Curated from Google Labs (Stitch).

## What it does

Improve prompts with design specs and UI/UX vocabulary. Useful for design-to-code workflows and clarifying requests for visual output.

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

Then ask the agent to invoke this skill by name (`enhance-prompt`) or with
one of the trigger phrases listed in this skill's frontmatter.
