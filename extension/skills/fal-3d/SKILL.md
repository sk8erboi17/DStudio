---
name: fal-3d
description: |
  Generate 3D models from text or images via fal.ai. Useful for game assets, AR previews, product mockups, and concept sculpting.
triggers:
  - "fal 3d"
  - "text to 3d"
  - "image to 3d"
  - "3d model gen"
  - "game asset 3d"
od:
  mode: image
  category: 3d-shaders
  upstream: "https://github.com/fal-ai-community/skills"
ds4_category: provider-blueprint
ds4_local_mode: blueprint
ds4_output_kinds: image-brief
ds4_provider: fal
ds4_upstream: open-design/fal-3d
ds4_modified_notice: Adapted for DStudio/DS4; added ds4_* metadata and local-first blueprint classification where needed.
ds4_source_repo: https://github.com/nexu-io/open-design
ds4_source_ref: main
ds4_source_commit: 618a07d8db3a0e75e6d0e49f99a6eb9048f57036
---
# fal-3d

> Curated from the fal.ai community team.

## What it does

Generate 3D models from text or images via fal.ai. Useful for game assets, AR previews, product mockups, and concept sculpting.

## Source

- Upstream: https://github.com/fal-ai-community/skills
- Category: `3d-shaders`

## How to use

This catalogue entry advertises the skill in Open Design so the agent
discovers it during planning. To run the full upstream workflow with
its original assets, scripts, and references, install the upstream
bundle into your active agent's skills directory:

```bash
# Inspect the upstream README for exact paths
open https://github.com/fal-ai-community/skills
```

Then ask the agent to invoke this skill by name (`fal-3d`) or with
one of the trigger phrases listed in this skill's frontmatter.
