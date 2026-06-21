---
name: imagegen
description: |
  Generate and edit images using OpenAI's Image API for project assets — UI mockups, icons, illustrations, social cards, and visual references.
triggers:
  - "generate image"
  - "create image"
  - "image gen"
  - "openai image"
  - "icon design"
  - "mockup"
od:
  mode: image
  category: image-generation
  upstream: "https://github.com/openai/skills"
ds4_category: media-blueprint
ds4_local_mode: reference
ds4_output_kinds: image-brief
ds4_upstream: open-design/imagegen
ds4_modified_notice: Adapted for DStudio/DS4; added ds4_* metadata and local-first blueprint classification where needed.
ds4_source_repo: https://github.com/nexu-io/open-design
ds4_source_ref: main
ds4_source_commit: 618a07d8db3a0e75e6d0e49f99a6eb9048f57036
---
# imagegen

> Curated from OpenAI's skills repository.

## What it does

Generate and edit images using OpenAI's Image API for project assets — UI mockups, icons, illustrations, social cards, and visual references.

## Source

- Upstream: https://github.com/openai/skills
- Category: `image-generation`

## How to use

This catalogue entry advertises the skill in Open Design so the agent
discovers it during planning. To run the full upstream workflow with
its original assets, scripts, and references, install the upstream
bundle into your active agent's skills directory:

```bash
# Inspect the upstream README for exact paths
open https://github.com/openai/skills
```

Then ask the agent to invoke this skill by name (`imagegen`) or with
one of the trigger phrases listed in this skill's frontmatter.
