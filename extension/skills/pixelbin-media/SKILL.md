---
name: pixelbin-media
description: |
  Generate and edit images and videos with an 85+ API portfolio and build visually appealing website pages via Pixelbin.
triggers:
  - "pixelbin"
  - "media generation"
  - "image transform"
  - "video transform"
  - "cdn media"
od:
  mode: image
  category: image-generation
  upstream: "https://github.com/pixelbin-dev/skills"
ds4_category: provider-blueprint
ds4_local_mode: blueprint
ds4_output_kinds: video-storyboard
ds4_provider: pixelbin
ds4_upstream: open-design/pixelbin-media
ds4_modified_notice: Adapted for DStudio/DS4; added ds4_* metadata and local-first blueprint classification where needed.
ds4_source_repo: https://github.com/nexu-io/open-design
ds4_source_ref: main
ds4_source_commit: 2ff2d79bd54832696799984c05506fa4ed5dfcf3
---
# pixelbin-media

> Curated from Pixelbin.

## What it does

Generate and edit images and videos with an 85+ API portfolio and build visually appealing website pages via Pixelbin.

## Source

- Upstream: https://github.com/pixelbin-dev/skills
- Category: `image-generation`

## How to use

This catalogue entry advertises the skill in Open Design so the agent
discovers it during planning. To run the full upstream workflow with
its original assets, scripts, and references, install the upstream
bundle into your active agent's skills directory:

```bash
# Inspect the upstream README for exact paths
open https://github.com/pixelbin-dev/skills
```

Then ask the agent to invoke this skill by name (`pixelbin-media`) or with
one of the trigger phrases listed in this skill's frontmatter.
