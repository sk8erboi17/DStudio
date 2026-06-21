---
name: youtube-clipper
description: |
  YouTube clip generation and editing with automated workflows — pull source video, slice highlights, add captions, and export.
triggers:
  - "youtube clip"
  - "video clip"
  - "highlight reel"
  - "auto caption clip"
od:
  mode: video
  category: video-generation
  upstream: "https://github.com/op7418/Youtube-clipper-skill"
ds4_category: provider-blueprint
ds4_local_mode: blueprint
ds4_output_kinds: video-storyboard
ds4_provider: youtube
ds4_upstream: open-design/youtube-clipper
ds4_modified_notice: Adapted for DStudio/DS4; added ds4_* metadata and local-first blueprint classification where needed.
ds4_source_repo: https://github.com/nexu-io/open-design
ds4_source_ref: main
ds4_source_commit: 618a07d8db3a0e75e6d0e49f99a6eb9048f57036
---
# youtube-clipper

> Curated from @op7418.

## What it does

YouTube clip generation and editing with automated workflows — pull source video, slice highlights, add captions, and export.

## Source

- Upstream: https://github.com/op7418/Youtube-clipper-skill
- Category: `video-generation`

## How to use

This catalogue entry advertises the skill in Open Design so the agent
discovers it during planning. To run the full upstream workflow with
its original assets, scripts, and references, install the upstream
bundle into your active agent's skills directory:

```bash
# Inspect the upstream README for exact paths
open https://github.com/op7418/Youtube-clipper-skill
```

Then ask the agent to invoke this skill by name (`youtube-clipper`) or with
one of the trigger phrases listed in this skill's frontmatter.
