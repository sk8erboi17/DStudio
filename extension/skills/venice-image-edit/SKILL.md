---
name: venice-image-edit
description: |
  Image edits, upscaling, and background removal via the Venice.ai API.
triggers:
  - "venice image edit"
  - "venice upscale"
  - "venice background removal"
od:
  mode: image
  category: image-generation
  upstream: "https://github.com/veniceai/skills"
ds4_category: provider-blueprint
ds4_local_mode: blueprint
ds4_output_kinds: image-brief
ds4_provider: venice
ds4_upstream: open-design/venice-image-edit
ds4_modified_notice: Adapted for DStudio/DS4; added ds4_* metadata and local-first blueprint classification where needed.
ds4_source_repo: https://github.com/nexu-io/open-design
ds4_source_ref: main
ds4_source_commit: 618a07d8db3a0e75e6d0e49f99a6eb9048f57036
---
# venice-image-edit

> Curated from the Venice.ai team.

## What it does

Image edits, upscaling, and background removal via the Venice.ai API.

## Source

- Upstream: https://github.com/veniceai/skills
- Category: `image-generation`

## How to use

This catalogue entry advertises the skill in Open Design so the agent
discovers it during planning. To run the full upstream workflow with
its original assets, scripts, and references, install the upstream
bundle into your active agent's skills directory:

```bash
# Inspect the upstream README for exact paths
open https://github.com/veniceai/skills
```

Then ask the agent to invoke this skill by name (`venice-image-edit`) or with
one of the trigger phrases listed in this skill's frontmatter.
