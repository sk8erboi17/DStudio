# Laguna S 2.1 long-prompt prefill on Metal

Upstream: [antirez/ds4](https://github.com/antirez/ds4), branch `laguna-s2.1`,
base revision `448d5695d1c86401a4e9447c440feb983b73e6de` (the bundled
`src/engines/ds4-laguna-s21`). Files: `ds4.c`, `ds4_help.c`, `ds4_metal.m`,
`metal/laguna.metal`.

Status: applied by the managed installer, the Chat launch path and the
Agent, Cowork and Design builds (see [Installer](#installer)). Real-weight
results are under [Evidence](#evidence).

## Problem

DStudio's common-100 corpus fails every long-context case (about 39,600 prompt
tokens, ctx 65536) on the unpatched branch with `metal Laguna prefill failed at
token 16384` (once at 32768). macOS ends a Metal command buffer with
`Impacting Interactivity
(kIOGPUCommandBufferCallbackErrorImpactingInteractivity)`, its error for GPU
work that keeps the window server from drawing, reported as `Laguna batch
prefill failed in dense FFN residual after 1/48 layers` or `MoE residual after
5, 9 or 21/48 layers`. The first 16,384-row batch always completed.

Two properties of the branch combine:

- The prefill batch is fixed at `min(ctx, 16384)` rows in `laguna_graph_alloc`,
  and `ds4_engine_open` refuses `--prefill-chunk`.
- `kernel_laguna_attention_prefill_gqa*_f16` gives one SIMD group to each
  query (and three heads), and that group visits every earlier key serially.
  At position *p* one GPU thread group therefore runs for *p* key steps.

A first version of this patch changed only the batch (4096 rows). Each layer's
command buffer became about four times shorter (about 0.4 s against 1.5 s),
yet the same error ended the prefill at token 20,480, in the batch whose
queries walk 20,481 to 24,576 keys (`tests/.artifacts/laguna-prefill-chunk/
run-MmwPWU`). Walks up to 16,384 keys (the first batch of the branch) and up
to 20,480 keys (the fifth 4096-row batch) completed. The bound that matters is
the length of one serial walk, not the size of a command buffer.

The same run showed a second defect. Two runs of the 4096-row engine on the
same prompt gave different logits (29.2718 and 29.2622 for the same token):
`kernel_laguna_commit_kv_f16` writes every row of a batch into the 512-slot
sliding-window ring in one dispatch, so rows *t* and *t + 512* store to the
same slot and which store lands last is unspecified. A later batch, or the
first decode step, then reads whichever row won. The branch does the same
after its single batch, before decode.

## Change

1. **Prefill batch.** `ds4_laguna_prefill_chunk()` resolves the batch once in
   `ds4_engine_open`, with the precedence the DeepSeek graph already uses
   (`ds4_prefill_cap_for_prompt`): `--prefill-chunk N`, otherwise
   `DS4_METAL_PREFILL_CHUNK=N`, otherwise **4096 rows on Metal** and 16384
   (unchanged) on CUDA/ROCm. The value is stored in `e->prefill_chunk` and
   passed to `laguna_graph_alloc`, which sizes every per-row scratch tensor and
   the batch split (`ds4_session_sync`'s Laguna loop and the CLI's
   `generate_laguna_metal_argmax`) with `min(ctx, chunk)`. Accepted values are
   16-16384 (16 is one DFlash verifier block; 16384 is the most scratch the
   branch allocated); values outside the range and malformed environment
   values are refused at engine open, never clamped. `--prefill-chunk 16384`
   reproduces the branch's batch for comparison. DStudio's host does not set
   either knob for Laguna, so the app uses the default.

2. **Key passes.** When a query of the batch would walk more than 4096 keys
   (`DS4_LAGUNA_PREFILL_KEYS_PER_PASS`, full-attention layers only; the
   512-row sliding-window layers never do), `ds4_gpu_laguna_attention_prefill_
   tensor` encodes one attention dispatch per key range [4096 *r*,
   4096 (*r* + 1)) of absolute key positions. The three prefill kernels take
   the range and first/last flags: a query starts from its stored state,
   visits the keys of the range in the same causal order, and stores its
   running max and sum (`pass_state`, two floats per row and head) and its
   unnormalised accumulator (its own output row) for the next pass; the last
   pass normalises and applies the gate exactly as before. No thread group
   walks more than 4096 keys per dispatch. A batch whose queries walk at most
   4096 keys is one dispatch with the range [0, UINT32_MAX), the original
   computation. `pass_state` is one private Metal buffer grown to the largest
   batch seen (4096 rows x 72 heads x 8 bytes = 2.25 MiB at the default) and
   kept for the process; prefill attention is encoded by one thread and its
   dispatches run in order on one queue.

3. **Ring commit.** `kernel_laguna_commit_kv_f16` writes only the newest
   `cache_cap` rows of a batch when the batch is longer than the ring, so each
   slot receives exactly one store: the row a sequential write would have
   left. Full-attention caches (`cache_cap` = ctx) are unaffected.

Scratch (measured formula from `laguna_graph_alloc`, 375,156 bytes per row
plus 404 KiB fixed; the 16384 value matches the logged `scratch 5862.21
MiB`): 16384 rows 5862.2 MiB, 4096 rows 1465.8 MiB. KV caches are unchanged.

Other consequences: progress (`prefill_chunk` events), the live checkpoint and
cancellation advance per batch, so Stop takes effect after at most 4096 rows.
ds4-server's continued disk-KV checkpoints (every 10,240 tokens) fire only on
a batch boundary: with 4096-row batches at 20,480 and 40,960 when the disk KV
cache is enabled, never below 81,920 tokens before.

## Numerical effect

- Batch size. Embedding, RMSNorm, Q/K head norm and RoPE (absolute position
  `pos0 + row`), SwiGLU, residual adds, router softmax/top-k, the final norm
  and output projection are per row. Dense quantized matmuls pick their kernel
  family by batch size (<= 8 rows `mul_mv_ext`, otherwise the 32x64 `mul_mm`
  tile); every batch here has at least 96 rows and 4096 is a multiple of 32.
  The routed MoE uses `mul_mm_id` for batches of at least 96 rows; a token sits
  at a different row of its expert's tile when the batch changes. Whether the
  GPU's tile arithmetic depends on that row is not something the source shows;
  the comparison below measures it.
- Key passes. Between passes the online-softmax state is stored and reloaded
  as float32, which is exact, and the pass boundaries are absolute key
  positions, so a query performs the same operations in the same order
  whichever batch it belongs to.
- Ring commit. The surviving row of every slot is the one a sequential write
  leaves; the unpatched kernel leaves an unspecified one.

Expected, and required: bit-identical final logits against the unpatched
engine, whose prefill never reads its ring, and bit-identical greedy decoding
between the patched 16384-row and 4096-row engines and between repeated runs.
The unpatched engine's decode is compared and recorded but not judged: it
reads the ring its racing commit wrote.

## Installer

`scripts/apply-ds4-laguna-prefill-chunk.sh check|apply|build|restore` with
`DS4_DIR` set: already applied (reverse check) exits 0; applicable applies the
complete delta with `git apply --whitespace=error` (no inherited Git index);
`restore` reverses it byte for byte; drift or a partial or edited patch fails
with no file changed; a checkout without a Laguna graph (ds4 main) is
skipped. Application order: last in the managed runtime stack
(`setup_apply_ds4_runtime_patches`: visible downloads, media memory, server
metrics, GLM 5.3 runtime, M2 Max, vision streaming, V4.1 pairing, this patch,
Qwen 3.8 prepare). On Laguna only media memory and server metrics change files
before it.

The host applies it in the installer, in every Chat launch
(`setup_ensure_server_metrics_runtime`) and before the Agent, Cowork and Design
builds (`apply_ds4_build_patches`). A Laguna `ds4-server` built without it is
detected from its contents (the patch's refusal message is compiled into the
executable) and rebuilt with `make -B`, because a binary copied back or built
before a restore can be newer than its sources. ds4 reads its Metal sources
from the checkout at startup, and `ds4_metal.m` is newer than any executable
built before the patch, so the executables are rebuilt together with the
kernels they dispatch.

## Tests

- `make test-laguna-prefill-chunk-patch` (in `check-fast`): lifecycle on copies
  of the bundled engine (apply, repeat, exact restore, drift in the Laguna
  graph and in the attention kernels, partial patches, preserved unrelated
  edits, ds4 main skipped), composition after the runtime stack, a build of
  the patched `ds4-server` and `ds4`, an offline compile of the whole patched
  Metal library as ds4 assembles it (reported NOT RUN without a Metal
  compiler), the engine's resolver through a `DS4_TEST_HOOKS` object, and
  stale build outputs after a patch state change. No model, no GPU work.
- `make test-laguna-prefill-chunk-upgrade`: the production Chat launch step on
  a copy of the bundled Laguna engine whose `ds4-server` predates the patch:
  the patch is applied and the server rebuilt (and its build receipt
  `.dstudio-build.json` written), a ready server is kept, and a pre-patch
  server newer than its sources is still rebuilt. Real `make`, no model.
- `make test-laguna-prefill-chunk-live` (real Laguna Q4_K_M weights, Metal,
  one engine process at a time): builds the unpatched and the patched engine
  in a new `tests/.artifacts/laguna-prefill-chunk/run-*`, compares logits and
  greedy decoding as described above on a ~12,000-token prompt, then runs
  needle prompts of ~40,000 tokens (ctx 49152) and ~60,000 tokens (ctx
  65536) with the patched default.

## Evidence

November 11, 2026, Apple M2 Max with 96 GiB, real Laguna S 2.1 Q4_K_M
weights resident in Metal, `ds4` CLI under a pseudo-terminal, one process at
a time (`tests/.artifacts/laguna-prefill-chunk/run-fbEHUg`, retained):

| Check | Result |
| --- | --- |
| Unpatched engine, 12,077-token prompt, run twice | final logits identical (0 of 100,352 differ) |
| Patched, `--prefill-chunk 16384` (one batch, three key passes) vs unpatched | identical (max \|Δ\| 0) |
| Patched default (three batches of 4096/4096/3885 rows, key passes), two runs, vs unpatched | identical (max \|Δ\| 0) |
| Greedy decoding, patched 16384 vs patched default, and default vs default | 23 tokens to end of text; tokens, top-20 order and top-20 logits identical |
| Greedy decoding, unpatched vs patched default (recorded, not judged) | identical in this run |
| 40,153-token needle prompt, ctx 49152, patched default | completed in 320 s including load, no Metal error, answered `4183-KESTREL` |
| 60,689-token needle prompt, ctx 65536, patched default | completed in 625 s including load, no Metal error, answered `4183-KESTREL` |

An earlier run of the batch change alone (`run-MmwPWU`, retained) gave
identical logits in one default run and differing ones (up to 0.91 among the
top-20 logits) in another, the ring race above, and failed the 40,153-token
prompt at token 20,480 with the Metal error.

These runs check the prefill and decode of one engine on one machine; they
do not qualify Laguna's answers. Its common-100 rerun on the patched engine
is tracked in [the plan](../../PLAN.MD).

Removal condition: drop this set once the pinned Laguna branch honours a
prefill batch request, bounds the serial key walk of its prefill attention on
Metal and commits its sliding-window ring deterministically.
