---
name: canvas-design
description: |
  Create beautiful visual art in PNG and PDF documents using design philosophy and aesthetic principles for posters, illustrations, and static pieces.
triggers:
  - "canvas design"
  - "visual art"
  - "poster design"
  - "create poster"
  - "illustration"
  - "海报"
  - "插画"
od:
  mode: image
  category: image-generation
  upstream: "https://github.com/anthropics/skills/tree/main/canvas-design"
ds4_category: web-ui-prototype
ds4_local_mode: native
ds4_output_kinds: image-brief
ds4_upstream: open-design/canvas-design
ds4_modified_notice: Adapted for DStudio/DS4; added ds4_* metadata and local-first blueprint classification where needed.
ds4_source_repo: https://github.com/nexu-io/open-design
ds4_source_ref: main
ds4_source_commit: 2ff2d79bd54832696799984c05506fa4ed5dfcf3
---
# canvas-design

> Curated from Anthropic's official skills repository.

## What it does

Create beautiful visual art in PNG and PDF documents using design philosophy and aesthetic principles for posters, illustrations, and static pieces.

## Source

- Upstream: https://github.com/anthropics/skills/tree/main/skills/canvas-design
- Category: `image-generation`

## How to use

This catalogue entry advertises the skill in Open Design so the agent
discovers it during planning. To run the full upstream workflow with
its original assets, scripts, and references, install the upstream
bundle into your active agent's skills directory:

```bash
# Inspect the upstream README for exact paths
open https://github.com/anthropics/skills/tree/main/skills/canvas-design
```

Then ask the agent to invoke this skill by name (`canvas-design`) or with
one of the trigger phrases listed in this skill's frontmatter.
