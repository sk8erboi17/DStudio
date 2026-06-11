---
name: hand-drawn-diagrams
description: |
  Generate hand-drawn Excalidraw diagrams from a prompt — animated SVG, hosted edit link, and PNG export. Works with Claude Code, Codex, Gemini CLI, and any agent supporting standard skill paths.
triggers:
  - "excalidraw"
  - "hand drawn diagram"
  - "sketch diagram"
  - "whiteboard diagram"
od:
  mode: prototype
  category: diagrams
  upstream: "https://github.com/muthuishere/hand-drawn-diagrams"
ds4_category: general
ds4_local_mode: reference
ds4_output_kinds: html
ds4_upstream: open-design/hand-drawn-diagrams
ds4_modified_notice: Adapted for DStudio/DS4; added ds4_* metadata and local-first blueprint classification where needed.
---

# hand-drawn-diagrams

> Curated from @muthuishere.

## What it does

Generate hand-drawn Excalidraw diagrams from a prompt — animated SVG, hosted edit link, and PNG export. Works with Claude Code, Codex, Gemini CLI, and any agent supporting standard skill paths.

## Source

- Upstream: https://github.com/muthuishere/hand-drawn-diagrams
- Category: `diagrams`

## How to use

This catalogue entry advertises the skill in Open Design so the agent
discovers it during planning. To run the full upstream workflow with
its original assets, scripts, and references, install the upstream
bundle into your active agent's skills directory:

```bash
# Inspect the upstream README for exact paths
open https://github.com/muthuishere/hand-drawn-diagrams
```

Then ask the agent to invoke this skill by name (`hand-drawn-diagrams`) or with
one of the trigger phrases listed in this skill's frontmatter.
