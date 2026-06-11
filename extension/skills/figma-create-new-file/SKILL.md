---
name: figma-create-new-file
description: |
  Create a new blank Figma Design or FigJam file. Useful as the first step in scripted design-system or workshop workflows.
triggers:
  - "figma new file"
  - "figjam new"
  - "create figma file"
od:
  mode: design-system
  category: figma
  upstream: "https://github.com/figma/skills"
ds4_category: provider-blueprint
ds4_local_mode: blueprint
ds4_output_kinds: figma-brief
ds4_provider: figma
ds4_upstream: open-design/figma-create-new-file
ds4_modified_notice: Adapted for DStudio/DS4; added ds4_* metadata and local-first blueprint classification where needed.
---

# figma-create-new-file

> Curated from Figma's MCP server guide.

## What it does

Create a new blank Figma Design or FigJam file. Useful as the first step in scripted design-system or workshop workflows.

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

Then ask the agent to invoke this skill by name (`figma-create-new-file`) or with
one of the trigger phrases listed in this skill's frontmatter.
