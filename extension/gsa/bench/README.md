# GSA Benchmark

This directory contains local-only benchmark tooling for the curated GSA fixture set.

The active benchmark is the 8-hour balanced suite:

- 16 local-only workspaces total.
- 8 categories, 2 workspaces per category.
- 4 difficulties, 4 workspaces per difficulty overall.
- Target runtime: under 8 hours on the current local DeepSeek V4 setup, based on the measured ~21 minute smoke case.

Run a case by opening only the leaf `workspace/` folder in DStudio/GSA, then save the final report as:

`extension/gsa/artifacts/<run-id>/<case-id>.md`

Automated real GSA run, saved under `extension/gsa/benchmark/` with one folder per analyzed project:

```sh
node extension/gsa/bench/run.mjs --limit 1
node extension/gsa/bench/run.mjs --ctx 65536 --think normal --timeout-min 15 --out extension/gsa/benchmark/gsa-balanced-8h
```

Each project folder contains the copied workspace, raw phase output, parsed phase JSON, GSA artifacts and `report.md`.

Score a run:

```sh
node extension/gsa/bench/score.mjs --reports extension/gsa/benchmark/gsa-balanced-8h --out extension/gsa/benchmark/gsa-balanced-8h
```

Validate the benchmark dataset:

```sh
node extension/gsa/bench/validate.mjs
```

The answer keys under `extension/gsa/answer-key/` are scoring material. Never include that directory in a GSA workspace.
