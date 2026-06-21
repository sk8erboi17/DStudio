---
name: venice-video
description: |
  Video generation and transcription workflows via the Venice.ai API.
triggers:
  - "venice video"
  - "venice video gen"
  - "venice transcribe"
od:
  mode: video
  category: video-generation
  upstream: "https://github.com/veniceai/skills"
ds4_category: provider-blueprint
ds4_local_mode: blueprint
ds4_output_kinds: video-storyboard
ds4_provider: venice
ds4_upstream: open-design/venice-video
ds4_modified_notice: Adapted for DStudio/DS4; added ds4_* metadata and local-first blueprint classification where needed.
ds4_source_repo: https://github.com/nexu-io/open-design
ds4_source_ref: main
ds4_source_commit: 618a07d8db3a0e75e6d0e49f99a6eb9048f57036
---
# venice-video

> Curated from the Venice.ai team.

## What it does

Video generation and transcription workflows via the Venice.ai API.

## Source

- Upstream: https://github.com/veniceai/skills
- Category: `video-generation`

## How to use

This catalogue entry advertises the skill in Open Design so the agent
discovers it during planning. To run the full upstream workflow with
its original assets, scripts, and references, install the upstream
bundle into your active agent's skills directory:

```bash
# Inspect the upstream README for exact paths
open https://github.com/veniceai/skills
```

Then ask the agent to invoke this skill by name (`venice-video`) or with
one of the trigger phrases listed in this skill's frontmatter.
