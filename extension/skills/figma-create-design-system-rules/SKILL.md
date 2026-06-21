---
name: figma-create-design-system-rules
description: |
  Generate project-specific design system rules for Figma-to-code workflows. Useful for capturing tokens, naming, and lint rules in one source.
triggers:
  - "figma rules"
  - "design system rules"
  - "figma to code rules"
  - "figma tokens"
od:
  mode: design-system
  category: figma
  upstream: "https://github.com/figma/skills"
ds4_category: provider-blueprint
ds4_local_mode: blueprint
ds4_output_kinds: figma-brief
ds4_provider: figma
ds4_upstream: open-design/figma-create-design-system-rules
ds4_modified_notice: Adapted for DStudio/DS4; added ds4_* metadata and local-first blueprint classification where needed.
ds4_source_repo: https://github.com/nexu-io/open-design
ds4_source_ref: main
ds4_source_commit: 618a07d8db3a0e75e6d0e49f99a6eb9048f57036
---
# figma-create-design-system-rules

> Curated from Figma's MCP server guide.

## What it does

Generate project-specific design system rules for Figma-to-code workflows. Useful for capturing tokens, naming, and lint rules in one source.

## Source

- Upstream: https://github.com/figma/skills
- Category: `figma`

## How to use

This catalogue entry advertises the skill in Open Design so the agent
discovers it during planning. To run the full upstream workflow with
its original assets, scripts, and references, install the upstream
bundle into your active agent's skills directory:

```bash
# Inspect the upstream README for exact paths
open https://github.com/figma/skills
```

Then ask the agent to invoke this skill by name (`figma-create-design-system-rules`) or with
one of the trigger phrases listed in this skill's frontmatter.
