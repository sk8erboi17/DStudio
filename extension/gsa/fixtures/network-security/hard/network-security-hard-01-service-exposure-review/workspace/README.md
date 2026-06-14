# Network Security: Service exposure review

## Engagement brief
You are working inside an authorized local assessment workspace for Metro-01.

Category: Network Security
Difficulty: hard
Case ID: network-security-hard-01-service-exposure-review

## Objective
Handle noisy internal ranges, stale inventory, and decoy flows; prioritize confirmed risk.

## Rules of engagement
- Work only with files in this workspace.
- Do not contact external hosts, public services, or third-party infrastructure.
- Do not run external scanners, recon utilities, exploit frameworks, or platform-specific security tools.
- If computation is needed, create small Python scripts under `scripts/` using the Python standard library.
- Save intermediate notes and final output under `reports/`.
- If the evidence is incomplete, say exactly what is missing and do not invent a conclusion.
- Do not assume a reportable finding exists. Some targets are correctly implemented or lack enough evidence.

## Scope notes
Multiple layers and noisy telemetry. Some records are decoys.

## Source focus
This is a source-first review target. Start with `PROJECT.md`, then inspect `src/`, `config/`, `tests/`, and the supporting files in `artifacts/`.

The operational theme is service inventory and flows.

## Requested output
- Short executive summary.
- Evidence table with file paths and relevant code or records.
- Security assessment with confidence.
- Python scripts created, if any, and why they were needed.
- Recommended next evidence to collect if the case cannot be closed.
