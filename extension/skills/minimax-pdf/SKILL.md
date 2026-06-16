---
name: minimax-pdf
description: |
  Generate, fill, and reformat PDFs with a token-based design system and 15 cover styles. Useful for branded PDFs, e-guides, and reports.
triggers:
  - "minimax pdf"
  - "branded pdf"
  - "cover style pdf"
  - "e-guide pdf"
  - "design system pdf"
od:
  mode: prototype
  category: documents
  upstream: "https://github.com/MiniMax-AI/skills"
ds4_category: provider-blueprint
ds4_local_mode: blueprint
ds4_output_kinds: pdf-brief
ds4_provider: minimax
ds4_upstream: open-design/minimax-pdf
ds4_modified_notice: Adapted for DStudio/DS4; added ds4_* metadata and local-first blueprint classification where needed.
ds4_source_repo: https://github.com/nexu-io/open-design
ds4_source_ref: main
ds4_source_commit: 2ff2d79bd54832696799984c05506fa4ed5dfcf3
---
# minimax-pdf

> Curated from the MiniMax AI team.

## What it does

Generate, fill, and reformat PDFs with a token-based design system and 15 cover styles. Useful for branded PDFs, e-guides, and reports.

## Source

- Upstream: https://github.com/MiniMax-AI/skills
- Category: `documents`

## How to use

This catalogue entry advertises the skill in Open Design so the agent
discovers it during planning. To run the full upstream workflow with
its original assets, scripts, and references, install the upstream
bundle into your active agent's skills directory:

```bash
# Inspect the upstream README for exact paths
open https://github.com/MiniMax-AI/skills
```

Then ask the agent to invoke this skill by name (`minimax-pdf`) or with
one of the trigger phrases listed in this skill's frontmatter.
