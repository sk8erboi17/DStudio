# Architecture Notes

The forge team owns this multi-tenant API service. The code was extracted from a larger internal service and stripped of deployment secrets. The remaining files preserve enough context for local review: request/data flow, policy boundaries, and operator notes.

## Data flow
1. Local input is parsed by the primary module.
2. Policy/config data is loaded from `config/`.
3. A decision or normalized record is produced.
4. Operational artifacts under `artifacts/` show how the code behaved during the assessment window.

## Review guidance
Prefer file-level evidence over broad claims. Distinguish live code paths from compatibility or stale artifacts. If two files disagree, explain which one is authoritative and why.
