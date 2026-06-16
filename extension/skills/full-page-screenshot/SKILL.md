---
name: full-page-screenshot
description: |
  Capture full-page screenshots of web pages via Chrome DevTools Protocol with zero dependencies. Useful for portfolios, case studies, and audit reports.
triggers:
  - "full page screenshot"
  - "long screenshot"
  - "devtools screenshot"
  - "web capture"
od:
  mode: image
  category: screenshots
  upstream: "https://github.com/LewisLiu007/full-page-screenshot"
ds4_category: media-blueprint
ds4_local_mode: reference
ds4_output_kinds: image-brief
ds4_upstream: open-design/full-page-screenshot
ds4_modified_notice: Adapted for DStudio/DS4; added ds4_* metadata and local-first blueprint classification where needed.
ds4_source_repo: https://github.com/nexu-io/open-design
ds4_source_ref: main
ds4_source_commit: 2ff2d79bd54832696799984c05506fa4ed5dfcf3
---
# full-page-screenshot

> Curated from @LewisLiu007.

## What it does

Capture full-page screenshots of web pages via Chrome DevTools Protocol with zero dependencies. Useful for portfolios, case studies, and audit reports.

## Source

- Upstream: https://github.com/LewisLiu007/full-page-screenshot
- Category: `screenshots`

## How to use

This catalogue entry advertises the skill in Open Design so the agent
discovers it during planning. To run the full upstream workflow with
its original assets, scripts, and references, install the upstream
bundle into your active agent's skills directory:

```bash
# Inspect the upstream README for exact paths
open https://github.com/LewisLiu007/full-page-screenshot
```

Then ask the agent to invoke this skill by name (`full-page-screenshot`) or with
one of the trigger phrases listed in this skill's frontmatter.
