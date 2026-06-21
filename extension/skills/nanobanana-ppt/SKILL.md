---
name: nanobanana-ppt
description: |
  AI-powered PPT generation with document analysis and styled images via the NanoBanana stack. Combines image generation with structured deck output.
triggers:
  - "nanobanana ppt"
  - "ai ppt"
  - "styled ppt"
  - "document to ppt"
  - "banana ppt"
od:
  mode: deck
  category: image-generation
  upstream: "https://github.com/op7418/NanoBanana-PPT-Skills"
ds4_category: provider-blueprint
ds4_local_mode: blueprint
ds4_output_kinds: image-brief
ds4_provider: nanobanana
ds4_upstream: open-design/nanobanana-ppt
ds4_modified_notice: Adapted for DStudio/DS4; added ds4_* metadata and local-first blueprint classification where needed.
ds4_source_repo: https://github.com/nexu-io/open-design
ds4_source_ref: main
ds4_source_commit: 618a07d8db3a0e75e6d0e49f99a6eb9048f57036
---
# nanobanana-ppt

> Curated from @op7418.

## What it does

AI-powered PPT generation with document analysis and styled images via the NanoBanana stack. Combines image generation with structured deck output.

## Source

- Upstream: https://github.com/op7418/NanoBanana-PPT-Skills
- Category: `image-generation`

## How to use

This catalogue entry advertises the skill in Open Design so the agent
discovers it during planning. To run the full upstream workflow with
its original assets, scripts, and references, install the upstream
bundle into your active agent's skills directory:

```bash
# Inspect the upstream README for exact paths
open https://github.com/op7418/NanoBanana-PPT-Skills
```

Then ask the agent to invoke this skill by name (`nanobanana-ppt`) or with
one of the trigger phrases listed in this skill's frontmatter.
