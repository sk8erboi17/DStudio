# Padded Q2_K Qwen3.8 speed measurements

This report records the first optimization round. See the
[second round](qwen38-q2-round2.md) for subsequent geometry and tail-tile
changes and their incremental measurements.

Model: `Qwen3.8-Flash-Next-IQ2XXSImatrix-Q2KDownPad768-MTP.gguf`
(44,806,612,192 bytes), with the existing Q4_1 PLE sidecar. The main
experts use IQ2_XXS gate/up and Q2_K down weights; the down row stores 768
values while consuming only 640 live activations.

Machine: Apple M3 Ultra, 512 GiB unified memory. Baseline: commit
`5bd8796`, with its executable and runtime-loaded `metal/qwen4.metal`
saved before editing. Both implementations use the same model and PLE.

## Changes

- Specialize expert decode by quantization, shared-expert quantization,
  logical input width, and rows per SIMD group. On M3 Ultra, IQ2_XXS and
  Q2_K default to one row per SIMD group and eight groups per threadgroup.
- Use 8-token expert GEMM tiles for batches through 512 tokens, 16-token
  tiles through 1024, and the existing 32-token tiles above that. The
  smaller tiles reduce unused matrix products for sparsely populated
  experts. Defaults change only for IQ2_XXS/Q2_K on M3 Ultra.
- Keep quantized weights, logical activation strides, padded weight
  strides, and per-output accumulation order unchanged.

The exploratory sweeps rejected larger K tiles, different row tile sizes,
and explicit paired IQ2 unpacking because they did not provide a useful
end-to-end gain. At about 2K tokens the smaller token tiles stopped helping;
at about 4K they were slower. The production threshold therefore ends at 1K.

## Validation and reproduction

`make test-qwen4-q2` compares decode specialization against the generic
kernel and checks all three prefill tile widths against the original
32-token path. Cases include nonzero padding, the physical 768/logical 640
Q2 layout, alternate expert formats, empty and hot experts, partial tiles,
scatter output, and untouched spare output slots.

`speed-bench/qwen38_q2_parity.py` compares full teacher-forced logits for
prompt sizes 1, 2, 8, 9, 39, and 128, with 32 output vectors per case. It
also accepts repeated `--prompt-file` arguments for full next-token logit
checks after longer prefills. All 192 teacher-forced vectors and both
long-prompt vectors (1022 and 7952 tokens) were finite and identical to
the saved baseline.

`speed-bench/qwen38_mtp_compare.py` interleaves baseline and candidate
runs, excludes warmups, records exact binary/source hashes, and checks
generated output hashes. Omit `--no-mtp` to also verify MTP output and
draft-acceptance parity. It reports prefill separately from generation;
model loading is excluded from the decode rate. The three built-in
cases cover a summary, a Fibonacci sequence, and a prose explanation.

For comparisons against generic behavior in the current binary, set
`DS4_QWEN4_MOE_MV_SPECIALIZE=0`, `DS4_QWEN4_MOE_MID_NT=4`, and
`DS4_QWEN4_MOE_DOWN_NT=4`. The saved pre-change executable/source pair is
the baseline for the final measurements, rather than relying only on
these overrides.

The full-logit checks establish implementation parity for this model;
they do not compare its quantization quality with BF16. The hardware
defaults are specific to the measured M3 Ultra.

## Ordinary decode results

Three measured repetitions per implementation and case, after warmups.
All generated outputs matched. Rates are tokens per second.

| Case | Baseline prefill | New prefill | Baseline decode | New decode | Decode gain |
|---|---:|---:|---:|---:|---:|
| hamlet | 145.34 | 180.25 | 51.48 | 53.14 | 3.2% |
| fibonacci | 139.15 | 172.22 | 51.47 | 53.20 | 3.4% |
| explanation | 182.57 | 232.49 | 51.62 | 53.25 | 3.2% |

## MTP decode results

Three measured repetitions per implementation and case, after warmups.
All generated outputs and acceptance counts matched.

| Case | Baseline decode | New decode | Gain | Accepted drafts / cycles |
|---|---:|---:|---:|---:|
| hamlet | 61.31 | 63.88 | 4.2% | 44 / 71 |
| fibonacci | 75.47 | 78.62 | 4.2% | 197 / 201 |
| explanation | 65.11 | 67.70 | 4.0% | 106 / 148 |

## Longer prompt results

These timing runs use raw prompts; the full-logit checks above use their
chat-rendered versions. Three measured repetitions per implementation,
with 64 generated tokens. Outputs matched in every repetition.

| Raw prompt tokens | Baseline prefill | New prefill | Prefill gain | Baseline decode | New decode |
|---:|---:|---:|---:|---:|---:|
| 1000 | 1033.43 | 1077.98 | +4.31% | 51.53 | 53.05 |
| 7930 | 1247.53 | 1247.35 | -0.01% | 48.02 | 49.52 |

The 8K prefill difference is effectively zero; this path retains the original
32-token tile. Decode gains persist after the longer prompt.

[Complete records and provenance](qwen38-q2-speed-results.json) contain the
individual samples, output hashes, binary and Metal source hashes, full-logit
results, commands, and the recipe for both longer prompts.

Final validation passed both `make test-qwen4-q2` and the full
`make test-qwen4-kernels` suite. The expanded Q2 test readback allocation
uses the larger of intermediate and output sizes; its 640-wide intermediate
exceeds the synthetic 260-wide output.
