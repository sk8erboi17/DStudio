---
name: screenshots-marketing
description: |
  Generate marketing screenshots with browser automation. Useful for landing-page hero shots, App Store screenshots, and changelog visuals.
triggers:
  - "marketing screenshot"
  - "hero shot"
  - "app store screenshot"
od:
  mode: image
  category: screenshots
  upstream: "https://github.com/Shpigford/screenshots"
ds4_category: media-blueprint
ds4_local_mode: reference
ds4_output_kinds: image-brief
ds4_upstream: open-design/screenshots-marketing
ds4_modified_notice: Adapted for DStudio/DS4; added ds4_* metadata and local-first blueprint classification where needed.
ds4_source_repo: https://github.com/nexu-io/open-design
ds4_source_ref: main
ds4_source_commit: 2ff2d79bd54832696799984c05506fa4ed5dfcf3
---
# screenshots-marketing

> Curated from @Shpigford.

## What it does

Generate marketing screenshots with Playwright. Useful for landing-page hero shots, App Store screenshots, and changelog visuals.

## Source

- Upstream: https://github.com/Shpigford/screenshots
- Category: `screenshots`

## How to use

This catalogue entry advertises the skill in Open Design so the agent
discovers it during planning. To run the full upstream workflow with
its original assets, scripts, and references, install the upstream
bundle into your active agent's skills directory:

```bash
# Inspect the upstream README for exact paths
open https://github.com/Shpigford/screenshots
```

Then ask the agent to invoke this skill by name (`screenshots-marketing`) or with
one of the trigger phrases listed in this skill's frontmatter.
