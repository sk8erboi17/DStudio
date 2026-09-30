# Padded Q2_K Qwen3.8: second optimization round

Measured on Apple M3 Ultra with 512 GiB unified memory, using the same
44,806,612,192-byte IQ2_XXS gate/up, padded Q2_K down model and Q4_1 PLE
as the [first round](qwen38-q2-speed.md). The baseline is the saved
executable and runtime Metal source from commit `1996434`.

## Changes

Q2_K decode now uses sixteen SIMD groups per threadgroup on M3 Ultra;
IQ2_XXS remains at eight. Each group still computes one row with the same
accumulation order. Geometry sweeps rejected larger IQ2 groups, paired
IQ2 rows, and explicit paired Q2 activation reuse as default choices.

Low-bit prefill keeps the first round's 8/16/32-token base tiles. For a
partial final expert tile, separate launches use eight or sixteen tokens
when sufficient. The primary launch excludes those remainders; the tail
launches write disjoint outputs. Function constant 905 specializes this
partitioning to the base tile width. This avoids unused matrix work while
keeping the K accumulation order and padded weight strides unchanged.

These defaults apply only to IQ2_XXS/Q2_K on M3 Ultra. Set
`DS4_QWEN4_MOE_MV_NSG=8 DS4_QWEN4_MOE_TAILS=0` to restore the first
round's geometry. The tail override can explicitly enable the path for
other supported expert formats, which are covered by kernel tests.

## Measurements

Three measured repetitions per implementation, interleaved after warmups.
Rates exclude model loading. All generated outputs matched exactly.

| Ordinary decode case | Round 1 tokens/s | Round 2 tokens/s | Gain |
|---|---:|---:|---:|
| Hamlet | 53.09 | 54.19 | 2.07% |
| Fibonacci | 53.14 | 54.19 | 1.98% |
| Explanation | 53.27 | 54.28 | 1.90% |

| Raw prompt tokens | Round 1 prefill | Round 2 prefill | Prefill gain | Round 1 decode | Round 2 decode |
|---:|---:|---:|---:|---:|---:|
| 1000 | 1079.32 | 1112.54 | 3.08% | 53.03 | 54.18 |
| 7930 | 1247.37 | 1263.13 | 1.26% | 49.46 | 50.47 |

Short-prompt prefill changed by -1.05% to +0.03%; those prompts do not
use the new remainder launches. MTP speed was effectively unchanged:
63.86 to 63.81, 78.65 to 78.57, and 67.66 to 67.72 tokens/s for the
three cases. Accepted drafts/cycles remained 44/71, 197/201, and 106/148.
The second round's ordinary decode gain does not imply an MTP gain.

## Validation

All 192 teacher-forced full-vocabulary vectors at prompt sizes 1, 2, 8,
9, 39, and 128 were finite and bit-identical to round 1. Full next-token
vectors after 1022- and 7952-token chat prompts also matched exactly.

The focused kernel suite checks sixteen-group decode against generic
decode and tests both remainder widths across six weight formats,
including physical-768/logical-640 Q2_K rows. Cases cover empty and hot
experts, tile boundaries, nonzero weight padding, and untouched output
slots. Both `make test-qwen4-q2` and the full `make test-qwen4-kernels`
suite passed on the final source.

[Complete benchmark records](qwen38-q2-round2-results.json) include
commands, binary/source hashes, repetitions, output hashes, logit parity,
and the longer-prompt recipe. Use `qwen38_mtp_compare.py` and
`qwen38_q2_parity.py` as described in the first-round report to reproduce.
