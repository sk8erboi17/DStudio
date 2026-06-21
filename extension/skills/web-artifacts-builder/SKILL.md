---
name: web-artifacts-builder
description: |
  Build complex claude.ai HTML artifacts with React and Tailwind. Anthropic's reference workflow for shipping rich, embeddable artifacts.
triggers:
  - "web artifacts"
  - "tailwind artifact"
  - "react artifact"
  - "anthropic artifact"
od:
  mode: prototype
  category: web-artifacts
  upstream: "https://github.com/anthropics/skills/tree/main/web-artifacts-builder"
ds4_category: web-ui-prototype
ds4_local_mode: native
ds4_output_kinds: html
ds4_upstream: open-design/web-artifacts-builder
ds4_modified_notice: Adapted for DStudio/DS4; added ds4_* metadata and local-first blueprint classification where needed.
ds4_source_repo: https://github.com/nexu-io/open-design
ds4_source_ref: main
ds4_source_commit: 618a07d8db3a0e75e6d0e49f99a6eb9048f57036
---
# web-artifacts-builder

> Curated from Anthropic's official skills repository.

## What it does

Build complex claude.ai HTML artifacts with React and Tailwind. Anthropic's reference workflow for shipping rich, embeddable artifacts.

## Source

- Upstream: https://github.com/anthropics/skills/tree/main/skills/web-artifacts-builder
- Category: `web-artifacts`

## How to use

This catalogue entry advertises the skill in Open Design so the agent
discovers it during planning. To run the full upstream workflow with
its original assets, scripts, and references, install the upstream
bundle into your active agent's skills directory:

```bash
# Inspect the upstream README for exact paths
open https://github.com/anthropics/skills/tree/main/skills/web-artifacts-builder
```

Then ask the agent to invoke this skill by name (`web-artifacts-builder`) or with
one of the trigger phrases listed in this skill's frontmatter.
