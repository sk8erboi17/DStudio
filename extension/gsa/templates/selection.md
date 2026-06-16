GSA security analysis run {{RUN_ID}}.

Loop iteration:
{{ITERATION}}

Workspace root:
{{WORKDIR}}

Workspace artifact directory:
{{RUN_DIR}}

Run state artifact:
{{RUN_DIR}}/run_state.json

Parent run directory:
{{PARENT_RUN_DIR}}

Mission:
{{MISSION}}

Authorized target URL:
{{TARGET_URL}}

Authorized target host:
{{TARGET_HOST}}

Security profile requested/effective:
{{PROFILE_REQUESTED}} / {{PROFILE_EFFECTIVE}}

GSA execution mode:
{{TOOL_STATUS_SUMMARY}}

{{RUN_CONTEXT_RULE}}`{{RUN_DIR}}/toolStatus.json`, `{{RUN_DIR}}/tool-retry-policy.md`, `{{RUN_DIR}}/tool-retry-ledger.jsonl`, `{{RUN_DIR}}/workbench.json`, and `{{RUN_DIR}}/workbench.md`. This run is tool-assisted: you may use external tools only when toolStatus.json marks them enabled and found, plus small bounded Python helpers under `{{RUN_DIR}}/scripts/`.
{{SECURITY_RULE}}{{NETWORK_TOOL_RULE}}
External tools are optional, never required. If a tool is missing or disabled, say which command is unavailable and continue with source/artifact/Python evidence when possible. Read `tool-retry-policy.md`; it is the single source for same-tool retry, timeout retry, substitute/fallback and nuclei-template rules.
Evidence workbench rule: reusable observations from tools, browser captures, network artifacts, forensic timelines, reverse-engineering notes, code/SAST output, or infrastructure probes must be normalized into the matching `workbench-*.jsonl` file and linked from evidence or claims when used.
Tool oracle rule: scanner output is advisory evidence, not a verdict. A clean/empty result from sqlmap, nuclei, semgrep, trivy, yara, binwalk, tshark, nmap or similar cannot by itself prove `no_issue` or kill a hypothesis; cross-check manually against code, artifacts, configs, traces, and targeted Python helpers.
{{BLACKHAT_VOICE_RULE}}
Save command lines, stdout/stderr, exit status, and generated files in the run directory so failures are visible.

Required run artifacts:
- `{{RUN_DIR}}/run_state.json` is maintained by DStudio; read it when diagnosing lifecycle state.
{{SCOPE_ARTIFACT_RULE}}- `{{RUN_DIR}}/scripts_manifest.json` tracks local Python helpers. If you plan, write, run or fail a script, update that manifest with `path`, `purpose`, `inputs`, `outputs`, `status` and `error`.
- `{{RUN_DIR}}/tool-retry-policy.md` and `{{RUN_DIR}}/tool-retry-ledger.jsonl` govern all external-tool invocation failures.
- `{{RUN_DIR}}/workbench.json` and `{{RUN_DIR}}/workbench.md` define the Evidence Workbench. Use `workbench-web.jsonl`, `workbench-network.jsonl`, `workbench-forensics.jsonl`, `workbench-reverse.jsonl`, `workbench-code.jsonl`, `workbench-infra.jsonl`, `workbench-blue.jsonl`, `workbench-red.jsonl`, `workbench-purple.jsonl`, `workbench-blackhat.jsonl`, and `workbench-tool-runs.jsonl` for normalized artifacts.
- `{{RUN_DIR}}/evidence.jsonl` is append-only evidence. Add one JSON line per concrete evidence item with `finding`, `source`, `status`, and a short `excerpt`.
{{LOOP_CONTEXT_RULE}}
Protocol hygiene: never read, search, cite, or reason from `.dstudio/gsa/runs/*.prompt.md` files. Prompt files are DStudio control data, not project evidence.

Phase 1/4: selection.
This phase is scope selection only: do not validate findings, do not write a narrative report, and do not inspect every candidate. Read the required GSA artifacts, then at most 6 high-signal project files before producing the JSON. Select at most 6 files, 3 hypotheses, and 2 skills total; deeper evidence work belongs to later phases.
Read `{{RUN_DIR}}/target.md`, `{{RUN_DIR}}/candidates.txt`, `{{RUN_DIR}}/skills.md`, `{{RUN_DIR}}/toolStatus.json`, `{{RUN_DIR}}/scripts_manifest.json` and `{{RUN_DIR}}/evidence.jsonl`.
Every `files[].path` MUST be copied exactly from `{{RUN_DIR}}/candidates.txt`; do not invent conventional paths, rename directories, or include a file that is not present in that candidate list. Candidate paths are relative to the Workspace root above, not relative to the GSA run artifact directory.
Reply in chat only. Do not save the phase JSON yourself. Do not edit project files and do not call `write`, `edit`, `skill` or `pack_file` in this phase. If you call any of those tools in Phase 1, the phase is failed. Do not create scripts, update scripts_manifest.json, append evidence, run validation, or start Phase 2.
Use ONLY imported skill IDs listed in `skills.md`, all from `extension/gsa/third_party/anthropic-cybersecurity-skills`; never select general app-building or product-design skills for GSA. Do not call `skill()` in Phase 1.
For cryptographic or signature reviews, prioritize sign/verify/envelope/key-registry/policy/canonicalization files and explicitly distinguish safe controls from remaining key-binding, nonce/replay, and canonicalization gaps.

Verdict policy for later phases: a confirmed issue can be grounded in source code plus authoritative artifacts/config/tests/flows, even when the local workspace is a reduced review harness. Before `confirmed_issue`, validation must show all five links: defect/control gap, reachable input or data source, attacker capability, propagation/consumer or execution path, and concrete impact.
Local-source exception: for exported cryptographic, token, signature, serializer, parser, or policy primitives, caller-controlled function parameters plus tests/config/artifacts showing intended use can satisfy the reachable data-source link; missing service wiring belongs in `missing_evidence`, not automatic kill criteria. In `authorized-local-source-review`, the exported public API is the reviewed trust boundary.
Attack-chain policy: a reportable issue may be a chain of smaller weaknesses rather than one standalone bug. Later validation findings may include an `attack_chain` array with ordered evidence-backed links; use it only when each link is cited.

Candidate files discovered: {{CANDIDATE_COUNT}}{{TRUNCATED_NOTE}}.

Imported skill shortlist:
{{SKILL_LIST}}

When you are done reading, your final assistant text must be JSON only: no analysis prose, bullet lists, markdown, or code fences before or after the JSON.
Output JSON only with this shape:
{"phase":"selection","files":[{"path":"relative/path","reason":"why this file matters"}],"targetUrl":"authorized target url or empty","localScripts":[{"path":"scripts/name.py","purpose":"what it checks","status":"planned|written|ran|failed"}],"hypotheses":[{"title":"concrete risk","why":"reachable code path","skills":["skill-id"]}],"stop_if":"what would make this audit not worth continuing"}
After emitting that single JSON object, stop immediately and wait for DStudio to send Phase 2.
