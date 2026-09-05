# ds4 main update — September 5, 2026

Main is updated from `b0a147a7fba6d1a104d047d5a140e9bb4bfc13cd` to
[`f4d03f6cf9f11c1e7b630bcb160853acfba7c52a`](https://github.com/antirez/ds4/commit/f4d03f6cf9f11c1e7b630bcb160853acfba7c52a),
the latest upstream main revision checked for this update. The first-run
installer is pinned to this exact revision too. Model files, model choices and
the separate Laguna/Qwen branches are unchanged.

## What changed

[Upstream changes](https://github.com/antirez/ds4/compare/b0a147a7fba6d1a104d047d5a140e9bb4bfc13cd...f4d03f6cf9f11c1e7b630bcb160853acfba7c52a).

- GLM attention masking/reductions and the 2051-token dense boundary are corrected.
- Session rollback, tensor-parallel restore and GLM memory accounting are corrected.
- Metal scratch sizing is corrected. Several other optimizations target M5 or
  multiple Macs; they are not automatic speedup claims for this M2 Max.
- Upstream adds independent attention and session-state regression checks.

DStudio's existing runtime patches are retained. The M2 patch now adapts its
build rules to current main, without duplicating its runtime implementation or
undoing upstream's test-linkage fixes. Its complete apply/restore remains atomic;
older supported source layouts keep their original build rules.

The Agent patch accepts the new upstream generation loop and preserves its
post-rewind context resynchronization. PLD snapshot restoration runs first;
replay failures propagate instead of silently continuing with invalid state.
Chat, Agent, Cowork and Design were rebuilt against the new runtime.

## Reproducible real-model comparison

Hardware: Apple M2 Max, 96 GiB. The test opens actual local weights and uses the
native HTTP engine. It does not use simulated model responses.

| Model | File | Memory mode |
| --- | --- | --- |
| DeepSeek V4 Flash | Chat IQ2XXS, 86.7 GB | Resident, expert SSD streaming off |
| GLM 5.3 Flash | Q2, 96.5 GB | SSD streaming, 32 GiB cache target |

Both revisions use 8192 allocated context, greedy sampling, the same seed and
the same prompts. No PLD, DSpark/MTP or disk KV cache is enabled. DeepSeek uses
a 512-token prefill chunk; GLM selects its own chunk, as required by its engine.

There are three distinct measured workloads (32-line CSV copy, numeric sorting,
16-record JSON extraction), each repeated three times, after three auxiliary
correctness/warmup questions. Exact values and requested formatting are checked.
Failures remain failures; speed for a workload is qualified only when all
three of its answers pass. Auxiliary errors still fail the overall suite.

Decode comes from native `usage.ds4` timing, excluding loading and prompt
prefill. Prefill comes from the native log's actual processed token span and
elapsed time, not HTTP round-trip time or total prompt length after prefix reuse.
These are short prompts, not peak long-context prefill measurements.

```sh
node tests/live/main_decode_comparison.mjs before OLD_ENGINE OLD_COMMIT ds4-ram NEW_OUTPUT_DIR
node tests/live/main_decode_comparison.mjs after ds4 NEW_COMMIT ds4-ram ANOTHER_NEW_OUTPUT_DIR
# Repeat sequentially with glm-ssd. Never run two models together.
make test-main-decode-metrics test-agent-pld test-glm53-m2max-patch
node tests/live/engine_acceptance.mjs --setup --engines main
```

Raw requests, responses, failures, binary/shader hashes, model identity and
memory snapshots are retained under ignored `tests/.artifacts/`. Existing
desktop applications are not closed; the tests do not change OS wired limits.
The before runs overlap some CPU compilation; the after runs do not. Neither
desktop workload nor storage/thermal history was controlled. Small differences
must not be presented as proof of an engine speedup or regression.

The earlier all-model headless report remains historical evidence for its
original revision, not a claim that every model was retested after this update.

## Measured results

No clear speedup on this M2 Max. DeepSeek's decode changes range from −1.66%
to +2.21% across the three workloads; GLM's range from −4.08% to −1.11%.
These are observed timings, not causal attribution to upstream changes.

![Before and after: short-prompt prefill and response generation, with observed ranges. No clear speed gain; measured answers pass but auxiliary failures remain.](../assets/README%20images/benchmarks/main-update-prefill-decode.png)

The Matplotlib chart is generated from the [public JSON](benchmarks/main-update-2026-09-05.json).
Run `python3 tests/support/publish_benchmark_charts.py` from the repository root
to reproduce the published charts without loading a model.

Median tokens/second over three repetitions:

| Model / workload | Prefill before → after | Decode before → after |
| --- | ---: | ---: |
| DeepSeek RAM / CSV copy | 126.52 → 123.72 | 21.50 → 21.15 |
| DeepSeek RAM / numeric sorting | 69.79 → 71.15 | 20.90 → 21.36 |
| DeepSeek RAM / record extraction | 113.21 → 112.63 | 20.95 → 21.18 |
| GLM SSD / CSV copy | 7.60 → 7.24 | 8.71 → 8.57 |
| GLM SSD / numeric sorting | 2.68 → 2.56 | 5.29 → 5.07 |
| GLM SSD / record extraction | 6.70 → 6.51 | 8.16 → 8.07 |

The CSV prompt has 218 tokens for DeepSeek and 220 for GLM. GLM spends roughly
29–31 seconds preparing that prompt from SSD; this dominates its short-prompt
prefill rate. These numbers must not be quoted as maximum long-prompt throughput.
CSV decode ranges overlap: DeepSeek 20.74–21.64 before versus 21.09–21.28 after;
GLM 7.35–9.02 before versus 7.79–8.84 after.

**Correctness: 36/36 measured answers pass**, and outputs are byte-identical
before/after for both models. But the auxiliary Python question fails in both
versions: DeepSeek returns `:16` instead of the requested bare integer, while
GLM starts with `32`, explains a correction to `16`, and violates the requested
format. All four live invocations correctly exit nonzero for this failure.
The overall count is 44/48 passing requests; this is not a fully passing
capability suite or proof of general model quality.

[Machine-readable results, ranges and failures](benchmarks/main-update-2026-09-05.json).
Raw evidence: `tests/.artifacts/ds4-main-update-4XujZJ/` (ignored), with original
before/after receipts and a separately derived `comparison/REPORT.md`.
The rejected initial GLM launch using a custom prefill chunk is retained too;
the corrected comparison lets GLM choose its graph chunk in both revisions.

## Executed compatibility checks

| Check | Result | Scope |
| --- | --- | --- |
| Empty-directory network install of pinned main | Passed, 43.8 s | Real archive download, patches, builds and executable startup; no weight download |
| Complete runtime patch stack on a clean main copy | Passed | Apply/reverse and exact tracked-source restoration |
| M2 patch lifecycle on legacy and current layouts | Passed | Atomic rejection of drift/partial state, idempotence, legacy migration, preserved user edits |
| Native GLM attention and normalization | Passed | Actual Metal kernels against independent numerical references |
| Native streaming cache/index | Passed | Actual Metal Q2 paths and CPU oracle, 1152 cache installs/replacements |
| Native session state and TP command tests | Passed | Rewind/restore state and command handling; not a two-Mac inference run |
| Agent/Cowork/Chat PLD regressions | Passed, 27895 checks | Production loop/transaction with stateful doubles; includes resync ordering and error propagation, not model inference |
| Timing/report regressions | Passed | Processed spans, medians, failed/duplicate runs and identical model/request/runtime parameters |
| Rebuilt signed app smoke | Passed | Isolated bundle startup and HTTP behavior; user's app not restarted |

Fresh installation receipt:
`tests/.artifacts/engine-acceptance/run-cGIKO0/results.json` (ignored).
