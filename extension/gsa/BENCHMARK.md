# DStudio GSA Benchmark

**Status: partial run. Do not publish this as the full benchmark until all 16 reports are present.**

## Methodology

- Dataset: 16 local-only workspaces balanced for an 8-hour run target: 2 per category and 4 per difficulty overall.
- Categories: crypto, web, reverse engineering, forensics, OSINT, network security, malware analysis and pwn.
- Each case is copied into `extension/gsa/benchmark/<run>/<project>/workspace` before GSA starts.
- Answer keys are not copied into the workspace and are not sent to the model.
- Calibration policy: no answer-key hints, no benchmark-specific prompts, and no prompts that reveal whether a case contains a vulnerability.
- Tool policy: external tools are advisory only; scanner success/failure must be cross-checked with source, artifacts, manual reasoning, or targeted Python helpers.
- Chain policy: reports may confirm an attack chain only when each link has cited evidence; weak standalone facts are not upgraded without a concrete composed path.
- GSA uses the vendored `extension/gsa/third_party/anthropic-cybersecurity-skills` catalog and records `skills.md` plus actual `skill()` tool calls per case.
- Scoring runs after report generation and measures outcome, evidence citation and false positives/false negatives.

## Run

- Run directory: `extension/gsa/benchmark/gsa-re-malware-loop-20260615-90112-64k-nosssd`
- Selected cases this invocation: 2
- Completed reports: 0
- Failed runs: 2
- Agent ctx: 65536
- Thinking: max
- GGUF: gguf/cyberneurova-DeepSeek-V4-Flash-abliterated-IQ2XXS-w2Q2K-AProjQ8-SExpQ8-OutQ8-chat-v2-imatrix-aligned.gguf

## Skill Routing

- Cases with at least one actual `skill()` call: 0/2

| Skill | Cases |
|---|---:|
| (none recorded) | 0 |

## Reproduce

```sh
node extension/gsa/bench/validate.mjs
node extension/gsa/bench/run.mjs --out extension/gsa/benchmark/gsa-re-malware-loop-20260615-90112-64k-nosssd
node extension/gsa/bench/score.mjs --reports extension/gsa/benchmark/gsa-re-malware-loop-20260615-90112-64k-nosssd --out extension/gsa/benchmark/gsa-re-malware-loop-20260615-90112-64k-nosssd
```

Detailed per-case artifacts are in each project folder: `manifest.json`, `skills.md` under `gsa/`, raw phase output, parsed phase JSON and `report.md`.

## Failed Runs

- malware-analysis-easy-01-powershell-triage: agent turn stalled during selection; no transcript progress for 93s; last poll: {"base":0,"len":59586,"working":true,"ready":true,"loadPct":100,"text":""}
- reverse-engineering-easy-03-protocol-decoder: agent turn stalled during selection; no transcript progress for 92s; last poll: {"base":0,"len":56017,"working":true,"ready":true,"loadPct":100,"text":""}
