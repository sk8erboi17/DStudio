---
name: frontend-slides
description: |
  Generate animation-rich HTML presentations with visual style previews. Useful for online keynotes, embedded talks, and interactive briefs.
triggers:
  - "html slides"
  - "animation slides"
  - "interactive deck"
  - "web ppt"
  - "reveal slides"
od:
  mode: deck
  category: slides
  upstream: "https://github.com/zarazhangrui/frontend-slides"
ds4_category: deck-document
ds4_local_mode: native
ds4_output_kinds: deck
ds4_upstream: open-design/frontend-slides
ds4_modified_notice: Adapted for DStudio/DS4; added ds4_* metadata and local-first blueprint classification where needed.
ds4_source_repo: https://github.com/nexu-io/open-design
ds4_source_ref: main
ds4_source_commit: 618a07d8db3a0e75e6d0e49f99a6eb9048f57036
---
# frontend-slides

> Curated from @zarazhangrui.

## What it does

Generate animation-rich HTML presentations with visual style previews. Useful for online keynotes, embedded talks, and interactive briefs.

## Source

- Upstream: https://github.com/zarazhangrui/frontend-slides
- Category: `slides`

## How to use

This catalogue entry advertises the skill in Open Design so the agent
discovers it during planning. To run the full upstream workflow with
its original assets, scripts, and references, install the upstream
bundle into your active agent's skills directory:

```bash
# Inspect the upstream README for exact paths
open https://github.com/zarazhangrui/frontend-slides
```

Then ask the agent to invoke this skill by name (`frontend-slides`) or with
one of the trigger phrases listed in this skill's frontmatter.
