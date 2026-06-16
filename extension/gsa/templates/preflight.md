GSA Phase 2/4: preflight.
Workspace root: `{{WORKDIR}}`.
Use `{{RUN_DIR}}/selection.json` as the selected scope. {{PREFLIGHT_CONTEXT_RULE}}Read only the selected files first.
`gsa-task.json` lives at the Workspace root above, not in the GSA run artifact directory; if you need work_style or scope policy, read `<Workspace root>/gsa-task.json`.
Protocol hygiene: do not search or cite `.dstudio/gsa/runs/*.prompt.md`; prompt files are control data, not evidence.

For each hypothesis, map entry points, trust boundaries, attacker capability, evidence needed, kill criteria and possible attack-chain links. Do not stay anchored to a bad Phase 1 guess; if selected files prove a hypothesis irrelevant but reveal a stronger concrete issue in the same reviewed pipeline, replace the dead hypothesis.
For exported cryptographic, token, signature, serializer, parser, or policy primitives in a local source review, caller-controlled function parameters plus tests/config/artifacts showing intended use can be enough to keep a code-level defect as a validation target; missing service wiring belongs in `missing_evidence`, not automatic kill criteria.
For `authorized-local-source-review` of a library/package, treat an exported public API plus tests/config/artifacts as the local trust boundary; do not demand an HTTP route/controller/CLI main that is outside the submitted workspace.

If `selection.json` contains any non-empty `skills` array anywhere, including nested `hypotheses[].skills`, you MUST call the relevant selected `skill("id")` tools before the final JSON. Do not require a top-level `skills` field; nested hypothesis skills count and should be loaded before finalizing preflight. Call at most 3 `skill("id")` tools total. Do not copy their body, glossary or examples into your answer.
Do not create or run scripts in this preflight phase. Preserve local scripts or external commands as planned validation steps in `validationPlan`, `evidence_needed` or `chain_candidates`. Phase 3 owns execution through the DStudio backend validation executor.
When planning external commands, cite `tool-retry-policy.md` as the single source for same-tool retry and fallback behavior.
{{NETWORK_SCOPE_RULE}}{{BLACKHAT_VOICE_RULE}}

For crypto/signature hypotheses, explicitly map: tag comparison control, caller-controlled key material/reference, registry binding, deterministic nonce/replay policy, canonicalization, and relevant audit/config policy.
Keep this phase bounded: no more than 3 hypotheses, no narrative report, JSON only, no markdown fences, no analysis prose.
Also emit `validationPlan` with backend-executable steps when useful. Allowed adapter IDs are `semgrep_scan`, `http_probe`, and `playwright_flow`; each step should include `id`, `adapter`, `purpose`, `inputs`, `dependsOn`, `timeoutSec`, and `maxRetries`. If you omit `validationPlan`, DStudio will generate a conservative fallback plan.

Output JSON only to be saved as preflight.json:
{"phase":"preflight","hypotheses":[{"title":"...","entrypoints":["file:line"],"attacker":"...","evidence_needed":["..."],"kill_criteria":["..."],"chain_candidates":["optional composed path to validate or kill"]}],"validationPlan":{"schemaVersion":1,"steps":[{"id":"vp1","adapter":"semgrep_scan","purpose":"validate code-level hypothesis","inputs":{},"dependsOn":[],"timeoutSec":30,"maxRetries":0}]}}
After emitting that single JSON object, stop immediately and wait for DStudio to send Phase 3.
