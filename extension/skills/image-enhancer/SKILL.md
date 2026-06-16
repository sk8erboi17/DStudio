---
name: image-enhancer
description: |
  Improve image and screenshot quality by enhancing resolution, sharpness, and clarity for professional presentations and documentation.
triggers:
  - "enhance image"
  - "upscale image"
  - "image quality"
  - "sharpen"
  - "denoise"
od:
  mode: image
  category: image-generation
  upstream: "https://github.com/ComposioHQ/awesome-claude-skills/tree/master/image-enhancer"
ds4_category: media-blueprint
ds4_local_mode: reference
ds4_output_kinds: image-brief
ds4_upstream: open-design/image-enhancer
ds4_modified_notice: Adapted for DStudio/DS4; added ds4_* metadata and local-first blueprint classification where needed.
ds4_source_repo: https://github.com/nexu-io/open-design
ds4_source_ref: main
ds4_source_commit: 2ff2d79bd54832696799984c05506fa4ed5dfcf3
---
# image-enhancer

> Curated from ComposioHQ awesome-claude-skills.

## What it does

Improve image and screenshot quality by enhancing resolution, sharpness, and clarity for professional presentations and documentation.

## Source

- Upstream: https://github.com/ComposioHQ/awesome-claude-skills/tree/master/image-enhancer
- Category: `image-generation`

## How to use

This catalogue entry advertises the skill in Open Design so the agent
discovers it during planning. To run the full upstream workflow with
its original assets, scripts, and references, install the upstream
bundle into your active agent's skills directory:

```bash
# Inspect the upstream README for exact paths
open https://github.com/ComposioHQ/awesome-claude-skills/tree/master/image-enhancer
```

Then ask the agent to invoke this skill by name (`image-enhancer`) or with
one of the trigger phrases listed in this skill's frontmatter.
