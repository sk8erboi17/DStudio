---
name: fal-video-edit
description: |
  Edit existing videos using AI — remix style, upscale, remove background, and add audio via fal.ai's hosted video models.
triggers:
  - "fal video edit"
  - "video upscale"
  - "video style transfer"
  - "remove video bg"
  - "video remix"
od:
  mode: video
  category: video-generation
  upstream: "https://github.com/fal-ai-community/skills"
ds4_category: provider-blueprint
ds4_local_mode: blueprint
ds4_output_kinds: video-storyboard
ds4_provider: fal
ds4_upstream: open-design/fal-video-edit
ds4_modified_notice: Adapted for DStudio/DS4; added ds4_* metadata and local-first blueprint classification where needed.
ds4_source_repo: https://github.com/nexu-io/open-design
ds4_source_ref: main
ds4_source_commit: 618a07d8db3a0e75e6d0e49f99a6eb9048f57036
---
# fal-video-edit

> Curated from the fal.ai community team.

## What it does

Edit existing videos using AI — remix style, upscale, remove background, and add audio via fal.ai's hosted video models.

## Source

- Upstream: https://github.com/fal-ai-community/skills
- Category: `video-generation`

## How to use

This catalogue entry advertises the skill in Open Design so the agent
discovers it during planning. To run the full upstream workflow with
its original assets, scripts, and references, install the upstream
bundle into your active agent's skills directory:

```bash
# Inspect the upstream README for exact paths
open https://github.com/fal-ai-community/skills
```

Then ask the agent to invoke this skill by name (`fal-video-edit`) or with
one of the trigger phrases listed in this skill's frontmatter.
