# Qwen3.8 padded Q2_K down experiment

The candidate saves **5.16 GiB (11%)** with essentially unchanged inference
speed on MacStudioIvan (M3 Ultra, 512 GiB RAM). It shows modest additional
probability drift and one fewer completed correct answer in the capped smoke
suite. It remains an experimental alternative to the IQ2_XXS/MXFP4 model.

## Artifact

- Original main GGUF: **50,343,093,376 bytes / 46.89 GiB**.
- Candidate main GGUF: **44,806,612,192 bytes / 41.73 GiB**.
- Saved: **5,536,481,184 bytes** (metadata adds 96 bytes).
- Only the 48 trunk expert down tensors changed, from MXFP4 to calibrated
  Q2_K. All 1,207 other tensor payload hashes match the original manifest.
- Quantization uses original BF16 weights and the pinned Unsloth imatrix.
  Eight zero-count down entries use the existing per-expert weight-energy
  fallback. Gate/up IQ2_XXS weights and the complete MTP block are unchanged.
- Down rows store 768 physical columns for 640 logical activations: three
  84-byte Q2_K blocks replace twenty 17-byte MXFP4 blocks per row.
- The required external Q4_1 PLE sidecar is unchanged and excluded from these
  sizes. These tests do not establish a fit on a physical 64 GB machine.

Candidate SHA-256:
`341c8d79468384a05e22998ae834a489145f6c385e276dcf79170a6b0d0ffd2d`.

## Quality

On 99 saved BF16-reference continuations (2,376 tokens), using identical
prompt/target token IDs and the same executable for both models:

- BF16 top-token agreement: **91.33% → 90.32%** (down 1.01 percentage points).
- Target NLL: **0.290735 → 0.303570** (up 4.4%; lower is better).
- Target logprob MAE: **0.161377 → 0.177123**.
- First-token matches: **69/99 → 65/99**.
- Per-case NLL favors the original on 66 cases and the candidate on 33.

The fixture's original tokenizer encodes prompt segments and continuations
directly into the production Metal teacher-forcing path. Case 088 is excluded
because token boundaries do not round-trip to the saved reference bytes.
This differs from the earlier 85-case scoring pipeline; compare models within
this experiment. Short continuations do not establish reasoning equivalence.

The 12-question `hard-smoke` suite uses 32K context, 1,024-token prefill chunks,
temperature 0, seed 123, a 2,048-token generation cap, and the standard
thinking-close controller. No retries or MTP:

- Original: **6 passed, 0 wrong, 6 incomplete**.
- Candidate: **5 passed, 0 wrong, 7 incomplete**.
- MMLU-Pro case 6500 changes from passed to incomplete; other statuses match.
  Incomplete means no gradeable final answer, not necessarily an exhausted
  budget. The candidate's final security case ended before the cap.

## Speed

Two sequential passes in opposite model order, identical raw prompt tokens,
128 teacher-forced decode tokens per frontier, 33,025 allocated positions,
and 1,024-token prefill chunks. Arithmetic means:

- **4K:** decode **47.63 → 47.31 tok/s**; prefill **962.72 → 973.17 tok/s**.
- **32K:** decode **47.09 → 46.94 tok/s**; prefill **926.06 → 935.95 tok/s**.

The 32K prefill measurement processes the additional 28,672 tokens after 4K.
Decode differences are under 1% and comparable to run variation. The generic
CSV `kvcache_bytes=0` at 32K is not a total-memory measurement.

A separate short-prompt, 128-token greedy smoke test produced identical text
with MTP enabled and disabled. Generation measured 73.89 versus 50.97 tok/s
respectively in that single pair; this is not a general MTP speed benchmark.

## Verification and use

All 1,255 output tensor payloads were read back and hash-verified. Physical
down dimensions and the unchanged MTP layout were independently checked.
The complete Qwen Metal kernel suite passes, including padded Q2_K decode,
tiled prefill, shared experts, deliberately nonzero padding, an aligned Q2_K
control, and rejection of invalid activation widths. All 35 pack tests pass.
The candidate's one-token CPU/GPU comparison agrees on top-1, with maximum
logit difference 0.00147057. The final rebuilt binary also reproduces the
candidate's greedy smoke output.

Use the rebuilt executable from this checkout; older builds reject the padded
layout. The original model and default model selection were preserved.

```sh
./ds4 --metal \
  -m "$HOME/models/qwen38-q2down-experiment/Qwen3.8-Flash-Next-IQ2XXSImatrix-Q2KDownPad768-MTP.gguf" \
  --ple "$HOME/models/qwen38-q4k-imatrix/Qwen3.8-Flash-Next-PLE-Q4_1.gguf" \
  --ctx 32768 --prefill-chunk 1024
```

Add `--mtp` for speculation. See [build instructions](../gguf-tools/README.md#experimental-padded-q2_k-down-projections)
and [machine-readable results](qwen38-q2down-results.json). Raw logits, traces,
commands and measured binaries are under the ignored `OUT/qwen38-q2down/`.
