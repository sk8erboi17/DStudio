# GLM 5.3 M2 Max source port — patch delivery

Date: 2026-09-05. Delivery is `glm53-m2max96-main.patch`, **not an applied
change** to `../ds4`. The user clarified the delivery format after the initial
direct port. All changes made by this pass to the destination sources were
reversed, checked byte-for-byte against the initial snapshot, and its normal
Metal executables rebuilt from those restored sources. Existing dirty source
changes, model links, DStudio derivative binaries and `.orig` files are retained.
No Git commit, checkout, reset, stash, clean, fetch or pull was performed.

Final restoration checks: all snapshotted source files match exactly; rebuilt
`ds4.o` and `ds4_metal.o` also match the saved baseline objects byte-for-byte.
The linked executable hashes differ, so binary byte identity is not claimed.
One unrelated untracked marker, `.ds4ui-server-pld-version`, disappeared during
the pass; none of this pass's commands targeted it. Its disappearance is recorded
rather than overwriting potentially concurrent application/user state. Final
system swap was 3775.06 MiB and pressure remained level 1; these are host-wide
observations, not proof of zero paging by individual tests.

## Target and application

- Source: `DStudio/ds4-glm5.3`, branch `glm53-m2max96-main`.
- Destination: `DStudio/ds4`, branch `main`.
- Both HEADs: `b0a147a7fba6d1a104d047d5a140e9bb4bfc13cd`.
- The patch is relative to the destination's **existing local DStudio changes**;
  it is not advertised as applying unchanged to every pristine upstream commit.
- SHA-256: `497f378a4aecb1ccb427358e06eed0eaf0a75ef27fd32b93d482da1f0eef93fa`.
- `git apply --check ../ds4-glm5.3/glm53-m2max96-main.patch`: PASS from the
  restored destination. No patch was applied after the delivery correction.

To inspect/apply later, from `DStudio/ds4`:

```sh
git apply --check ../ds4-glm5.3/glm53-m2max96-main.patch
git apply ../ds4-glm5.3/glm53-m2max96-main.patch
make -B -j2
make test-glm53-kda test-metal-stream-index
```

These commands rebuild the ordinary `ds4` and `ds4-server`. They do not rebuild
the parent application's separate `ds4-server-pld`, `ds4-agent-jsonl`,
`ds4-cowork` or `ds4-design` derivatives. PLD/speculation is outside this pass.

## Included changes and activation

| Change | Activation / DeepSeek impact |
|---|---|
| Cache-backed IQ2_XXS gate/up + Q2_K address-table decode | Exact Apple M2 Max, GLM53 288/top-8, 4096/2048/4096 shape and strides, one token, SSD streaming, single GPU, non-quality; generic fallback retained |
| Ordered resident-entry bitset for victim scans | Enabled by that exact GLM53 path only; **not newly enabled for DeepSeek** without end-to-end evidence |
| Q2 address consumer accepts validated 1..8 slots | Router order retained; fixed DeepSeek slots6 kernels unchanged |
| Short live-session resume | Exact GLM53/M2 Max/Q2/streaming, context allocation >=131072, 1..7 appended tokens; user override preserved; no DeepSeek crossover change |
| Small expert-membership bitsets and cold hotlist workspace | Shared host representation/allocation hardening, also usable by DeepSeek; no claimed DeepSeek throughput gain |
| Integrated GLM MTP static-map fix | Preserved correctness fix, not an MTP optimization; no MTP inference run |
| `DS4_BENCH_TOKEN_TIMING_FILE` | Optional buffered per-token CSV, disabled by default; useful with either model |
| Focused KDA link dependency | Adds missing `ds4_image.o`; fixes the reproduced undefined symbol |

Existing diagnostic rollbacks remain:
`DS4_METAL_DISABLE_M2_GLM53_TOP8_STREAM_ADDR`,
`DS4_METAL_DISABLE_STREAMING_EXPERT_ACTIVE_INDEX`, and
`DS4_METAL_DISABLE_M2_GLM53_SHORT_RESUME`.
The non-Apple device predicate returns false because that backend cannot be an
Apple M2 Max; it does not disable generic inference on other backends.

Patch contents: `.gitignore`, `Makefile`, `ds4.c`, `ds4_gpu.h`, `ds4_metal.m`,
`metal/moe.metal`, `ds4_bench.c`, `tests/test_metal_stream_index.m`.
Production source matches the optimized source tree except for preservation of
the destination's newer local-media log wording. `ds4.h`, `ds4_server.c`,
`ds4_cuda.cu`, `download_model.sh`, and repository instructions are not patched.

## Measured environment and scope

Apple M2 Max, 96 GiB; macOS details retained in `sw-vers.txt`. The current power
check reported **Battery Power, 76%, discharging**, not the earlier AC baseline.
Initial system swap was 3799.06 MiB, pressure level 1, free disk approximately
1.3 TiB. No OS settings or model files were changed. Compiler flags remain
`-O3 -ffast-math -g -mcpu=native -Wall -Wextra`, C99 / Objective-C ARC.
Builds used `make -B` to force recompilation without broad deletion of the
user's build outputs. CPU builds were compile-only, followed by Metal restore.

This is a source-port verification, **not a new inference-speed experiment**.
No new before/after model tok/s, first-token latency or memory/cache result is
claimed. GLM full residency at context allocation 131072 still lacks safe RAM
headroom; the previous no-SSD instruction was not silently overridden. A brief
bounded streaming live check was requested but not authorized during this pass.
No GLM inference/scorer, speculative decode or server listener was launched.

Historical evidence, not a result for the delivered patch: the source report
`PERF_GLM53_M2MAX96.md` records native raw decode, MTP disabled, automatic SSD
streaming, **7.46 tok/s median** (7.26..7.75), a 16-token raw prompt and
131072-token allocation. Its completed 100-case scorer records NLL
0.458046251, first-token match 89/100, mean greedy prefix 7.110.
Those values do not validate DeepSeek or full-resident GLM. Zero process swap
was not established by the older `ru_nswap` counter.

## QA actually performed on the candidate

| Gate / exact command | Result |
|---|---|
| `make -B -j2` baseline; `make -j2` port; `make -B -j2` final | PASS, no compiler warnings |
| `make -B cpu -j2`, then restore Metal | PASS, compile-only |
| `git diff --check` | PASS |
| Baseline `make test-glm53-kda` | FAIL, undefined `ds4_deepseek4_attention_bounds` |
| Candidate `make test-glm53-kda` | PASS after linking `ds4_image.o` |
| `make test-metal-stream-index` | PASS, actual private cache install/replace/clear, ordered batch/single victims, protected/inflight entries, address clear, device-name predicate, full-shape Q2 CPU oracle |
| ASan/UBSan build and execution of the new test | PASS, no sanitizer diagnostics |
| `./ds4_test --server` | PASS, model-free parsing/rendering tests |
| `./tests/test_layer_pack` | PASS, 97/97 |
| `./tests/test_engine_mgpu_placement` | PASS, 109/109 synthetic checks, not physical multi-GPU validation |
| `./tests/test_gpu_args`; `./tests/test_gpu_args_cli.sh` | PASS; CLI 88/88 |
| `./tests/test_prompt_prefix`; `./tests/test_sampling`; `./tests/test_deepseek4_vision_image` | PASS, model-free |
| Q4_K/MXFP4 dot, extractor self-tests, `./ds4_agent_test` | PASS during baseline `make test` |
| `make test` full suite | NOT COMPLETED: stopped when default `ds4flash.gguf` resolved to an experimental DeepSeek Vision model and the snapshot gate began GPU initialization; exit 143, no inference result accepted |
| `./ds4_test --metal-kernels` | FAIL, 29 assertions, reproduced with saved pre-port engine/Metal objects |
| Official GLM/DeepSeek scorer for this delivered patch | NOT RUN — no newly authorized large-model matrix |
| Live multi-turn CLI, SSD warm/cold, performance A/B, full logits/snapshot/boundary, native session batch | NOT RUN — model-mode/safety gates remain open |
| MTP/PLD, vision inference, CUDA/ROCm/distributed/TP/RDMA | NOT RUN — outside scope / hardware or permission unavailable |

The first new-cache-test attempt failed because its fixture had not enabled the
synthetic streaming-cache mode, so the configured budget was inactive. Only the
fixture was corrected; no assertion or production fallback was weakened.
The final test performs 1152 install/replace operations and compares the actual
batch/single victim sequence to the matrix fallback. The index occupies 3840
bytes. Q2 tests use 2048x4096 expert tensors, counts 1/2/6/7/8, nonascending IDs,
nonuniform per-slot inputs, duplicate IDs, invalid-ID/null-address kernel guards,
and host rejection of counts 0/9. Guard tests are not session error-atomicity
oracles and are not claimed as such. Synthetic payload memory is tens of MiB,
not a huge model.

The general Metal failures have exactly the same assertion locations/counts
before and after porting. The compressor fused-path test demands success on M2
although the unchanged implementation explicitly restricts that path to M3/M5.
The other failures are in gathered KV staging. They were not hidden by changing
tests or capability predicates. Full release QA is **not** green.

## Artifacts and remaining gates

All current logs, source backups and both tested builds:
`/tmp/ds4-glm-port-main.lLj0t0`.

- `target-sources-before.tar.gz`: exact destination source snapshot.
- `target-baseline-build.tar.gz`, `ported-build-tested.tar.gz`: baseline and
  candidate objects/binaries, including the corresponding routed shader.
- `build-metal-target-baseline.log`, `build-metal-port.log`,
  `build-cpu-compile-only.log`, `build-metal-final-restored.log`.
- `build-metal-target-restored-original.log`: restored destination build.
- `kda-baseline.log`, `kda-port.log`, `kda-final.log`.
- `metal-stream-index-final.log`, `stream-index-sanitizer-build.log`,
  `stream-index-sanitizer.log`.
- `metal-kernels.log`, `metal-kernels-baseline.log`: both 29-failure reports.
- `make-test-baseline.log`, individual model-free gate logs, initial/final
  status, hashes and environment captures.

No new inference CSV was produced. Existing source timing artifacts:
`/tmp/glm53-m2max96-topology-pass5.2ImgG5`; completed source scorer artifacts:
`/tmp/glm53-m2max96-qklow-pass6.SCufLP`.

Decision: package the existing optimized GLM implementation and its focused
regression test, leave the destination unapplied. Do not enable the active-index
optimization for DeepSeek solely from a cache micro-test: it still needs a safe,
same-checkpoint native A/B and quality check. No new performance experiment was
retained or claimed in this port.
