---
name: sora
description: |
  Generate, remix, and manage short video clips via OpenAI's Sora API. Useful for cinematic shots, b-roll, and rapid concept video iteration.
triggers:
  - "sora"
  - "openai video"
  - "short video"
  - "b roll"
  - "cinematic clip"
od:
  mode: video
  category: video-generation
  upstream: "https://github.com/openai/skills"
ds4_category: provider-blueprint
ds4_local_mode: blueprint
ds4_output_kinds: video-storyboard
ds4_provider: sora
ds4_upstream: open-design/sora
ds4_modified_notice: Adapted for DStudio/DS4; added ds4_* metadata and local-first blueprint classification where needed.
ds4_source_repo: https://github.com/nexu-io/open-design
ds4_source_ref: main
ds4_source_commit: 2ff2d79bd54832696799984c05506fa4ed5dfcf3
---
# sora

> Curated from OpenAI's skills repository.

## What it does

Generate, remix, and manage short video clips via OpenAI's Sora API. Useful for cinematic shots, b-roll, and rapid concept video iteration.

## Source

- Upstream: https://github.com/openai/skills
- Category: `video-generation`

## How to use

This catalogue entry advertises the skill in Open Design so the agent
discovers it during planning. To run the full upstream workflow with
its original assets, scripts, and references, install the upstream
bundle into your active agent's skills directory:

```bash
# Inspect the upstream README for exact paths
open https://github.com/openai/skills
```

Then ask the agent to invoke this skill by name (`sora`) or with
one of the trigger phrases listed in this skill's frontmatter.
