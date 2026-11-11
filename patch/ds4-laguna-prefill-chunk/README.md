# Laguna S 2.1 prefill batch size

Upstream: [antirez/ds4](https://github.com/antirez/ds4), branch `laguna-s2.1`,
base revision `448d5695d1c86401a4e9447c440feb983b73e6de` (the bundled
`src/engines/ds4-laguna-s21`). Files: `ds4.c`, `ds4_help.c`.

Status: the patch, its script and its lifecycle/CPU-build test are in place.
**It is not yet applied by the managed installer or the Chat launch path**, so
installed Laguna engines are unchanged until that wiring lands. The
real-weights equivalence run and the long-context rerun have not been run.

## Problem

The branch fixes Laguna's prefill batch at `min(ctx, 16384)` rows in
`laguna_graph_alloc` and refuses `--prefill-chunk` in `ds4_engine_open`
("no ... custom prefill chunk"). DStudio's common-100 corpus fails every
long-context case (about 39,600 prompt tokens, ctx 65536) with
`metal Laguna prefill failed at token 16384` (once at 32768): the second
16,384-row batch ends in `Metal command batch failed: Impacting Interactivity
(kIOGPUCommandBufferCallbackErrorImpactingInteractivity)`, reported as
`Laguna batch prefill failed in dense FFN residual after 1/48 layers` (4 of
8 restarts) or `MoE residual after 5, 9 or 21/48 layers`. The first batch
(positions 0-16383) always completed: 73.9 s at 221.8 t/s in the retained log.

ds4-server and the Agent set display progress, so the Laguna batch forward
commits one Metal command buffer per layer. One layer of a batch does
`rows` matmul rows plus about `rows x (pos0 + rows/2)` query-key steps in each
full-attention layer, since the prefill attention kernel walks every earlier
key serially per query. The second 16,384-row batch does about three times the
attention work of the first (4.0e8 against 1.3e8 query-key pairs) and exceeds
the macOS GPU watchdog.

## Change

`ds4_laguna_prefill_chunk()` resolves the batch once in `ds4_engine_open`, with
the precedence the DeepSeek graph already uses (`ds4_prefill_cap_for_prompt`):

1. `--prefill-chunk N` (ds4, ds4-server and ds4-agent already parse it into
   `ds4_engine_options.prefill_chunk`);
2. otherwise `DS4_METAL_PREFILL_CHUNK=N`;
3. otherwise **4096 rows on Metal**, 16384 (unchanged) on CUDA/ROCm.

The resolved value is stored in `e->prefill_chunk` (ds4-server's startup line
reports it) and passed to `laguna_graph_alloc`, which sizes every per-row
scratch tensor and the batch split (`ds4_session_sync`'s Laguna loop and the
CLI's `generate_laguna_metal_argmax`) with `min(ctx, chunk)`. Accepted values
are 16-16384: 16 is one DFlash verifier block (the verifier batch must fit the
scratch), 16384 is the most scratch the branch ever allocated. Values outside
the range, and a non-numeric or non-positive environment value, are refused at
engine open with an explicit error; nothing is clamped. `--prefill-chunk 16384`
reproduces the branch's batch exactly for comparison.

Why 4096: it is the batch the DeepSeek Flash graph uses for prompts above 4096
tokens in the same source (`ds4_prefill_cap_for_prompt`; PRO uses 8192), and it
keeps the matmul rows of every command buffer at a quarter of the batch that
passed. Its attention work up to position 40,000 (4096 x about 38,000 = 1.6e8
pairs) is close to the first 16,384-row batch that passed (1.3e8), well below
the second batch that failed (4.0e8). Attention work still grows with
position: near the corpus context (65,536) a 4096-row batch does about 2.7e8
pairs, so the long-context check must also be run there (see below). A
position-adaptive batch is not part of this patch.

Scratch (measured formula from `laguna_graph_alloc`, 375,156 bytes per row
plus 404 KiB fixed; the 16384 value matches the logged `scratch 5862.21 MiB`):
16384 rows 5862.2 MiB, 4096 rows 1465.8 MiB, 512 rows 183.6 MiB. KV caches
are unchanged. The upstream `ds4_context_memory_estimate` for Laguna counts one
scratch row and is not changed by this patch; the `Laguna GPU graph:` log line
reports the allocation actually made.

Other consequences: progress (`prefill_chunk` events), the live checkpoint and
cancellation advance per batch, so Stop takes effect after at most 4096 rows.
ds4-server's continued disk-KV checkpoints fire only when a batch boundary
lands on their interval (10,240 tokens); with 16384-row batches that never
happened below 81,920 tokens, with 4096-row batches it happens at 20,480 and
40,960 when the disk KV cache is enabled.

## Numerical effect (from the source)

- Per row and position-exact: embedding, RMSNorm rows, Q/K head norm + RoPE
  (absolute position `pos0 + row`), SwiGLU, residual adds, router softmax/top-k,
  the final norm and output projection (last row only).
- Attention (`kernel_laguna_attention_prefill_gqa*_f16`): each query walks
  keys from `key_start` to its own position in causal order with an online
  softmax; current-batch keys come from the staged f16 copy and earlier keys
  from the cache, both `(half)` of the same f32 K/V. The order and values do
  not depend on where a batch boundary falls. SWA layers keep a 512-row ring;
  the commit kernel writes every staged row to `(pos0 + row) % 512` in one
  dispatch, so for batches above 512 rows several rows share a slot within one
  dispatch. That latent ordering assumption exists for both batch sizes and is
  covered by the exact comparison, not removed by this patch.
- Dense quantized matmuls: the kernel family depends on the batch (`<= 8`
  rows: `mul_mv_ext`; otherwise the 32x64 `mul_mm` tile; Metal 4 tensor matmuls
  are suppressed in Laguna prefill). 4096 is a multiple of 32, so each row keeps
  its position within a tile. Q6_K uses a per-row kernel.
- Routed MoE: batches of at least 96 rows use the grouped `mul_mm_id` path;
  `map0` lists each expert's tokens in batch order, so a token sits at a
  different row of its expert's tile when the batch changes. The K order per
  output element is fixed; whether Apple's simdgroup tile arithmetic is
  independent of the row within the tile is not something the source can show.
- DFlash feature capture is per row; its separate recomputation for batches of
  at most 16 rows exists at both batch sizes.

Expected: bit-identical final logits and greedy tokens when every batch takes
the same kernel family as the single batch (all batches >= 96 rows). The
tolerance is therefore **exact**: every vocabulary logit equal, identical
top-20 order and identical greedy tokens for 64 steps, with the 16384 reference
required to reproduce itself first. A nonzero difference is a failed
hypothesis to be analysed with the measured size, not a pass.

## Lifecycle, installer and tests

`scripts/apply-ds4-laguna-prefill-chunk.sh check|apply|build|restore` with
`DS4_DIR` set: already applied (reverse check) exits 0; applicable applies the
complete delta with `git apply --whitespace=error` (no inherited Git index);
`restore` reverses it byte for byte; drift in the Laguna graph or a partial or
edited patch fails with no file changed; a checkout without a Laguna graph
(ds4 main) is skipped. Application order: after the managed runtime stack of
`setup_apply_ds4_runtime_patches` (visible downloads, media memory, server
metrics, GLM 5.3 runtime, M2 Max, vision streaming, V4.1 pairing). On Laguna
only media memory and server metrics change files; the result of that stack
on the bundled sources is byte-identical to the current installed Laguna
checkout, and this patch applies on top of it.

Not yet done (installer wiring): calling the script from
`setup_apply_ds4_runtime_patches`, from the Chat launch upgrade step in
`setup_ensure_server_metrics_runtime` and from the Agent/PLD builds, adding it
to the launch dependency list, and a readiness check that rebuilds a Laguna
`ds4-server` built before the patch. Until then the engine-acceptance runner
keeps omitting `--prefill-chunk` for Laguna, because the installed engine
still refuses it.

`make test-laguna-prefill-chunk-patch` runs the lifecycle above on copies of
the bundled engine, the composition after the runtime stack, a CPU compile of
the patched `ds4-server` and `ds4` (no model, no GPU work), the engine's own
resolver through a `DS4_TEST_HOOKS` object, and checks that applying or
restoring the patch makes the built binaries stale for `make`.

`make test-laguna-prefill-chunk-live` (real Laguna Q4_K_M weights, Metal,
one engine at a time; not yet run) builds the patched engine in a new
`tests/.artifacts/laguna-prefill-chunk/run-*` directory and compares batch
16384 with the default on a ~12,000-token prompt, then runs a ~40,000-token
needle prompt with the default. Also run it with
`LONG_TOKENS=60000 LONG_CTX=65536` for the corpus context.

Removal condition: drop this set once the pinned Laguna branch honours a
prefill batch request and uses a watchdog-safe default on Metal.
