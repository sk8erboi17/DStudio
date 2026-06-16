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

# Claude Code Security Review

> Imported from https://github.com/anthropics/claude-code-security-review.
> Original artifact: `.claude/commands/security-review.md`.
> DStudio catalog id: `anthropic-claude-code-security-review`.

## Workflow

Use this skill to perform a focused security review of pending code changes. Prefer the same evidence flow as the upstream command:

1. Inspect `git status`, changed files, commits, and the merge-base diff.
2. Research repository security patterns before judging new code.
3. Trace inputs through sensitive operations and privilege boundaries.
4. Report only high-confidence vulnerabilities with realistic exploit potential.
5. Exclude low-signal findings, style issues, generic hardening advice, denial-of-service only issues, and secrets-on-disk alerts handled by other scanning systems unless the task explicitly asks for them.

## References

Read these files when doing the corresponding work:

- `references/security-review-command.md`: upstream review prompt and required output format.
- `references/custom-security-scan-instructions.md`: how to add custom scan rules.
- `references/custom-filtering-instructions.md`: how to tune false-positive filtering.
- `references/custom-security-scan-instructions-example.txt`: example custom scan instructions.
- `references/custom-false-positive-filtering-example.txt`: example false-positive filtering instructions.

## Output

Return markdown findings. For each finding include file, line, severity, category, description, exploit scenario, and concrete fix. If no high-confidence issue exists, say that clearly and mention the checked scope.
