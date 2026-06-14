# Protocol Decoder Review Target

This is a curated local benchmark workspace for DStudio GSA. It is written as a source review target, not as a puzzle. The code and artifacts describe a realistic firmware record verification service used by the vault team.

## Repository map
- `src/`: implementation code in C.
- `config/`: runtime, policy, and deployment assumptions.
- `tests/`: behavioral tests and local sample data.
- `artifacts/`: logs, inventories, traces, or extracted records from the engagement.
- `docs/`: architecture and operating notes.
- `scripts/`: empty workspace for Python scripts created during analysis.
- `reports/`: empty workspace for the final report.

## Review constraints
Only inspect local files. Do not call external services or security tools. If computation helps, create a small Python script under `scripts/` and explain what it checks. A correct report may identify a security issue, conclude no reportable issue, or state that the evidence is insufficient.

Case profile: rev-3-5996956a34
