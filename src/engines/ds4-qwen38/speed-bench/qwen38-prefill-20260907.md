# Qwen prefill investigation — 2026-09-07

Hardware: Apple M3 Ultra, 512 GiB RAM. Base revision: `ffd85d4`.
Model: `qwen38-q4k-imatrix/Qwen3.8-Flash-Next-Q4KImatrix-MTP-qwen4exp-pleext.gguf`
with `Qwen3.8-Flash-Next-PLE-Q4_1.gguf`. Target-only inference, Metal,
resident weights, `speed-bench/promessi_sposi.txt`, default 8192-token chunks.

Implemented quantization-specialized routed MoE pipelines, enabled by default
on M3 Ultra. Final checks preserve every compared logit bit for bit:

| Workload | Generic tokens/s | Specialized tokens/s | Gain |
| --- | ---: | ---: | ---: |
| Q4K, warmed 2K prefix | 1139.05 | 1158.84 | 1.74% |
| Q4K, warmed 8K prefix | 1220.20 | 1240.71 | 1.68% |
| Q4K, 8K append after 8K prefix | 1204.41 | 1226.98 | 1.87% |
| IQ2/MXFP4, 8K prefix | 1210.35 | 1254.24 | 3.63% |

Each comparison uses eight alternating runs. All 36 focused kernel cases
pass. The implementation, rollback, and detailed measurements follow.

## Baseline and attribution

A fresh `ds4-bench --ctx-start 4096 --ctx-max 16384 --step-mul 2
--gen-tokens 1` sweep measured 1169.40, 1150.97, and 1196.34 prefill
tokens/s at the 4096, 8192, and 16384 frontiers. These are individual
observations, not a performance comparison. Raw CSV:
`/private/tmp/prefill-baseline-ffd85d4.csv`.

The current profiler needed two corrections before attribution: the attention
mixer had no boundary, so its time was included in GDN/attention and its own
bucket was always zero; four-call averaging also combined different chunk
sizes. `DS4_QWEN4_TIMING=2` now reports each chunk separately with its position
and a separate attention-mixer boundary.

A fresh 8192-token chunk, profiled with those corrections, measured:

| Stage | Milliseconds | Trunk share |
| --- | ---: | ---: |
| PLE | 47.7 | 0.7% |
| Attention mixer | 377.3 | 5.6% |
| GDN | 1904.8 | 28.4% |
| Attention | 1136.1 | 16.9% |
| FFN mixer/combine | 419.0 | 6.2% |
| MoE | 2824.5 | 42.1% |

These are synchronized wall times for stage groups, not GPU timestamp
measurements. They exclude host input staging and the final output projection.
The profiling synchronization changes performance; use ordinary runs for
throughput comparisons. MoE is the largest measured target.

## First scheduling experiment

The balanced prefill harness now supports PLE sidecars, explicit chunk size,
and numeric environment values. The first experiment compares default MoE
down tile count (32 at 8192 tokens on M3 Ultra) against 8, with the same
kernel arithmetic. It uses one warmed engine, fresh sessions, ABBA then BAAB,
and compares every final vocabulary logit bit for bit.

Reproduction, with `MODEL` and `PLE` pointing to the files above:

```sh
./speed-bench/metal_prefill_variant_bench -m "$MODEL" --ple "$PLE" \
  --prompt-file speed-bench/promessi_sposi.txt \
  --prefill-chunk 8192 --prefix-tokens 8192 \
  --candidate-env DS4_QWEN4_MOE_DOWN_TILES --candidate-value 8 --repeats 2
```

The named variable is read at each dispatch. The single-engine harness is
unsuitable for environment settings cached at initialization.

| Run | Variant | Seconds | Tokens/s |
| --- | --- | ---: | ---: |
| 1 | default | 6.833330 | 1198.8299 |
| 2 | 8 tiles | 6.729022 | 1217.4132 |
| 3 | 8 tiles | 6.730171 | 1217.2053 |
| 4 | default | 6.703376 | 1222.0708 |
| 5 | 8 tiles | 6.728016 | 1217.5952 |
| 6 | default | 6.700771 | 1222.5459 |
| 7 | default | 6.707376 | 1221.3420 |
| 8 | 8 tiles | 6.750661 | 1213.5108 |

Aggregate: default **1216.1135** vs 8 tiles **1216.4288** tokens/s
(**+0.0259%**). This is a tie, with opposite directions in the two balanced
blocks; it does not justify a default change. All eight full-vocabulary
outputs matched exactly: **1,986,560 floats**, vocabulary 248,320.

Both benchmark targets built without warnings, `git diff --check` passed, and
the full-model alternating run exercised the new PLE/value/chunk options.
This scheduling experiment did not change an inference default. The following
investigation split MoE time before choosing an internal kernel change.

## MoE attribution and rejected tail experiment

`DS4_QWEN4_MOE_PROFILE=1` now separates each layer's routing, expert lists,
routed gate/up, shared gate/up, routed down, shared down, and reduction.
It synchronizes stage boundaries and propagates command failures. On an 8K
chunk, typical layers measured approximately 2.65, 0.35, 31.1, 2.82, 19.3,
1.43, and 2.74 ms respectively. Thus routed gate/up and down dominate; routing
and list construction are not the primary targets. The first layer was
slower (33.45 ms gate/up, 26.72 ms down).

Tried skipping matrix operations and stores for fully unused 8-token columns
in each expert's final 32-token tile. A runtime branch slowed even the disabled
control to 1056.45 tokens/s, making its apparent +2.18% candidate gain
misleading. A function-constant specialization recovered the control to
1218.74 tokens/s but the skipping variant achieved only 1084.92 (-10.98%).
Both experiments compared 1,986,560 logit floats exactly across ABBA/BAAB.
The tail change was removed: saved arithmetic did not compensate for the
resulting compiled kernel cost.

## Quantization specialization

The next candidate specializes the routed gate/up and down Metal functions
with the bound expert weight type. The generic path retains runtime type
selection; the specialized path lets the compiler remove unused dequantizers.
K traversal, tile shape, operand precision, and output scatter are unchanged.
The pipeline cache key includes both kernel name and quantization type.

At an 8192-token fresh prefix, ABBA/BAAB measured **1218.6445 → 1242.9464
tokens/s (+1.9942%)**. All eight output rows matched exactly (1,986,560
floats). Per-run seconds in order:

| Pattern | Control | Candidate | Candidate | Control |
| --- | ---: | ---: | ---: | ---: |
| ABBA | 6.809345 | 6.585409 | 6.589433 | 6.688385 |

| Pattern | Candidate | Control | Control | Candidate |
| --- | ---: | ---: | ---: | ---: |
| BAAB | 6.588264 | 6.691175 | 6.699986 | 6.600058 |

Both balanced blocks favor specialization. This first measurement used
`DS4_QWEN4_MOE_MM_SPECIALIZE` unset for generic and `1` for specialized.

Continued prefill from 8192 to 16384 tokens, timing only the appended 8192:
**1204.4066 → 1226.9750 tokens/s (+1.8738%)**, again with all 1,986,560
compared logits exact. Each run used a fresh session with an untimed 8K
prefix under the same variant as its append. Seconds in order:

| Pattern | Control | Candidate | Candidate | Control |
| --- | ---: | ---: | ---: | ---: |
| ABBA | 6.865366 | 6.675795 | 6.673837 | 6.778472 |

| Pattern | Candidate | Control | Control | Candidate |
| --- | ---: | ---: | ---: | ---: |
| BAAB | 6.677738 | 6.776304 | 6.786616 | 6.678960 |

`make test-qwen4-moe-mm-specialize` covers six formats (Q4_K, IQ2_XXS,
Q2_K, Q8_0, MXFP4, Q4_0) at 9, 31, 32, 33, 65, and 257 tokens. All 36
cases passed. Each compares generic/specialized/generic gate-up and down
outputs bit for bit, checks live values for finiteness, preserves poisoned
padding slots, and alternates formats in one process to exercise cache keys.
The routes include a hot expert, empty expert, irregular tails, noncontiguous
token/slot scatter, and a 260-wide down output that ends inside a row tile.

The second full model,
`qwen38-iq2-imatrix/Qwen3.8-Flash-Next-IQ2XXSImatrix-MXFP4Down-MTP.gguf`,
uses IQ2_XXS gate/up and MXFP4 down, with the same PLE sidecar and prompt.
At a fresh 8K prefix it improved **1210.3511 → 1254.2368 tokens/s
(+3.6259%)**. All eight rows (1,986,560 floats) were exact. Seconds:

| Pattern | Control | Candidate | Candidate | Control |
| --- | ---: | ---: | ---: | ---: |
| ABBA | 6.772998 | 6.524021 | 6.526935 | 6.760346 |

| Pattern | Candidate | Control | Control | Candidate |
| --- | ---: | ---: | ---: | ---: |
| BAAB | 6.528355 | 6.762848 | 6.776944 | 6.546536 |

## Final default and validation

Specialization is now the default on M3 Ultra. Other devices retain generic
kernels until measured; `DS4_QWEN4_MOE_MM_SPECIALIZE=1` opts in, and `=0`
restores generic kernels on any device. Cache entries live in the common
pipeline cache, keyed by kernel name and weight type and released at cleanup.
The default change affects the tiled prefill dispatches, not decode kernels.

The CLI, server, benchmark, and focused test build without warnings. All 36
kernel cases passed again after the final default/cache changes, using explicit
`0/1/0` settings to exercise both paths independently of the machine default.

A fully warmed 2048-token Q4K prompt on the final default measured
**1139.0467 generic → 1158.8446 specialized tokens/s (+1.74%)**. Both
variants warmed the full 2048 tokens before measurement; all eight logit rows
were exact. The harness now labels the optimized default `control` and the
`--candidate-value 0` rollback `candidate`. Seconds:

| Pattern | Default | Rollback | Rollback | Default |
| --- | ---: | ---: | ---: | ---: |
| ABBA | 1.768317 | 1.793528 | 1.793909 | 1.769742 |

| Pattern | Rollback | Default | Default | Rollback |
| --- | ---: | ---: | ---: | ---: |
| BAAB | 1.803150 | 1.771803 | 1.759248 | 1.801392 |

For final-default checks, reproduce with:

```sh
./speed-bench/metal_prefill_variant_bench -m "$MODEL" --ple "$PLE" \
  --prompt-file speed-bench/promessi_sposi.txt --prefill-chunk 8192 \
  --prefix-tokens 2048 --warmup-tokens 2048 \
  --candidate-env DS4_QWEN4_MOE_MM_SPECIALIZE --candidate-value 0 --repeats 2
```

Use 8192 for both lengths to check a fully warmed 8K prefix. The measured
improvements concern these resident M3 Ultra workloads; other GPU hardware
and streaming were not measured.

The final fully warmed 8K rollback comparison measured **1220.2044 generic
→ 1240.7096 specialized tokens/s (+1.68%)**. Both variants warmed a complete
8K prefix before timing. All eight output rows (1,986,560 floats) were exact;
both balanced blocks favor the default. Seconds:

| Pattern | Default | Rollback | Rollback | Default |
| --- | ---: | ---: | ---: | ---: |
| ABBA | 6.598664 | 6.703670 | 6.730454 | 6.603292 |

| Pattern | Rollback | Default | Default | Rollback |
| --- | ---: | ---: | ---: | ---: |
| BAAB | 6.714979 | 6.601075 | 6.607662 | 6.705415 |

The two final-default benchmarks validate the implicit M3 Ultra default and
explicit rollback after the cache and boolean-control changes. No rejected
tail-skipping code remains. Final `git diff --check` passes.
