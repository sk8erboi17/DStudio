---
name: frontend-skill
description: |
  Create visually strong landing pages, websites, and app UIs with restrained composition. OpenAI's production frontend playbook.
triggers:
  - "landing page"
  - "frontend playbook"
  - "ui composition"
  - "restrained ui"
od:
  mode: design-system
  category: design-systems
  upstream: "https://github.com/openai/skills"
ds4_category: web-ui-prototype
ds4_local_mode: native
ds4_output_kinds: html
ds4_upstream: open-design/frontend-skill
ds4_modified_notice: Adapted for DStudio/DS4; added ds4_* metadata and local-first blueprint classification where needed.
---

# frontend-skill

> Curated from OpenAI's skills repository.

## What it does

Create visually strong landing pages, websites, and app UIs with restrained composition. OpenAI's production frontend playbook.

## Source

- Upstream: https://github.com/openai/skills
- Category: `design-systems`

## How to use

This catalogue entry advertises the skill in Open Design so the agent
discovers it during planning. To run the full upstream workflow with
its original assets, scripts, and references, install the upstream
bundle into your active agent's skills directory:

```bash
# Inspect the upstream README for exact paths
open https://github.com/openai/skills
```

Then ask the agent to invoke this skill by name (`frontend-skill`) or with
one of the trigger phrases listed in this skill's frontmatter.
