# MoE Expert Expansion — Agent Implementation Instructions

You are a coding agent implementing **MoE expert expansion** (dynamic routed-expert
count) in a target inference engine (llama.cpp first, other engines after).
This document is normative: follow it exactly, in order. It is platform-agnostic;
the Metal excerpts are references, not the port.

Work on a **new branch** named `moe-expansion` created from the project's default
branch. Do not open PRs against upstream unless your operator asks; keep
everything on the branch.

---

## 1. What the feature is

Sparse MoE routers aggressively prune: Qwen3.6-35B-A3B has 256 routed experts,
but the router softmax keeps only the **top 8** per token. Expert expansion is a
**runtime-only routing change** (no weight or model-file changes) with three knobs:

1. **Max experts N** (`--moe-experts N`, ds4: `--q35-experts`): raise the routed
   expert budget above the model's native top-K (e.g. 8 → 20).
2. **Dynamic threshold T** (`--moe-expert-threshold T`, ds4: `--q35-expert-threshold`):
   instead of a fixed count, keep experts while their router probability stays
   above `T × p_ref`, where `p_ref` is the probability of rank N/2. This makes
   the per-token expert count *adaptive*: dense tokens route to ~N experts,
   peaked tokens to fewer. T ≤ 1 only ever expands past the native K;
   T > 1 can also *prune* below native K down to the floor N/4.
3. **Expansion decay D** (ds4: hardcoded 0.50; **expose it as a flag**
   `--moe-expert-decay-end D`, default 0.50, e.g. 0.30): when N > K, ranks above
   the native K get a linearly decaying influence factor from **0.99 down to D**
   (0.99 × … × D at rank N), applied to the raw probability *before*
   renormalization. `--moe-no-expert-decay` (ds4: `--q35-no-expert-decay`)
   disables decay entirely (extra experts at full influence).

All flags off → the engine must behave **bit-identically** to stock. That
identity is a hard acceptance requirement, not a nice-to-have.

**Why it's worth it (measured, MMLU-Pro, 210 questions/config, temp 0,
Qwen3.6-35B-A3B Q6_K_XL, ds4/Metal):**

| config | reasoning ON | reasoning OFF | decode speed |
|---|---|---|---|
| native top-8 | 80.0% | 77.6% | 100% (~23 t/s) |
| N=20, T=0.8, decay 0.99→0.50 | 83.2% (partial run; +3 net answers on 132 paired questions, 85.6% vs 83.3%) | 78.1% | ~80% (18.5 t/s, ~15.5 experts/token) |

Gains are **model-dependent**: on Ornith-1.5-35B (different 35B MoE finetune)
the same expansion *lost* 2 points (68.1% → 66.2%). Never promise universality;
measure per model. The effect shows up most in knowledge-heavy subjects (law,
biology, philosophy) and not at all in math/physics (already saturated).

---

## 2. Normative routing specification

Context per token, per MoE layer (single token at a time in decode; if your
engine builds batched graphs, this spec is **per row**):

```
Inputs:
  p[e]      router probabilities, softmax over ALL n_expert experts (no pre-cap)
  N         max experts this run          (flag; default = native K)
  K         model's native top-k          (from model metadata; Qwen3.6-35B-A3B: 8)
  T         dynamic threshold, 0 = off    (flag, range (0, 10])
  D         decay end factor, default 0.50 (flag, range (0, 0.99))
  decay_on  bool, default true            (flag --moe-no-expert-decay sets false)

Derived:
  R = N / 2          (integer division; "reference rank", N must be >= 2)
  F = max(1, N / 4)  (floor: minimum experts per token)

Selection:
  1. order experts by probability, descending. Tie-break: lowest expert id
     (i.e. strict `>` when scanning for the max).
  2. p_ref = probability of rank R (1-indexed), i.e. order[R-1].
  3. If T == 0:  c = N.
     Else:       A = number of experts with p >= T * p_ref
                 c = min(N, max(F, A))
     (For T <= 1, A >= R always, so c >= R: the top half can never be cut.
      For T > 1, c can drop as low as F: the feature doubles as pruning.)
  4. sel = order[0..c-1]; w[j] = p[sel[j]]  (w is non-increasing).

Expansion decay (only if N > K and decay_on):
  extra = N - K
  for 0-indexed rank j in [K, c):          # only ranks above native K
      t   = (extra > 1) ? (j - K) / (extra - 1) : 0.5
      w[j] *= 0.99 + (D - 0.99) * t        # D=0.50 → 0.99..0.50; single extra → 0.745
  Decay is computed against the MAXIMUM N (not the selected count c), so a
  rank's factor does not jump when the cut point moves.

Output:
  renormalize: w[j] /= sum(w)               (sum > 0 guaranteed: c >= F >= 1)
  selected expert ids + weights feed the MoE FFN exactly as the native path
  would (same shared-expert handling, same output scaling — do NOT touch them).
```

Invariants your implementation must preserve:

- Router weights, softmax over all experts, shared expert, output norm/scale:
  unchanged.
- With all flags off (or N==K and T==0): identical expert set, identical
  weights → bit-identical logits and greedy output vs stock.
- `w` sums to exactly 1 after renormalization (up to float assoc).
- `c ∈ [F, N]` always, every token, every layer.

Parameter validation (fail fast, exit non-zero with a clear message):

- Feature applies only to MoE models with a softmax router + top-k selection
  (ds4 gates on the qwen35moe family). For a generic engine: refuse on
  non-MoE models.
- `1 <= N <= n_expert`, `N >= 2` (R must be >= 1), `T ∈ (0, 10]`,
  `D ∈ (0, 0.99)`.

Suggested flag names (generic → ds4 equivalent):

| generic | ds4 | default |
|---|---|---|
| `--moe-experts N` | `--q35-experts` | 0 = native K |
| `--moe-expert-threshold T` | `--q35-expert-threshold` | 0 = off (fixed N) |
| `--moe-expert-decay-end D` | *(hardcoded 0.50 today)* | 0.50 |
| `--moe-no-expert-decay` | `--q35-no-expert-decay` | off (decay on) |

---

## 3. Platform-agnostic implementation checklist

Order matters; do not skip ahead.

1. **Host-side selection unit** — implement the Section 2 algorithm as a plain,
   testable function (`select_experts(probs, N, K, T, D, decay_on) -> ids, weights, c`)
   in host code, no tensors. Write the unit tests from Section 6 before wiring
   anything into the engine.
2. **Flags + plumbing** — CLI parsing, validation, and one place where the
   native K is read from model metadata (GGUF `expert_count_used` /
   `n_expert_used`; fall back to the model's documented K if absent) and N/T/D
   flow to the routing site. Print a startup banner, e.g.:
   `moe: routed experts per token: 20 (model default 8; ranks 9..20 get linear influence decay 0.99..0.50)` and
   `moe: expert threshold: keep while p >= 0.80 x p(rank 10) (experts 5..20 per token)`.
3. **Routing site integration** — replace the fixed top-K selection at the MoE
   FFN with the new selection (two strategies below).
4. **Observability** — per-layer accumulator: `sum(selected count)` and token
   count; print `experts/token avg over 128 tokens: L0:14.9 L1:16.2 ... | mean 15.5`
   every 128 tokens (make the interval env-overridable). This is your primary
   health signal — build it BEFORE any quality evaluation.
5. **Variable-count execution** — downstream expert compute must honor the
   per-token count c: skip slots >= c (guard `if (slot >= n_sel) return;`), or
   (strategy B) keep fixed-size buffers and rely on zero weights.
6. **Determinism pass, smoke tests, then final acceptance** (Sections 7-8).

### Strategy A — true port (variable count)

Selection emits `sel[c]`, `w[c]`, `c` per token; expert GEMV/matmul loops only
over the first c slots. This is what ds4 does; it is the only strategy that
recovers compute when the cut is deep, and it is required to actually benefit
from pruning (T > 1). Cost: touches kernel indexing (variable loop bound or
per-slot early-exit guard).

### Strategy B — fixed-k mask (fast bring-up)

Keep the engine's existing top-k machinery with k = N, then post-process the
per-token weight vector: apply the Section 2 cut (zero the dropped ranks),
apply decay factors to ranks ≥ K, renormalize the survivors to sum 1. Zero
weights keep the math correct even if kernels still compute those experts.
Cost: you always pay N experts (no speed win from T, only from... none — speed
is N/K of native). Use B to validate quality first; switch the hot path to A
for the perf claim.

> Batched engines: the spec is per-token. In a batched graph, produce per-row
> masks/counts; never apply one token's cut to another. If your fused MoE
> kernel only accepts a single top-k for the whole batch, use Strategy B with
> per-row weights (correct) and accept the uniform cost.

---

## 4. Porting guide — llama.cpp

Branch `moe-expansion` from master. Anchors (grep, don't trust line numbers):

- CLI: `common/arg.cpp` (add the four flags near existing model flags), plumb
  through `common_params` → context/decode options.
- Native K and expert count: `n_expert_used`, `n_expert` in `llama-hparams`
  (populated from GGUF `expert_count_used` / `expert_count`).
- Routing build: `build_moe_ffn` in `src/llama-graph.cpp` — find the
  `ggml_top_k` (or fused-moe) selection; that is where N replaces K and where
  the weight post-pass (Strategy B) or the new selection op (Strategy A) goes.
- CPU/GPU kernels: whichever backend ops consume the selection
  (`ggml/src/ggml-cpu/…`, CUDA/`ggml/src/ggml-cuda/…` moe ops). For Strategy A
  you will need a per-slot `slot >= count` guard; for B only the weight tensor
  changes.
- Server: `examples/server` must accept the flags (quality evaluation runs
  through the OpenAI-compatible API).

Notes specific to llama.cpp:

- Prefill processes many tokens per graph: per-row selection/mask, as above.
- Speculative decoding / MTP paths untouched — expansion is orthogonal; if a
  draft model has its own router, leave it native.
- No GGUF changes whatsoever. Existing quants work as-is.

## 5. Porting guide — other engines (vLLM, SGLang, …)

Generic recipe:

1. Find the router top-k (vLLM: `vllm/model_executor/layers/moe/topk.py`
   `TopK`/`topk_softmax`; SGLang: `sglang/srt/layers/moe/topk.py`).
2. Insert the Section 2 post-pass on `(ids, weights)` right after top-k:
   compute p_ref from the k-th weight (weights arrive sorted or sort them),
   cut, decay ranks ≥ K, renormalize. This is Strategy B — fused kernels
   downstream already consume an ids+weights pair; check their max-topk
   (raise k to N if the kernel caps it).
3. Flags → engine's arg surface; if flags can't reach the layer, an env var is
   acceptable for bring-up (flag later).
4. Verify the kernel actually applies the renormalized weights (some fused MoE
   kernels renormalize internally or assume weights sum to k-normalized —
   check; if the kernel renormalizes again, the decay would be undone).

---

## 6. Intermediate verifications — what to check and what NOT to check

**Check (in this order):**

- Unit tests of the host selection function against Section 2 golden cases:
  - T=0 → c = N, no decay factors when N == K.
  - T=0.8, N=20, K=8 on a realistic power-law prob vector → c between R and N;
    ranks 9..c get factors 0.99…D by rank, independent of c.
  - T=10 → c == F (floor). T=0.9 with flat probs (many experts above the cut)
    → c == N.
  - Single extra (N=K+1) → factor exactly 0.745 for that rank (t=0.5).
  - D=0.30: last rank factor 0.30, first extra 0.99.
  - Ties between two experts → lowest id first, deterministic.
  - Weights sum to 1 after renorm (float tolerance).
- Flags-off identity: same prompt, greedy, same seed → **byte-identical**
  output vs a stock build. Also N==K with T=0 and decay on → identical to
  native (decay can't trigger when N == K).
- Banner + experts/token stats appear and look sane (see Section 7 numbers).
- One-layer numerical spot-check: dump `sel`, `w`, `c` for a known input
  (ds4: `DS4_Q35_DEBUG=1` prints `pos=… il=… n_sel=… sel: id(w) id(w)…`;
  replicate something equivalent) and hand-verify against the unit-test
  function on the same probs.

**Do NOT check / do NOT do while implementing:**

- Do not diff logits or outputs with flags ON against stock — they *must*
  differ. The identity requirement is flags-off only.
- Do not run quality benchmarks (MMLU etc.) before flags-off identity and the
  stats banner pass. If you benchmark mid-way you will chase ghosts.
- Do not benchmark or optimize speed before correctness is signed off.
- Do not use temperature > 0, top-p, or any sampling for any A/B comparison —
  greedy only, or the comparison is noise.
- Do not compare across quantizations, context sizes, chat templates, or
  prompt orders. One variable at a time: the flags.
- Do not touch router weights, the softmax, the shared expert, output
  norms/scales, KV cache, or sampling code paths.
- Do not "fix" unrelated bugs you notice in kernels along the way (quant
  quirks, style, refactors). Write them down in the branch notes; out of scope.
- Do not trust single-question anecdotes (one prompt right/wrong proves
  nothing in either direction; the deltas are 1-3 points).

---

## 7. Smoke tests (fast — run all of these, each takes minutes)

Using the target model (reference: Qwen3.6-35B-A3B, any GGUF quant):

1. **Identity**: stock build vs branch, flags off, greedy, fixed 100-token
   prompt → identical output. Repeat with `--moe-experts 8` (== native K),
   `--moe-expert-threshold 0` → still identical.
2. **Banner**: `--moe-experts 20` prints the startup banner; stderr shows the
   experts/token line every 128 tokens.
3. **Count extremes**:
   - `--moe-experts 20` alone (T=0) → mean experts/token == 20.0 exactly.
   - `--moe-experts 20 --moe-expert-threshold 10` → mean ≈ 5 (== F).
   - `--moe-experts 20 --moe-expert-threshold 0.8` → mean ≈ 15-16 on
     Qwen3.6-35B-A3B (expect any model to land in [F, N]; outside → bug).
4. **Decay toggles**: `--moe-no-expert-decay` leaves the experts/token stats
   unchanged (selection is identical; only weights differ) but the generated
   text changes. `--moe-expert-decay-end 0.30` changes text again; stats
   unchanged. If stats change → your decay is altering selection: bug.
5. **Coherence**: with `N=20 T=0.8`, one long generation (~500 tokens, greedy):
   fluent text, no repetition collapse, no NaNs/garbage.
6. **Determinism**: same flags, same prompt, 3 runs → byte-identical output.
7. **Server mode** (if the engine has one): flags accepted via server CLI;
   a 5-request session behaves like the CLI (spot-check one response).

Passing all smoke tests = you may proceed to final verification. Failing any
identity/determinism test = stop, fix, re-run from test 1.

## 8. Final verification and acceptance

All of the following must pass before declaring the branch done:

1. **Engine test suite**: the project's own `make test` / CI target passes
   unmodified.
2. **Identity regression battery**: ≥ 5 diverse prompts × 256 tokens, greedy,
   branch-flags-off vs stock → all byte-identical. Keep the transcript as an
   artifact (`identity/` on the branch).
3. **Stats acceptance**: with N=20 T=0.8, mean experts/token ∈ [12, 20]; every
   layer individually ∈ [F, N]; the per-layer means differ across layers
   (routing is not uniform — identical means everywhere suggest a wiring bug).
4. **Performance report**: decode t/s for native vs N=20 T=0.8 (Strategy A) on
   a fixed 512-token generation. Reference: ds4/Metal Q6_K ~23 → ~18.5 t/s
   (-20%). If your slowdown is ≫ N/K-scaled (e.g. -60% at N=20), you are
   computing dropped experts (Strategy B) or double-reading weights.
5. **Quality gate — paired MMLU-Pro protocol** (this is the feature's reason
   to exist; run it exactly like this):
   - 210 questions = 14 subjects × 15, temperature 0, few-shot 0, same
     questions for every config (evalscope `--eval-type openai_api` against
     the engine's OpenAI-compatible server, or lm-eval with fixed subset;
     the harness matters less than the pairing).
   - Configs: native vs `N=20 T=0.8 decay on`; optionally the no-think arm
     (if the model is hybrid-reasoning) — deltas can differ between modes.
   - Report per-config accuracy **and** the paired analysis on identical
     questions: both-right, both-wrong, wins A, wins B, net = wins−losses.
     Deltas of 1-3 points are the expected effect size: use the paired net,
     never raw-score differences alone.
   - Budget: max_tokens ≥ 8192 with reasoning models; re-run only the
     `stop_reason == max_tokens` samples at ≥ 30k (greedy → identical prefix,
     only the tail is new) before scoring.
   - Acceptance: paired net ≥ 0 (no regression) with mean experts/token ≤ 0.8·N
     → feature valid for that model. If net < 0, that is a *result* (see
     Ornith), not necessarily a bug: verify with test 3/4 that mechanics were
     correct, then document.
6. **Docs**: README section on the branch (flags, one example command, the
   measured table for your model) + `--help` text for the four flags.
7. **Branch hygiene**: single-purpose commits; note in the branch README any
   unrelated issues you spotted but did not fix (per Section 6).

---

## 9. Reference excerpts (ds4 / Metal) — for reading only

Selection + decay (from `metal/qwen35.metal`, `kernel_qwen35_ffn_enter`;
runs as one threadgroup of `n_expert` threads — router softmax in shared
memory, selection by thread 0):

```metal
/* Rank experts by probability.  Ranks 1..n_used/2 are always ranked
 * so p(rank n_used/2) is known; an expert is then kept only while its
 * probability stays above threshold * p(rank n_used/2), and at least
 * min_used experts are always selected.  threshold <= 0 selects
 * exactly n_used. */
float p_ref = 0.0f;
uint count = 0;
const uint k_ref = args.n_used / 2u;
uint k = 0;
for (; k < k_ref; k++) {                 /* unconditional reference set */
    uint best = 0; float bv = -1.0f;
    for (uint e = 0; e < args.n_expert; e++)
        if (sh_prob[e] > bv) { bv = sh_prob[e]; best = e; }
    if (k + 1u == k_ref) p_ref = bv;
    sel[k] = (int)best; sel_w[k] = bv;
    sh_prob[best] = -1.0f;
    count++;
}
/* sel_w is non-increasing: shrink below the reference rank down to the
 * floor (largest c >= min_used with sel_w[c-1] >= threshold * p_ref) */
uint keep = count;
if (args.threshold > 0.0f && k_ref > 0u) {
    keep = args.min_used < count ? args.min_used : count;
    while (keep < count && sel_w[keep] >= args.threshold * p_ref) keep++;
}
if (keep < count) {
    count = keep;
} else {
    for (; k < args.n_used; k++) {       /* expand past the reference rank */
        uint best = 0; float bv = -1.0f;
        for (uint e = 0; e < args.n_expert; e++)
            if (sh_prob[e] > bv) { bv = sh_prob[e]; best = e; }
        if (k >= args.min_used && args.threshold > 0.0f &&
            bv < args.threshold * p_ref) break;
        sel[k] = (int)best; sel_w[k] = bv;
        sh_prob[best] = -1.0f;
        count++;
    }
}
/* Expansion decay: when n_used exceeds the model's native top-N, every kept
 * expert ranked above the native count gets a linearly decaying influence
 * factor, 0.99 for the first extra rank down to 0.50 for the last one
 * (midpoint when there is a single extra).  Applied to the raw probability
 * BEFORE renormalization, so the native experts keep the output scale and
 * the extras fade out.  (ds4 hardcodes 0.50; a port exposes it as D.) */
if (args.n_used > args.n_used_native && args.n_used_native > 0u) {
    const uint extra = args.n_used - args.n_used_native;
    for (uint j = args.n_used_native; j < count; j++) {
        const float t = extra > 1u
            ? (float)(j - args.n_used_native) / (float)(extra - 1u)
            : 0.5f;
        sel_w[j] *= 0.99f + (0.50f - 0.99f) * t;
    }
}
/* renormalize kept weights to sum 1, publish count + per-layer stats */
```

Downstream variable-count guards — `kernel_qwen35_moe_down` skips slots beyond
the per-token count, `kernel_qwen35_moe_combine` clamps the weight fold:

```metal
/* kernel_qwen35_moe_down: threadgroup z = expert slot */
if (slot < args.n_used && slot >= n_sel[0]) return;          /* skip unused slot */

/* kernel_qwen35_moe_combine: residual fold */
const uint active = n_sel[0] <= n_used ? n_sel[0] : n_used;
for (uint s = 0; s < active; s++)
    v += sel_w[s] * weight_scale * partial[(uint64_t)s * n_embd + gid];
```

Flag wiring and validation: `ds4.c` (~line 57900): family guard, `N ≤ n_expert`,
`T ∈ (0,10]`, `min_used = N/4`, startup banners. Stats accumulator:
`n_sel_acc[0]` = tokens, `n_sel_acc[layer+1]` = Σ selected; banner every 128
tokens (env `DS4_Q35_EXPERT_STATS_EVERY`).

---

## 10. Parameter quick guide (tested values)

| Goal | Flags | Expected on Qwen3.6-35B-A3B |
|---|---|---|
| Native behavior | (none) | baseline |
| Fixed expansion, full influence | `--moe-experts 20 --moe-no-expert-decay` | slower, quality ≈ round-1 config C (no gain) |
| Expansion + decay (default end 0.50) | `--moe-experts 20 --moe-expert-threshold 0.8` | ~15.5 exp/tok, best quality so far |
| Stronger fade-out | add `--moe-expert-decay-end 0.30` | untested as of writing — measure |
| Aggressive pruning | `--moe-experts 8 --moe-expert-threshold 2` | c ∈ [2..8], untested — measure |

Untested combinations are experiments, not bugs, if they underperform. Keep the
paired protocol from Section 8 as the judge.
