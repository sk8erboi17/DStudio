---
name: screenshot
description: |
  Capture desktop, app windows, or pixel regions across OS platforms. Useful for marketing screenshots, design reviews, and bug reports.
triggers:
  - "screenshot"
  - "capture screen"
  - "window screenshot"
  - "pixel region capture"
od:
  mode: image
  category: screenshots
  upstream: "https://github.com/openai/skills"
ds4_category: media-blueprint
ds4_local_mode: reference
ds4_output_kinds: image-brief
ds4_upstream: open-design/screenshot
ds4_modified_notice: Adapted for DStudio/DS4; added ds4_* metadata and local-first blueprint classification where needed.
ds4_source_repo: https://github.com/nexu-io/open-design
ds4_source_ref: main
ds4_source_commit: 2ff2d79bd54832696799984c05506fa4ed5dfcf3
---
# screenshot

> Curated from OpenAI's skills repository.

## What it does

Capture desktop, app windows, or pixel regions across OS platforms. Useful for marketing screenshots, design reviews, and bug reports.

## Source

- Upstream: https://github.com/openai/skills
- Category: `screenshots`

## How to use

This catalogue entry advertises the skill in Open Design so the agent
discovers it during planning. To run the full upstream workflow with
its original assets, scripts, and references, install the upstream
bundle into your active agent's skills directory:

```bash
# Inspect the upstream README for exact paths
open https://github.com/openai/skills
```

Then ask the agent to invoke this skill by name (`screenshot`) or with
one of the trigger phrases listed in this skill's frontmatter.
