---
name: fal-lip-sync
description: |
  Create talking head videos and lip sync audio to video via fal.ai. Useful for explainer avatars, multilingual dubbing previews, and social cuts.
triggers:
  - "lip sync"
  - "talking head"
  - "audio to video"
  - "avatar video"
  - "fal lipsync"
od:
  mode: video
  category: video-generation
  upstream: "https://github.com/fal-ai-community/skills"
ds4_category: provider-blueprint
ds4_local_mode: blueprint
ds4_output_kinds: video-storyboard
ds4_provider: fal
ds4_upstream: open-design/fal-lip-sync
ds4_modified_notice: Adapted for DStudio/DS4; added ds4_* metadata and local-first blueprint classification where needed.
ds4_source_repo: https://github.com/nexu-io/open-design
ds4_source_ref: main
ds4_source_commit: 2ff2d79bd54832696799984c05506fa4ed5dfcf3
---
# fal-lip-sync

> Curated from the fal.ai community team.

## What it does

Create talking head videos and lip sync audio to video via fal.ai. Useful for explainer avatars, multilingual dubbing previews, and social cuts.

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

Then ask the agent to invoke this skill by name (`fal-lip-sync`) or with
one of the trigger phrases listed in this skill's frontmatter.
