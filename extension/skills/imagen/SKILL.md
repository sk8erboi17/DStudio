---
name: imagen
description: |
  Generate images using Google Gemini's image generation API for UI mockups, icons, illustrations, and visual assets.
triggers:
  - "gemini image"
  - "imagen"
  - "google image gen"
  - "illustration"
  - "icon"
od:
  mode: image
  category: image-generation
  upstream: "https://github.com/sanjay3290/imagen"
ds4_category: provider-blueprint
ds4_local_mode: blueprint
ds4_output_kinds: image-brief
ds4_provider: imagen
ds4_upstream: open-design/imagen
ds4_modified_notice: Adapted for DStudio/DS4; added ds4_* metadata and local-first blueprint classification where needed.
ds4_source_repo: https://github.com/nexu-io/open-design
ds4_source_ref: main
ds4_source_commit: 618a07d8db3a0e75e6d0e49f99a6eb9048f57036
---
# imagen

> Curated from @sanjay3290.

## What it does

Generate images using Google Gemini's image generation API for UI mockups, icons, illustrations, and visual assets.

## Source

- Upstream: https://github.com/sanjay3290/imagen
- Category: `image-generation`

## How to use

This catalogue entry advertises the skill in Open Design so the agent
discovers it during planning. To run the full upstream workflow with
its original assets, scripts, and references, install the upstream
bundle into your active agent's skills directory:

```bash
# Inspect the upstream README for exact paths
open https://github.com/sanjay3290/imagen
```

Then ask the agent to invoke this skill by name (`imagen`) or with
one of the trigger phrases listed in this skill's frontmatter.
