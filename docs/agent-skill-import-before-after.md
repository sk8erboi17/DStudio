# Agent Skill Import: Before / After

Date: 2026-06-14

## Scope

Imported Agent skills only. GSA skills were intentionally skipped because that catalog was already integrated.

- ECC: `.agents/skills/*` from `https://github.com/affaan-m/ECC`
- Superpowers: `skills/*` from `https://github.com/obra/superpowers`
- Anthropic security review: `.claude/commands/security-review.md` from `https://github.com/anthropics/claude-code-security-review`

## Catalog Delta

Before:

```text
extension/skills SKILL.md count: 204
```

After:

```text
extension/skills SKILL.md count: 252
Imported Agent skills: 48
```

Imported groups:

```text
ecc-*                                      33 skills
superpowers-*                             14 skills
anthropic-claude-code-security-review      1 skill
```

## Before / After: ECC

Source frontmatter:

```md
---
name: security-review
description: Use this skill when adding authentication, handling user input, working with secrets, creating API endpoints, or implementing payment/sensitive features. Provides comprehensive security checklist and patterns.
---
```

DStudio frontmatter:

```md
---
name: ecc-security-review
description: |
  Use this skill when adding authentication, handling user input, working with secrets, creating API endpoints, or implementing payment/sensitive features. Provides comprehensive security checklist and patterns.
modes: [agent]
ds4_category: imported-agent
ds4_local_mode: reference
ds4_output_kinds: markdown
ds4_provider: ecc
ds4_upstream: ECC/.agents/skills/security-review
ds4_source_repo: https://github.com/affaan-m/ECC
ds4_modified_notice: Adapted for DStudio/DS4 Agent catalog; namespaced to avoid local skill collisions.
---
```

Example output path:

```text
extension/skills/ecc-security-review/SKILL.md
```

## Before / After: Superpowers

Source frontmatter:

```md
---
name: systematic-debugging
description: Use when encountering any bug, test failure, or unexpected behavior, before proposing fixes
---
```

DStudio frontmatter:

```md
---
name: superpowers-systematic-debugging
description: |
  Use when encountering any bug, test failure, or unexpected behavior, before proposing fixes
modes: [agent]
ds4_category: imported-agent
ds4_local_mode: reference
ds4_output_kinds: markdown
ds4_provider: superpowers
ds4_upstream: superpowers/systematic-debugging
ds4_source_repo: https://github.com/obra/superpowers
ds4_modified_notice: Adapted for DStudio/DS4 Agent catalog; namespaced to avoid local skill collisions.
---
```

Example output path:

```text
extension/skills/superpowers-systematic-debugging/SKILL.md
```

## Before / After: Anthropic Security Review

Source command frontmatter:

```md
---
allowed-tools: Bash(git diff:*), Bash(git status:*), Bash(git log:*), Bash(git show:*), Bash(git remote show:*), Read, Glob, Grep, LS, Task
description: Complete a security review of the pending changes on the current branch
---
```

DStudio skill frontmatter:

```md
---
name: anthropic-claude-code-security-review
description: |
  Complete high-confidence security review of pending branch changes, pull requests, authentication, authorization, user input, secrets, API endpoints, or sensitive data handling. Use when an agent must inspect git diffs, compare new code against existing security patterns, minimize false positives, and report exploitable vulnerabilities with severity, category, exploit scenario, and fix recommendation.
modes: [agent]
ds4_category: imported-agent
ds4_local_mode: reference
ds4_output_kinds: markdown
ds4_provider: anthropic
ds4_upstream: claude-code-security-review/.claude/commands/security-review.md
ds4_source_repo: https://github.com/anthropics/claude-code-security-review
ds4_modified_notice: Adapted from a Claude Code slash command into a DStudio/DS4 Agent skill.
---
```

Output path:

```text
extension/skills/anthropic-claude-code-security-review/SKILL.md
```

References copied:

```text
extension/skills/anthropic-claude-code-security-review/references/security-review-command.md
extension/skills/anthropic-claude-code-security-review/references/custom-security-scan-instructions.md
extension/skills/anthropic-claude-code-security-review/references/custom-filtering-instructions.md
```

## UI / Runtime Behavior

The Agent skill picker now exposes the imported skills under the existing Agent categories. Selecting one does not restart Agent or Design. The selected skill is injected into the next runtime prompt:

```text
[DStudio selected skill: ecc-security-review]
Use the selected skill "ecc-security-review" for this turn. If it is not already loaded in this runtime, call skill("ecc-security-review") once before relying on its workflow.
[/DStudio selected skill]
```

## Design Gallery Check

The design gallery now merges:

- original Open Design template examples from `/api/skills`
- local design systems from `/api/design-systems`

Current design-system catalog in this checkout:

```text
extension/design-systems directories: 156
DESIGN.md files: 156
components.html previews: 144
```

Design systems with `components.html` load the original local preview through:

```text
/api/design-system-preview/<id>/components.html
```

Design systems without `components.html` remain selectable through a text card based on `DESIGN.md` metadata.

## Verification

```text
node tests/ui_contract_test.mjs
node tests/ui_agent_design_playwright_test.mjs
node tests/ui_gsa_playwright_test.mjs
make
```

Screenshots generated during Playwright verification:

```text
/tmp/dstudio-imported-skills-picker.png
/tmp/dstudio-design-gallery-design-systems.png
/tmp/dstudio-design-gallery-design-systems-lower.png
```
