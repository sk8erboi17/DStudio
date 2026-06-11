---
name: figma-generate-design
description: |
  Build or update screens in Figma from code or description using design system components. Translate app pages into Figma using design tokens.
triggers:
  - "figma generate design"
  - "code to figma"
  - "screen generation"
  - "figma from code"
od:
  mode: design-system
  category: figma
  upstream: "https://github.com/figma/skills"
ds4_category: provider-blueprint
ds4_local_mode: blueprint
ds4_output_kinds: figma-brief
ds4_provider: figma
ds4_upstream: open-design/figma-generate-design
ds4_modified_notice: Adapted for DStudio/DS4; added ds4_* metadata and local-first blueprint classification where needed.
---

# figma-generate-design

> Curated from Figma's MCP server guide.

## What it does

Build or update screens in Figma from code or description using design system components. Translate app pages into Figma using design tokens.

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

Then ask the agent to invoke this skill by name (`figma-generate-design`) or with
one of the trigger phrases listed in this skill's frontmatter.
