# Qwen Flash Next now uses the main engine

Qwen3.8-Flash-Next no longer needs a separate DStudio engine. Upstream merged it
into antirez/ds4 main on September 14, 2026 (`9139e2a`). DStudio pins main to
[`0aaea5a238fb41a35106a551e73c8409dfb751ac`](https://github.com/antirez/ds4/commit/0aaea5a238fb41a35106a551e73c8409dfb751ac),
committed upstream on September 20, 2026 and still main's tip when rechecked on
September 29. The installer, model catalog, Chat, Agent and Cowork
routing use `ds4`. Qwen3.6 MoE, Qwen27B and Laguna retain their own engines.

## Existing users need the new model format

Upstream changed the checkpoint format as well as merging the engine. Choose
**Qwen3.8-Flash-Next Q2 or Q4** in Settings → Models. These are single files:

| Download | Disk space | Resident backbone, before working memory |
| --- | --- | --- |
| `Qwen3.8-Flash-Next-Q2.gguf` | 147.2 GB / 137.1 GiB | approximately 41.7 GiB |
| `Qwen3.8-Flash-Next-Q4.gguf` | 177.3 GB / 165.1 GiB | approximately 69.7 GiB |

Both contain approximately 95.4 GiB of original BF16 n-gram data, read from SSD
by the native engine. This is **not expert SSD streaming**. Expert streaming
remains Off for Qwen, without changing the preference saved for DeepSeek.
Context, vision and runtime scratch require additional memory.

The earlier 73.4 GB Q4K/MXFP4 base plus 32.0 GB Q4 PLE sidecar is **not compatible
with this integration**. It is preserved on disk, not converted, renamed or
silently replaced. DStudio hides that obsolete combination from usable models,
explains the replacement in Settings and rejects an old saved launch before
stopping the current runtime. No new weights are downloaded automatically.

```sh
./download-model.sh qwen38-q2
# Or choose the larger Q4, not both unless you want both files:
./download-model.sh qwen38-q4k
```

These commands explicitly download large model files. `qwen38-q4k` keeps its
existing command name but now downloads the upstream Q4 single-file release.
The Hugging Face CLI is required. Downloads use one worker and retain native
size/SHA-256 verification; legacy DeepSeek/GLM transfers retain visible partials.

The model repository is
[`antirez/qwen3.8-flash-next-gguf`](https://huggingface.co/antirez/qwen3.8-flash-next-gguf/tree/d600fe1a43d2e1cdcadb85144ce3142f66f9eefe),
pinned to `d600fe1a43d2e1cdcadb85144ce3142f66f9eefe`:

| File | Exact bytes | SHA-256 |
| --- | --- | --- |
| Q2 | 147207127040 | `b1b93fa69aca5f187b0fb813aca8f3ec1beb5cf8cf0bd38cf041b93e0b6ccac9` |
| Q4 | 177280286720 | `680944460a8cbe93ba8b6d7b6107213ffb7e22320bd913000e563ca0a0f25a8a` |

## What was integrated

All 79 upstream commits after `bd66c402070042bf0a79ad6ece8242de4c93680c` are
included at the current pin, not a cherry-picked Qwen parser. The first 17 landed the
unified Qwen engine; the following 62 add Qwen multi-session batching/MTP, Metal and
CUDA work, server/tool-stream fixes, GLM decode corrections, vision hardening and
new upstream quality fixtures. They include the Qwen merge, native
BF16 n-gram loading, checkpoint/speculative/tool fixes, literal tool-argument
tags, short-prefill precision and steering corrections, plus upstream V4.1 CUDA
and SSD-prefill work. CUDA source integration is not a CUDA test result.

The ordered native adaptations remain explicit patches:

1. [Visible downloads](../patch/ds4-visible-downloads/main-qwen.patch).
2. [Media residency](../patch/ds4-media-memory/residency-lease.patch), now checked
   as one complete delta before writing. Its CUDA context no longer assumes an
   obsolete empty cache-budget setter; residency behavior is unchanged.
3. [Native timing](../patch/ds4-server-metrics/usage-metrics.patch).
4. [GLM runtime](../patch/ds4-glm53-runtime/main-latest.patch); the older unified-main delta is retained as a historical variant.
5. [M2 adaptation](../patch/ds4-glm53-m2max/native-decode-main-qwen.patch), its
   [build hunks](../patch/ds4-glm53-m2max/build-main-current.patch) and
   [bounded hotlist storage](../patch/ds4-glm53-m2max/hotlist-main-layout.patch).
6. [Vision mapping](../patch/ds4-vision-streaming/vision-map.patch).
7. [Private Qwen session preparation](../patch/ds4-qwen38-prepare/prepare-main.patch).

Agent/Cowork use the version-103 [main overlay](../patch/ds4-agent-jsonl/main-qwen.patch)
and [browser overlay](../patch/ds4-web-runtime/browser-main.patch) in private build
sources. Both were rebased on `9139e2a`; `ds4_agent.c` and `ds4_web.c` are
byte-identical at `0aaea5a`, which their `bases.json` records as an equivalent
source revision. Native tool grammars, worker ownership, Stop, live input, durable save
and the existing compaction/PLD boundaries are preserved. Chat's server PLD
build uses [`main-latest.patch`](../patch/ds4-server-pld/main-latest.patch) for
`0aaea5a`, leaving upstream's batched Qwen MTP scheduling intact. The adapter
remains family-gated; merging Qwen into main does not enable unsupported PLD.

Upstream already includes correct Qwen snapshot-allocation cleanup and browser
target recovery. The separate snapshot/inspection patches and older Agent/Web
variants remain as historical regression assets, not new engine installs.
The obsolete `scripts/download-qwen38.py` sidecar downloader is removed.
The legacy setup endpoint returns 410 with migration guidance; it cannot
reinstall `ds4-qwen38`. Existing checkout files and weights are not deleted.

## Verification and remaining qualification

The scoped verification uses an M2 Max with 96 GiB RAM. On September 29, 2026
the model-free set below was rerun against the active `0aaea5a` pin and current
patch stack. Earlier September 14 runs used the `9139e2a` merge pin; they remain
separate receipts and are not relabeled. Native builds and GPU fixtures are
distinct from full-model inference:

- The broad model-free gate (`make -k check-fast`) passes. Its first attempt is
  retained as blocked: FlashStudy's ds4 engine held port 28000, so three
  launch/spawn targets correctly refused to start a second large process. The
  complete rerun passed after FlashStudy had closed; no test signalled it.
- On a private snapshot of the patched `0aaea5a` sources, upstream's model-free
  server/frontend and tool-parsing tests (`ds4_test --server`), Agent units,
  Qwen BF16 n-gram disk reads, Qwen Metal kernels (including byte-exact GDN
  prefill splits) and Qwen prefill-reuse specialization pass without weights.
  Upstream's `ds4_test --metal-kernels` fails 29 assertions on this M2 Max, with
  identical failing cases on pristine upstream. The checked compressor-store
  path is deliberately enabled only on M3/M5 and reports not applicable on M2,
  while the test requires it to run. This is retained as an upstream hardware
  assumption, not counted as a pass or attributed to DStudio's patches.
- All eight empty-profile first-launch stages pass using the relocated signed
  app, headless WebKit and real network source downloads/builds: main installs
  `0aaea5a`, Laguna `448d569` and Qwen3.6 its own pin. Both Qwen downloads route
  to main and cannot recreate the retired engine. Weight transfers are
  deliberately refused at the test boundary.
- All 20 native-consumer stages pass on the patched `0aaea5a` sources: Chat PLD,
  Agent, Cowork and Design builds, real tools with simulated model replies,
  Stop, stream handling and repeat build reuse. This is not a model quality score.
- Agent/Web/Chat patch lifecycle tests pass against exact new and historical
  source identities, including all eight server PLD inputs: repeat/partial/drift
  rejection and unrelated edits remain covered. Main's complete seven-patch
  native stack reverses without tracked-source loss.
- Sanitized native Qwen protocol/tool and session-reset tests pass with
  **simulated model responses**. Native snapshot cleanup passes all ten
  allocation failpoints on main without the retired patch.
- The larger upstream expert ceiling exposed a cold-scratch overflow. Lossless
  expert-ID storage reduces the buffer from 328,960 to 248,064 bytes, below its
  unchanged 256 KiB bound. An independent int32 oracle checks all 40,448 IDs,
  priorities, duplicates and invalid bounds under ASan/UBSan. This is a layout
  regression, not a throughput benchmark.
- Model-picker and Settings workflows pass in both WebKit and Chromium with a
  simulated engine, including retired-checkout repair, delayed switches,
  cancellation and errors. The Qwen Next Learn workflow also passes with a
  simulated engine.
- Actual browser helpers pass against main, Laguna and Qwen3.6, including
  screenshots, page recovery and retained-tab behavior in a real browser.
- The workspace GPU test earlier caught a missing path for main's new
  `dsv41.metal`: loading worked inside the engine directory but failed after
  Agent changed directory. The host now supplies that absolute shader path. All
  three active ds4 engines initialize Metal and pass 257 exact GPU additions from
  both their own directory and an unrelated workspace with spaces. The original
  failure is retained; no model weights are needed for this regression.
- The real downloader runs with tiny independently hashed payloads and simulated
  transport: correct repositories/revisions, one worker, corrupt/truncated data,
  interrupted transfers and existing-file reuse are checked.
- Design's transactional build passes 18 process/filesystem regressions with a
  simulated compiler. Native Design is also compiled; this does not enable Qwen
  Design or validate model-generated designs.

Besides the Qwen Next runs below, on September
28 an existing, fully SHA-256-verified DeepSeek V4.1 Q2 file ran on the patched
`0aaea5a` server with SSD expert streaming: **13/14** exact checks pass. The
same Python-trace answer as on `bd66c40` returns the correct `56` with unwanted
explanatory text; it remains a retained format failure. Its timings are not a
qualified or before/after speed comparison.

### Real Qwen Next Q4 inference on `0aaea5a` (September 29)

With the user's authorization, `Qwen3.8-Flash-Next-Q4.gguf` was downloaded from
the pinned revision and its complete SHA-256 verified by the native downloader.
The old local base + Q4_1 sidecar could not be used: the base has no
`per_layer_token_embd.weight` tensor, the sidecar stores Q4_1 `ple.weight`
under another architecture, and upstream's repack tool requires original BF16
n-grams. Runs use the resident backbone with BF16 n-grams read from SSD, expert
streaming off, one engine at a time on the M2 Max:

| Check | Result | Receipt |
| --- | --- | --- |
| Engine acceptance (arithmetic, JSON, Unicode, recall, 1.6K-token retrieval, code reasoning, errors, tools, SSE) | **12/12** | `engine-acceptance/run-rKUIL2` |
| Agent and Cowork file workflows, native CLI | **2/2** | `qwen38-agent-live/run-yk4Whe` |
| Agent and Cowork through the real DStudio host, including a rejected Design switch | **2/2** | `qwen38-host-live/run-TOoRRs` |
| Session reset lifecycle: visible prefill, cancellation keeps the prior conversation, real tool read after reset | **PASS** | `qwen38-host-live/run-7LZ7vF` |
| Private session preparation: cancellation at layers 0/1/4, 8,193-token prefill and 8 decode tokens bit-exact against normal sync | **PASS** on retry | `qwen38-prepare-live/run-l16SFC` |

The first preparation attempt (`qwen38-prepare-live/run-N7dXYg`) is retained as
FAIL: its probe still referenced the removed PLE option and did not compile.
That was a test defect, fixed before the retry; it was not a model result.
Claude reviewed every answer and saved artifact as an external judge,
separately from the deterministic checks: all quality items and both saved
files are correct and correctly formatted.

These are development workflows and small acceptance sets, not the 100-case
quality corpus, long-context qualification or a speed benchmark. Q2 was not
downloaded or tested. Numerical equivalence to a trusted model reference,
native desktop sessions, Design/vision support and non-Metal hardware are
**not qualified by these checks**. Earlier fork scores remain historical and
must not be reported as scores for these new weights.

Reproduce the scoped installation/workspace checks from the repository root:

```sh
make test-macos-bundle
make test-first-launch-e2e
make test-metal-workspace
node tests/integration/agent_native_build_test.mjs ds4
```

These checks require macOS Metal, the documented native build tools and browser
dependencies; first launch builds bundled engine sources with external network denied. They do not replace the
separate real-model acceptance gates.

See [the active WIP](WORK_IN_PROGRESS.md), [the admission matrix](engine-upstream.json)
and [test entry points](../tests/README.md). Missing release receipts remain
missing; this integration does not close the full project plan.
