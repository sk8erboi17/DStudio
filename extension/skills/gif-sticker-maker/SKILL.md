---
name: gif-sticker-maker
description: |
  Convert photos into animated GIF stickers in Funko Pop / Pop Mart style via the MiniMax API. Useful for personalized chat stickers and avatar packs.
triggers:
  - "gif sticker"
  - "funko sticker"
  - "animated sticker"
  - "pop mart"
  - "表情包"
od:
  mode: image
  category: image-generation
  upstream: "https://github.com/MiniMax-AI/skills"
ds4_category: media-blueprint
ds4_local_mode: reference
ds4_output_kinds: video-storyboard
ds4_upstream: open-design/gif-sticker-maker
ds4_modified_notice: Adapted for DStudio/DS4; added ds4_* metadata and local-first blueprint classification where needed.
ds4_source_repo: https://github.com/nexu-io/open-design
ds4_source_ref: main
ds4_source_commit: 618a07d8db3a0e75e6d0e49f99a6eb9048f57036
---
# gif-sticker-maker

> Curated from MiniMax AI team.

## What it does

Convert photos into animated GIF stickers in Funko Pop / Pop Mart style via the MiniMax API. Useful for personalized chat stickers and avatar packs.

## Source

- Upstream: https://github.com/MiniMax-AI/skills
- Category: `image-generation`

## How to use

This catalogue entry advertises the skill in Open Design so the agent
discovers it during planning. To run the full upstream workflow with
its original assets, scripts, and references, install the upstream
bundle into your active agent's skills directory:

```bash
# Inspect the upstream README for exact paths
open https://github.com/MiniMax-AI/skills
```

Then ask the agent to invoke this skill by name (`gif-sticker-maker`) or with
one of the trigger phrases listed in this skill's frontmatter.
