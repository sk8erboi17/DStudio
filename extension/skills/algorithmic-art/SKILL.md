---
name: algorithmic-art
description: |
  Create generative art using p5.js with seeded randomness so every render is reproducible. Useful for procedural posters, motion-style stills, and artistic frame studies.
triggers:
  - "algorithmic art"
  - "generative art"
  - "p5js"
  - "procedural art"
  - "seeded randomness"
  - "生成艺术"
od:
  mode: image
  category: image-generation
  upstream: "https://github.com/anthropics/skills/tree/main/algorithmic-art"
ds4_category: general
ds4_local_mode: reference
ds4_output_kinds: image-brief
ds4_upstream: open-design/algorithmic-art
ds4_modified_notice: Adapted for DStudio/DS4; added ds4_* metadata and local-first blueprint classification where needed.
ds4_source_repo: https://github.com/nexu-io/open-design
ds4_source_ref: main
ds4_source_commit: 2ff2d79bd54832696799984c05506fa4ed5dfcf3
---
# algorithmic-art

> Curated from Anthropic's official skills repository.

## What it does

Create generative art using p5.js with seeded randomness so every render is reproducible. Useful for procedural posters, motion-style stills, and artistic frame studies.

## Source

- Upstream: https://github.com/anthropics/skills/tree/main/skills/algorithmic-art
- Category: `image-generation`

## How to use

This catalogue entry advertises the skill in Open Design so the agent
discovers it during planning. To run the full upstream workflow with
its original assets, scripts, and references, install the upstream
bundle into your active agent's skills directory:

```bash
# Inspect the upstream README for exact paths
open https://github.com/anthropics/skills/tree/main/skills/algorithmic-art
```

Then ask the agent to invoke this skill by name (`algorithmic-art`) or with
one of the trigger phrases listed in this skill's frontmatter.
