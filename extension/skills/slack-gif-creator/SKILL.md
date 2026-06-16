---
name: slack-gif-creator
description: |
  Create animated GIFs optimized for Slack with validators for size constraints and composable animation primitives.
triggers:
  - "slack gif"
  - "animated gif"
  - "reaction gif"
  - "tiny gif"
od:
  mode: image
  category: image-generation
  upstream: "https://github.com/anthropics/skills/tree/main/slack-gif-creator"
ds4_category: media-blueprint
ds4_local_mode: reference
ds4_output_kinds: video-storyboard
ds4_upstream: open-design/slack-gif-creator
ds4_modified_notice: Adapted for DStudio/DS4; added ds4_* metadata and local-first blueprint classification where needed.
ds4_source_repo: https://github.com/nexu-io/open-design
ds4_source_ref: main
ds4_source_commit: 2ff2d79bd54832696799984c05506fa4ed5dfcf3
---
# slack-gif-creator

> Curated from Anthropic's official skills repository.

## What it does

Create animated GIFs optimized for Slack with validators for size constraints and composable animation primitives.

## Source

- Upstream: https://github.com/anthropics/skills/tree/main/skills/slack-gif-creator
- Category: `image-generation`

## How to use

This catalogue entry advertises the skill in Open Design so the agent
discovers it during planning. To run the full upstream workflow with
its original assets, scripts, and references, install the upstream
bundle into your active agent's skills directory:

```bash
# Inspect the upstream README for exact paths
open https://github.com/anthropics/skills/tree/main/skills/slack-gif-creator
```

Then ask the agent to invoke this skill by name (`slack-gif-creator`) or with
one of the trigger phrases listed in this skill's frontmatter.
