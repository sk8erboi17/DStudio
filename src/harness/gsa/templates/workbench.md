# Evidence Workbench

The workbench is a normalized evidence layer shared by GSA and RSA. Use it when tool output, browser captures, network artifacts, forensic timelines, reverse-engineering notes, code-analysis output, or infrastructure observations need to be preserved beyond prose.

Core rule: every row is evidence or tool-run metadata, not a final verdict. Cross-link important rows into `evidence.jsonl`, `claims.jsonl`, `validation.json`, or `STRUCTURE.MD` when they support a claim.

JSONL row shape:
{"id":"WB1","domain":"web|network|forensics|reverse|code|infra|blue|red|purple|blackhat","tool":"tool-name-or-manual","source":"url/file/request/pcap/binary/repo","status":"verified|inferred|unknown|failed","command":"optional command","artifactPath":"optional output path","summary":"short factual observation","confidence":"high|medium|low","scope":"authorized target or local file scope","claimRefs":["C1"]}

Domain files:
- `workbench-web.jsonl`: HAR requests, response headers, forms, endpoint extraction, DOM/runtime, cookies/storage, screenshots and browser traces.
- `workbench-network.jsonl`: PCAP flows, DNS/TLS/SNI, Zeek/TShark summaries, connection timelines and protocol observations.
- `workbench-forensics.jsonl`: timelines, hashes, metadata, YARA hits, memory/image artifacts and file-system observations.
- `workbench-reverse.jsonl`: binary metadata, imports, strings, symbols, functions, decompiler/disassembler/debugger observations.
- `workbench-code.jsonl`: Semgrep/SAST findings, dependency/SBOM results, source sinks/sources and build/test observations.
- `workbench-infra.jsonl`: DNS, CDN, certs, hosting, storage domains, headers, analytics and third-party service clues.
- `workbench-blue.jsonl`: controls, hardening, detection, logging, SIEM/Sigma/YARA mapping and defensive coverage.
- `workbench-red.jsonl`: authorized attack-surface, exploitability hypotheses and validation steps gated by `safety-gate.json` for red-authorized runs.
- `workbench-purple.jsonl`: mappings from red/black-hat hypotheses to blue controls, detection coverage and gaps.
- `workbench-blackhat.jsonl`: full-surface attacker-mindset analysis: abuse cases, likely attack paths, incentives, validation notes, blind spots and unknowns.
- `workbench-tool-runs.jsonl`: command lifecycle, status, output paths, failures, retries and fallback decisions.

Keep red-authorized network/web rows inside authorized scope. Do not use this workbench to justify destructive tests, credential theft, persistence, or data exfiltration. `black-hat` is an internal full-surface attacker-mindset mode and is not constrained by scope.json or safety-gate.json.
