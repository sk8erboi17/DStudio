---
name: doc
description: |
  Read, create, and edit .docx documents with formatting and layout fidelity via OpenAI's document skill.
triggers:
  - "openai doc"
  - "docx fidelity"
  - "word doc edit"
  - "layout doc"
od:
  mode: prototype
  category: documents
  upstream: "https://github.com/openai/skills"
ds4_category: deck-document
ds4_local_mode: native
ds4_output_kinds: markdown-document
ds4_upstream: open-design/doc
ds4_modified_notice: Adapted for DStudio/DS4; added ds4_* metadata and local-first blueprint classification where needed.
ds4_source_repo: https://github.com/nexu-io/open-design
ds4_source_ref: main
ds4_source_commit: 2ff2d79bd54832696799984c05506fa4ed5dfcf3
---
# doc

> Curated from OpenAI's skills repository.

## What it does

Read, create, and edit .docx documents with formatting and layout fidelity via OpenAI's document skill.

## Source

- Upstream: https://github.com/openai/skills
- Category: `documents`

## How to use

This catalogue entry advertises the skill in Open Design so the agent
discovers it during planning. To run the full upstream workflow with
its original assets, scripts, and references, install the upstream
bundle into your active agent's skills directory:

```bash
# Inspect the upstream README for exact paths
open https://github.com/openai/skills
```

Then ask the agent to invoke this skill by name (`doc`) or with
one of the trigger phrases listed in this skill's frontmatter.
