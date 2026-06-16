---
name: pptx-generator
description: |
  Create and edit PowerPoint presentations from scratch with PptxGenJS — MiniMax's production-tested deck pipeline.
triggers:
  - "pptx generator"
  - "minimax ppt"
  - "deck generator"
  - "auto pptx"
od:
  mode: deck
  category: slides
  upstream: "https://github.com/MiniMax-AI/skills"
ds4_category: deck-document
ds4_local_mode: native
ds4_output_kinds: deck
ds4_upstream: open-design/pptx-generator
ds4_modified_notice: Adapted for DStudio/DS4; added ds4_* metadata and local-first blueprint classification where needed.
ds4_source_repo: https://github.com/nexu-io/open-design
ds4_source_ref: main
ds4_source_commit: 2ff2d79bd54832696799984c05506fa4ed5dfcf3
---
# pptx-generator

> Curated from the MiniMax AI team.

## What it does

Create and edit PowerPoint presentations from scratch with PptxGenJS — MiniMax's production-tested deck pipeline.

## Source

- Upstream: https://github.com/MiniMax-AI/skills
- Category: `slides`

## How to use

This catalogue entry advertises the skill in Open Design so the agent
discovers it during planning. To run the full upstream workflow with
its original assets, scripts, and references, install the upstream
bundle into your active agent's skills directory:

```bash
# Inspect the upstream README for exact paths
open https://github.com/MiniMax-AI/skills
```

Then ask the agent to invoke this skill by name (`pptx-generator`) or with
one of the trigger phrases listed in this skill's frontmatter.
