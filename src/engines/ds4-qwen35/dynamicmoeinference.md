# Llama.cpp implemetation of Dynamic MoE inference 

We implemented the same architecture  in **llama.cpp**

https://github.com/vagrillo/llama.cpp/blob/moe-expansion/docs/moe-expansion.md

Tested with **GPQA Diamond**  the MOE Expansion vs Native inference:

https://github.com/vagrillo/llama.cpp/blob/moe-expansion/benchmark/GPQA/report_gpqa_moe.md


# Dynamic MoE inference: scaling routed experts up and down

DwarfStar can change, at inference time, how many routed experts each token
activates in the MoE layers. Two implementations exist. They share the same
threshold selection rule but answer different constraints, and their
mechanisms differ in one fundamental way: where the per-token expert count
lives.

| | qwen35moe | DeepSeek V4 Flash |
|---|---|---|
| Switches | `--q35-experts N`, `--q35-expert-threshold P` | `--dsv4-experts N`, `--dsv4-expert-threshold P` |
| Direction | down **and up** (expansion) | down only, 1-6 |
| Expansion influence | linear 99%..50% decay (`--q35-no-expert-decay` to disable) | n/a |
| Default N | model value (8) | model value (6) |
| N range | 1..`expert_count` | 1-6 |
| Requires `--ssd-streaming` | no | yes |
| Scope | decode path (fused kernels) | decode only, prefill always uses 6 |
| Count location | entirely on the GPU | computed on the GPU, read back per layer on the host |
| Kept weights | renormalized over the kept set | unchanged router weights, dropped mass discarded |
| Stats env | `DS4_Q35_EXPERT_STATS_EVERY` | `DS4_DSV4_EXPERT_STATS_EVERY` |

## Why change the expert count

Routed layers activate a fixed top-K per token (top-8 for Qwen3.6-35B-A3B,
top-6 for DeepSeek V4 Flash), but router scores decay quickly after the top
few ranks. Selecting fewer experts removes the matvecs — and, in SSD
streaming, the SSD fetches and expert-cache residency — of exactly the
experts that contribute least. A score threshold makes the count adaptive:
easy tokens keep few experts, hard tokens keep all of them.

In the other direction, qwen35moe also supports **expert expansion**:
selecting more experts than the model's default routing (up to
`expert_count`) computes a denser approximation of the full MoE output at a
proportionally higher compute cost. This can recover a little quality on
tasks where the router's top-8 is a tight bottleneck. By default the added
experts enter with a linearly decayed influence (99% down to 50%), since
the model never trained them to be full-strength at those ranks.

## The shared threshold rule

With `N` = the `-experts` maximum and `P` = the `-expert-threshold`
fraction:

* Without `P`: fixed top-N selection.
* With `P`: experts are kept only while their router score is at least
  `P x score(rank N/2)`. The top `N/4` ranks are always kept (dsv4 clamps
  the floor to at least 1), so every token retains a core set, and the
  count is capped at N. The result adapts per token and per layer.

Example: `--dsv4-experts 4 --dsv4-expert-threshold 0.95` uses rank 2 as the
reference, always keeps at least 1 expert, and drops any expert whose score
falls below 95% of that reference, up to a maximum of 4.

## Expansion influence decay (qwen35moe)

The router of Qwen3.6-35B-A3B was trained to mix exactly 8 routed experts
per token. When `--q35-experts N` expands the selection beyond that native
count, the extra experts enter **with a progressively decaying influence**
instead of full strength: a linear factor that starts at 99% for rank 9
(the first extra) and falls to 50% at rank N (the last extra). If exactly one
extra expert is selected (N = 9), it gets the midpoint, 74.5%.

The factor multiplies the expert's raw router probability **before** the
kept weights are renormalized:
w(rank k) = factor(k) * p(rank k) / sum_j(factor(j) * p(j))
factor(k) = 0.99 + (0.50 - 0.99) * (k - 8) / (N - 9) for k = 9..N


Applying the decay before the renormalization is what makes it well
behaved: the routed output keeps its scale, the native top-8 keep (and
slightly gain) relative weight, and the added experts fade out instead of
diluting them. Decaying after the renormalization would instead shrink the
total contribution and change the layer output magnitude.

Factors for `--q35-experts 20`:

| rank | 9  | 10 | 11 | 12 | 13 | 14 | 15 | 16 | 17 | 18 | 19 | 20 |
|------|----|----|----|----|----|----|----|----|----|----|----|----|
| factor | 99% | 95% | 90% | 86% | 81% | 77% | 72% | 68% | 63% | 59% | 54% | 50% |

Notes:

* The decay runs inside the router kernel, in prefill and decode alike
  (the qwen35moe path is a single per-token pipeline).
* With `--q35-expert-threshold` active, the cut is decided first, on the
  raw probabilities; the decay then applies to whatever survived above
  rank 8. The stats report counts the kept experts as usual.
* `--q35-no-expert-decay` turns the decay off: every selected expert gets
  full influence, which is the pre-decay expansion behavior.
* Without expansion (N <= 8) nothing decays and results are bit-identical
  to the stock routing.

## Comparison with Existing Dynamic Routing Methods

Dynamic Top‑K routing has recently emerged as a way to reduce inference cost in Mixture‑of‑Experts (MoE) models by adapting the number of activated experts per token. Two notable approaches in the literature are **Top‑P** (Huang et al., 2024) and **Ada‑K** (Yue et al., 2025). This section highlights how DwarfStar’s dynamic routing differs from these methods.

### Top‑P Routing

Top‑P adds experts in order of router probability until the **cumulative probability** exceeds a threshold \( P \). This reduces average expert count but does not provide a hard upper bound (other than the total number of experts) and does not support expanding beyond the model’s native top‑K.

### Ada‑K Routing

Ada‑K trains a **lightweight RL‑based allocator** that decides a per‑token expert budget. It can reduce FLOPs by >25% without accuracy loss, but requires an additional learned component and its associated training overhead.

### DwarfStar’s Threshold‑Based Routing

DwarfStar uses a **deterministic, threshold‑based rule** on the raw router probabilities:

- Let \( N \) be the maximum number of experts to consider (user‑configurable).
- Let \( P \) be the threshold fraction (user‑configurable).
- An expert at rank \( k \) is kept only if its score ≥ \( P \times \) score(rank \( \lfloor N/2 \rfloor \)).
- The top \( \lfloor N/4 \rfloor \) ranks are always kept (at least 1), ensuring a core set of experts for every token.
- The total number of kept experts never exceeds \( N \).

This rule is **computed on‑the‑fly** from the already‑available router scores—no cumulative sum, no extra network, no training. It adds negligible overhead and is fully deterministic.

#### Key Differences

| Feature | Top‑P | Ada‑K | DwarfStar Threshold |
|--------|-------|-------|---------------------|
| **Selection criterion** | Cumulative probability ≥ \( P \) | Learned policy (RL) | Relative score threshold (rank \( N/2 \) reference) |
| **Training required** | No | Yes (lightweight RL) | No |
| **Hard upper bound** | No (up to all experts) | Yes (budget from policy) | Yes (user‑set \( N \)) |
| **Always‑on core experts** | No | No | Yes (top \( N/4 \) or at least 1) |
| **Supports expansion** | No | No | Yes (qwen35moe, with linear decay) |
| **Extra inference overhead** | Low (cumulative sum) | Medium (allocator forward) | Negligible (threshold comparison) |

#### Unique Advantage: Expansion Beyond Native Top‑K

DwarfStar’s **qwen35moe** implementation can **increase** the number of activated experts beyond the model’s default (e.g., from 8 to up to 20). Because the router was trained to mix exactly the native top‑K, the added experts receive a **linearly decayed influence** (99% → 50%) before renormalization. This allows a denser approximation of the full MoE output without retraining, and the decay keeps the layer’s output scale stable. Top‑P and Ada‑K do not address expansion; they only reduce the count.

#### Summary

DwarfStar’s routing is **simpler, fully transparent, and zero‑overhead** compared to RL‑based or cumulative‑probability methods. It is particularly suited for production deployments where predictability, deterministic behavior, and the ability to both **down‑scale and up‑scale** expert counts are valuable.

## Implementation 1: qwen35moe, all on device

Qwen3.6-35B-A3B runs fully resident on Metal through fused kernels
(`metal/qwen35.metal`), so the expert count never leaves the GPU:

* The router kernel (`kernel_qwen35_ffn_enter`) already performs the
  weighted RMS norm, the router projection, and the shared-expert gate. Its
  top-N loop applies the threshold rule directly: it selects the first
  `N/2` ranks to establish the reference probability, keeps extending while
  `p(k) >= P x p(rank N/2)` (down to the `N/4` floor, up to the N cap), and
  writes the kept count to a device buffer `n_sel[0]`.
* The selected experts' weights are **renormalized over the kept set**, so
  the routed output keeps its scale regardless of how many experts
  survived the cut. The sigmoid-gated shared expert is unaffected.
* When N exceeds the model's native top-N, the extra ranks do not get
  full influence: the kernel multiplies their raw probability by a linear
  factor, 0.99 for the first extra rank down to 0.50 for the last one
  (midpoint when there is exactly one extra), before the
  renormalization. The decay applies in prefill and decode alike, and
  `--q35-no-expert-decay` turns it off, giving every selected expert
  full influence.
* The MoE kernels (`moe_gate_up`, `moe_down`, `moe_combine`) read
  `n_sel[0]` on device and early-return for slots at or above the count:
  dropped experts are never touched. Because nothing is read back, the
  command batch is never interrupted; expansion to N larger than the
  default works the same way, just with more active slots.
* Per-layer statistics accumulate on the GPU into an atomic counter
  (`n_sel_acc`); the host reads it once per reporting interval (default
  every 128 tokens) to print the average experts/token per layer.

## Implementation 2: DeepSeek V4 Flash, host-side cut for SSD streaming

The Flash streaming path must know, per layer, which experts to `pread`
from the SSD and which expert-cache slots to bind, so the count computed on
the GPU is read back by the host:

* The router finalize kernels (`metal/dsv4_misc.metal`) run the same
  threshold rule over the top-6 scores (reference rank `N/2`, floor
  `max(N/4, 1)`, cap N) and write the kept count to a small `n_sel` graph
  tensor.
* `routed_moe_one` reads it back per layer, riding the selected-ids sync
  that the streaming decode path already performs. Cut experts are never
  fetched from SSD and never occupy expert-cache residency; only the kept
  experts are loaded and bound.
* The decode kernels always address exactly 6 slots. Tail slots above the
  kept count mirror slot 0's expert (valid quantized data) with **weight
  0**, so buffers are always valid and no NaN can leak. Unlike qwen35moe,
  the kept experts keep their original router weights: the dropped weight
  mass is discarded rather than renormalized.
* The first 3 hash-routed layers have no router scores. There the maximum
  simply truncates the fixed per-token expert table to its first N entries
  (the threshold does not apply), and the tails mirror slot 0 with weight
  0 as above.
* The streaming split path (resident experts submitted while missing
  experts load) masks its down pass to the slots it actually produced;
  cut tails are skipped there too, which is numerically identical since
  their weight is 0.
* While a cut is active, the M5 fused router-select kernel and the
  `DS4_METAL_DISABLE_ROUTER_SELECT_FUSION` fallback are excluded, because
  they do not maintain `n_sel`. Prefill always uses the full 6 experts.

The difference in count placement is the core design decision: qwen35moe is
resident, so the count stays on device and decode is never interrupted;
the Flash streaming path needs the count on the host to drive SSD I/O, so
it pays one extra 4-byte read per layer inside a sync it already needed.

## Measuring and tuning

* Start from `--q35-experts 4` / `--dsv4-experts 4` with a threshold around
  `0.95`, then watch the per-layer average printed by the stats report.
  Layers that consistently cut deep are the safest to keep cutting.
* Decode speed scales roughly with the expert count. Reference numbers for
  qwen35moe on an M4 Pro 48 GB (Q6_K_XL, `--temp 0`):

| --q35-experts | tok/s decode |
|--------------|--------------|
| 1            | 33.2         |
| 4            | 29.4         |
| 8 (default)  | 25.9         |
| 16           | 20.6         |

* For DeepSeek V4 Flash the saving is twofold: fewer expert matvecs and
  fewer SSD fetches. The effect is largest when the expert cache is cold
  or thrashing; with a hot cache the fetch saving shrinks and the speedup
  approaches the pure compute ratio.
* Accuracy is workload-dependent. Score your configuration with
  `ds4-eval` before trusting a deep cut for critical work, and remember
  that qwen35moe renormalizes while dsv4 discards the dropped weight mass,
  so the same threshold value can behave differently across the two
  models.

## Measured comparison (evalscope, 2026-08-24)

First run, small samples (32 MMLU, 30 HumanEval, 16 MMLU-Pro questions per
configuration — directional results only). Evalscope 1.10.0 against the
local ds4-server OpenAI API (Q6_K_XL, M4 Pro, thinking mode on, 0-shot,
temperature 0, identical questions across runs; full data in `evalscope/`):

| | `--q35-experts 20` + thr 0.8 (decay) | native (8) |
|---|---|---|
| MMLU, 8 subjects x 4 (n=32) | **96.9%** | 93.8% |
| HumanEval pass@1, 30 problems | 96.7% | 96.7% |
| MMLU-Pro, 8 subjects x 2 (n=16) | **81.3%** | 75.0% |
| Decode speed | 18.5 t/s | 22.9 t/s |
| Routed experts/token | ~15.5 (cap 20, threshold cut) | 8 |

Reading:

* Expansion **with the influence decay** was never below native routing on
  any suite (+2 correct answers over 78 samples in this run) — a weak
  positive signal that a larger MMLU-Pro round is scheduled to confirm.
* In the decay ablation (expansion with vs without decay at identical
  expert count and speed, documented in `evalscope/comparison_decay.md`),
  the decay variant also came out ahead: MMLU 96.9 vs 90.6, MMLU-Pro
  81.3 vs 75.0, nothing worse anywhere.
* The expansion costs ~19% decode speed (18.5 vs 22.9 t/s with ~15.5 vs 8
  experts/token). It is a quality-leaning setting for single-shot work,
  not a throughput setting.



## Pelican riding a Bicycle with Qwen3.6-35B-A3B-UD-6b_XL

   Short test using a **6bit quantized** Qwen 35B model.



   
```Generate an SVG of a California brown pelican riding a bicycle. The bicycle must have spokes and a correctly shaped bicycle frame. The pelican must have its characteristic large pouch, and there should be a clear indication of feathers. The pelican must be clearly pedaling the bicycle. The image should show the full breeding plumage of the California brown pelican.```

**ORIGINAL**
 --nothink  (default settings)
 
 <img width="829" height="578" alt="image" src="https://github.com/user-attachments/assets/e46b818e-2e73-4b88-a50a-2b3c77e9c0b4" />



**Dynamic Expert enhance - 14 EXPERTS AVERAGE**
 --nothink --q35-experts 16  --q35-expert-threshold 95
 
<img width="604" height="408" alt="image" src="https://github.com/user-attachments/assets/46089da5-2a5f-4dce-8ca5-d446a725c159" />



**MMLU results complete**

Using 20 experts, threeshold   0.8 and decay from 99% to 50%  MMLU resulta are +3.1 !!!

  - A (experts 20, thr 0.8, decay): 96.88% (31/32)
  - B (default 8): 93.75% (30/32)
  - C (experts 20, thr 0.8, NO decay): 90.62% (29/32)


<img width="667" height="205" alt="image" src="https://github.com/user-attachments/assets/f86147e4-3db1-4f6c-85c7-67907f2d6d9a" />
