# Web Review Map

Primary route: `src/routes/ssrf_boundary_review.ts`.
Policy helper: `src/policies/accessPolicy.ts`.
Data model: `src/data/records.ts`.

Correlate route-level data access with the policy helper and sample HTTP records. Do not assume middleware covers object ownership unless the call path proves it.
