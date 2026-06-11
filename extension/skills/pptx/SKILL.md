---
name: pptx
description: |
  Read, generate, and adjust PowerPoint slides, layouts, and templates. Useful for executive decks, training material, and product reviews.
triggers:
  - "pptx"
  - "powerpoint"
  - "slide deck"
  - "create slides"
  - "edit pptx"
od:
  mode: deck
  category: slides
  upstream: "https://github.com/anthropics/skills/tree/main/pptx"
ds4_category: deck-document
ds4_local_mode: native
ds4_output_kinds: deck
ds4_upstream: open-design/pptx
ds4_modified_notice: Adapted for DStudio/DS4; added ds4_* metadata and local-first blueprint classification where needed.
---

# pptx

> Curated from Anthropic's official skills repository.

## What it does

Read, generate, and adjust PowerPoint slides, layouts, and templates. Useful for executive decks, training material, and product reviews.

## Source

- Upstream: https://github.com/anthropics/skills/tree/main/pptx
- Category: `slides`

## How to use

This catalogue entry advertises the skill in Open Design so the agent
discovers it during planning. To run the full upstream workflow with
its original assets, scripts, and references, install the upstream
bundle into your active agent's skills directory:

```bash
# Inspect the upstream README for exact paths
open https://github.com/anthropics/skills/tree/main/pptx
```

Then ask the agent to invoke this skill by name (`pptx`) or with
one of the trigger phrases listed in this skill's frontmatter.
