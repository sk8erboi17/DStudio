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

- Run directory: `extension/gsa/benchmark/gsa-fixcheck-local-source-report-20260614`
- Selected cases this invocation: 1
- Completed reports: 1
- Failed runs: 0
- Agent ctx: 65536
- Thinking: max
- GGUF: gguf/cyberneurova-DeepSeek-V4-Flash-abliterated-IQ2XXS-w2Q2K-AProjQ8-SExpQ8-OutQ8-chat-v2-imatrix-aligned.gguf

## Score

- Reports found by scorer: 1/1
- Average score: 1
- True positives: 1
- False negatives: 0
- True negatives: 0
- False positives: 0
- Correct inconclusive: 0

### By Category

| Category | Cases | Reports | Outcome Correct | Average Score |
|---|---:|---:|---:|---:|
| crypto | 1 | 1 | 1 | 1 |

### By Difficulty

| Difficulty | Cases | Reports | Outcome Correct | Average Score |
|---|---:|---:|---:|---:|
| easy | 1 | 1 | 1 | 1 |

## Skill Routing

- Cases with at least one actual `skill()` call: 1/1

| Skill | Cases |
|---|---:|
| exploiting-jwt-algorithm-confusion-attack | 1 |

## Reproduce

```sh
node extension/gsa/bench/validate.mjs
node extension/gsa/bench/run.mjs --out extension/gsa/benchmark/gsa-fixcheck-local-source-report-20260614
node extension/gsa/bench/score.mjs --reports extension/gsa/benchmark/gsa-fixcheck-local-source-report-20260614 --out extension/gsa/benchmark/gsa-fixcheck-local-source-report-20260614
```

Detailed per-case artifacts are in each project folder: `manifest.json`, `skills.md` under `gsa/`, raw phase output, parsed phase JSON and `report.md`.
