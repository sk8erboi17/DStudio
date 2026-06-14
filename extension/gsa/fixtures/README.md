# GSA curated benchmark workspaces

This tree contains the active 16-case local, source-first benchmark suite for DStudio GSA.

The suite is balanced for an 8-hour run target on the current local DS4 setup:
- 8 categories, 2 workspaces per category.
- 4 difficulties, 4 workspaces per difficulty overall.
- Answer keys remain outside the workspaces under `extension/gsa/answer-key/`.

Open only a leaf `workspace/` directory in DStudio/GSA, for example:

`extension/gsa/fixtures/web/hard/web-hard-01-api-access-boundary/workspace`

Do not point GSA at `gsa/`, `extension/gsa/fixtures/`, or `extension/gsa/answer-key/`.

The workspaces contain production-style source trees, configs, tests, local artifacts, and curation docs. They do not contain scoring keys. Some targets contain a reportable implementation issue, some are clean, and some intentionally lack enough evidence to close the case.

Rules for GSA runs:
- use only local files;
- do not call external scanners or recon tools;
- create Python helper scripts under `scripts/` only when useful;
- write the final report under `reports/` or export it to the benchmark reports directory.
