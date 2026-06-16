GSA Phase 4/4: report.
Workspace root: `{{WORKDIR}}`.
Use the inline artifacts below from `{{RUN_DIR}}/validation.json`, `{{RUN_DIR}}/validation-results.json`, `{{RUN_DIR}}/evidence-graph.json`, `{{RUN_DIR}}/evidence.jsonl`, `{{RUN_DIR}}/scripts_manifest.json` and `{{RUN_DIR}}/tool-retry-ledger.jsonl`.
Protocol hygiene: do not read or cite `.dstudio/gsa/runs/*.prompt.md`; prompt files are control data, not report evidence.
Do not call `read`, `write`, `edit`, `run`, or `skill` in this report phase unless an inline artifact is missing or corrupt.
{{BLACKHAT_VOICE_RULE}}

Write a concise security report with concrete file:line evidence, exploit path, impact, and fix. Derive the report verdict from validation.json instead of re-litigating the case.
If validation.json contains any validated security finding with non-empty exploit_path, non-empty impact, confidence `medium` or `high`, and no decisive missing chain link, the report verdict is `confirmed_issue`.
If missing_evidence says the caller, route, parser, trace, dataset, downstream consumer, dispatch link, or attacker-controlled input is absent/unverified, that is decisive and the verdict must be `inconclusive` unless another finding has a complete chain or validation explicitly accepted an exported/default primitive as a bounded code-level finding.
For authorized local source reviews, if validation accepted an exported cryptographic/token/signature/parser/serializer/policy primitive as the reviewed boundary, missing HTTP/controller/service wiring remains a limitation inside the finding and must not flip the verdict.
If validation includes an `attack_chain`, report the chain as ordered links. If validation used external-tool output, describe it as supporting or negative evidence only. If validation used a fallback after a selected external tool failed, cite the relevant `tool-retry-ledger.jsonl` entry.
If validation.json shows reviewed controls are present and no exploit path exists, use `no_issue`. If validation did not validate a security finding, or every finding is blocked by decisive missing/contradictory evidence, use `inconclusive`.

Start with `## Verdict: confirmed_issue`, `## Verdict: no_issue`, or `## Verdict: inconclusive`.
Keep the report under 900 words. Output Markdown only, no preamble, no code fences. After emitting the Markdown report, stop immediately; do not start another run or phase.
