# Crypto: JWT trust boundary review

## Engagement brief
You are working inside an authorized local assessment workspace for Keystone-01.

Category: Crypto
Difficulty: easy
Case ID: crypto-easy-01-jwt-boundary-review

## Objective
Review the provided cryptographic configuration and message samples for one concrete security issue.

## Rules of engagement
- Work only with files in this workspace.
- Do not contact external hosts, public services, or third-party infrastructure.
- Do not run external scanners, recon utilities, exploit frameworks, or platform-specific security tools.
- If computation is needed, create small Python scripts under `scripts/` using the Python standard library.
- Save intermediate notes and final output under `reports/`.
- If the evidence is incomplete, say exactly what is missing and do not invent a conclusion.
- Do not assume a reportable finding exists. Some targets are correctly implemented or lack enough evidence.

## Scope notes
Single system or component. The evidence pack is intentionally compact.

## Source focus
This is a source-first review target. Start with `PROJECT.md`, then inspect `src/`, `config/`, `tests/`, and the supporting files in `artifacts/`.

The operational theme is token issuer and verifier configuration.

## Requested output
- Short executive summary.
- Evidence table with file paths and relevant code or records.
- Security assessment with confidence.
- Python scripts created, if any, and why they were needed.
- Recommended next evidence to collect if the case cannot be closed.
