---
name: theme-factory
description: |
  Apply professional font and color themes to artifacts including slides, docs, reports, and HTML landing pages. Ships 10 pre-set themes.
triggers:
  - "theme factory"
  - "apply theme"
  - "design theme"
  - "theme generator"
  - "preset theme"
od:
  mode: design-system
  category: design-systems
  upstream: "https://github.com/anthropics/skills/tree/main/theme-factory"
ds4_category: deck-document
ds4_local_mode: reference
ds4_output_kinds: html
ds4_upstream: open-design/theme-factory
ds4_modified_notice: Adapted for DStudio/DS4; added ds4_* metadata and local-first blueprint classification where needed.
ds4_source_repo: https://github.com/nexu-io/open-design
ds4_source_ref: main
ds4_source_commit: 618a07d8db3a0e75e6d0e49f99a6eb9048f57036
---
# theme-factory

> Curated from Anthropic's official skills repository.

## What it does

Apply professional font and color themes to artifacts including slides, docs, reports, and HTML landing pages. Ships 10 pre-set themes.

## Source

- Upstream: https://github.com/anthropics/skills/tree/main/skills/theme-factory
- Category: `design-systems`

## How to use

This catalogue entry advertises the skill in Open Design so the agent
discovers it during planning. To run the full upstream workflow with
its original assets, scripts, and references, install the upstream
bundle into your active agent's skills directory:

```bash
# Inspect the upstream README for exact paths
open https://github.com/anthropics/skills/tree/main/skills/theme-factory
```

Then ask the agent to invoke this skill by name (`theme-factory`) or with
one of the trigger phrases listed in this skill's frontmatter.
