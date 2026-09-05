# GLM 5.3 Flash Q2 — M2 Max 96 GB performance report

Publication note: personal absolute paths use `$DSTUDIO_ROOT` (project root)
and `$USER_HOME` (user directory) below. Measurements and hashes are unchanged.

> Memory-evidence correction (pass 6): historical “zero process swaps” entries
> based only on `/usr/bin/time -l` preserve that tool's reported value, **not a
> proof of zero disk paging or zero compression**. The current macOS SDK marks
> `ru_nswap` as NU, and `vmmap`/`footprint` group compressed/swapped storage in
> their swapped column. Future gates use direct task VM ledgers, system swap
> counters, pressure and footprint together; see the pass-6 memory audit below.

> Artifact recheck (2026-09-05): the historical pass-2 directory
> `/tmp/glm53-m2max96-native-pass2.mItgnW` is no longer present. Its old
> measurements below are retained as historical report entries, not freshly
> revalidated raw evidence. In particular its coding/reasoning route traces
> cannot currently serve as held-out validation. The current-main port and
> passes 5, 6 and 7 artifact directories are present. Do not infer that every
> historical `/tmp` link in this document remains available.

> Current-main quality update (2026-09-05): the full 100-case baseline has
> completed with exit 0: NLL `0.458046251`, first-match `89/100`, mean greedy
> prefix `7.110`. See the final pass-7 results below. The unguarded Metal I/O
> candidate failed the short-source test and was not integrated into `ds4`.

## Environment

- Date: 2026-08-30 through 2026-09-05 (Europe/Rome).
- Host: MacBook Pro `Mac14,6`, Apple M2 Max, 12 CPU cores, 38-core
  integrated Apple GPU, 96 GB unified memory.
- OS: macOS 26.5.2 (25F84), Darwin 25.5.0.
- Repository: the task began on `glm-5.3-flash` at
  `767e517639b8c9df6c36530d212c4ddf87c247a6`, was updated first to
  `6cf658a4da3fc20f4f6717f05746d44a3823cdde`, then migrated after GLM 5.3 was
  merged upstream. The current worktree is branch `glm53-m2max96-main`, based
  exactly on `origin/main` at
  `b0a147a7fba6d1a104d047d5a140e9bb4bfc13cd` (ahead/behind `0/0`). A separate
  user worktree already owns the local branch name `main`; it was deliberately
  left untouched. The final source patch remains uncommitted.
- Initial tree: dirty before this task. Its exact patch is retained as
  `/tmp/glm53-m2max96-20260830-190934/working-tree-before.patch`; the
  byte-identical upstream integration was independently verified in
  `git-pull.log` and `upstream-integration.patch`. No unrelated edit is
  attributed to this optimization. The second pre-main migration patch is
  `/tmp/glm53-main-migration.W8oL8J/working-tree-before-main.patch`.
- Model:
  `$DSTUDIO_ROOT/ds4/gguf/GLM-5.3-Flash-Q2.gguf`,
  96,505,816,384 bytes (89.87 GiB), SHA-256
  `e81fd6241c6e55a64e1e14e47a3eab61a173fa8d7e4b5c1d1848827119705b32`.
- Free space at start: about 1.5 TiB on the working volume.
- Build flags: `-O3 -ffast-math -g -mcpu=native -Wall -Wextra -std=c99`;
  Metal and Foundation frameworks on Apple Silicon.
- Historical first-scored top-8 binary SHA-256:
  `a18e6927de8c205a12d2589eb811319cfce1f042e4d31bb24a9f1abb756c7773`
  (`ds4`, 2,204,240 bytes). The official scorer binary SHA-256 was
  `c822d60d1d6593f8a73564295432b45288d93c5c1f59dfe5b613616514143e72`.
- Final 2026-09-04 main-port binaries: `ds4`
  `6973d76e0f1e42143e93f567061ebd555140d7720fb6ad19dde6c3fda69ca10d`;
  `ds4-bench`
  `4147de1d864832c48883a9bdac95c48797760ea2a67b95c74677e0c5881bf929`;
  `ds4-server`
  `44acd16f8c6b29220f872bd916adf20ba545d62e1523ec94deaf4a94ee1c0081`.
- Every full-model run allocated at least 131072 context tokens. Principal
  flags were `--metal --ssd-streaming --ctx 131072`, or the benchmark
  equivalent `--ctx-alloc 131072`.
- Automatic/final cache policy: 12.00 GiB routed allowance, divided into
  3.80 GiB prefill/full-layer headroom and an 8.20 GiB dynamic cache of 1244
  experts at 6.75 MiB each. Current main reports a 24.86 GiB planned
  128K-context footprint: 1.46 GiB compact KV, 3.16 GiB fixed buffers,
  8.24 GiB global non-routed decode map, 8.20 GiB dynamic cache, and 3.80 GiB
  prefill reserve. The older 17.25 GiB report counted only the initial 0.63 GiB
  token-embedding map rather than the complete non-routed decode map; the
  underlying selected-expert fast path did not become 7.61 GiB larger in this
  migration. No larger manual cache was admitted because this is the runtime's
  GLM cap.

## Baseline diagnosis

Observed bottleneck:

The GLM 5.3 Q2 layout uses 288 routed experts and router top-k 8, with
IQ2_XXS gate/up and Q2_K down tensors. The Metal SSD selected-expert consumer
was admitted only for six experts. Host code therefore populated the selected
cache but decode still mapped and executed the generic full routed tensors.
On the 89.87 GiB model this caused whole-routed-model page traffic on every
ordinary decode token.

Evidence:

- Existing DwarfStar map, selected-cache, `pread`, stage-timing, and memory
  counters were used with `vm_stat`, `memory_pressure`, and `iostat`. No
  conclusion was inferred from whole-process CPU utilization.
- The baseline decode-static map covered 92027.47 MiB. The retained selected
  address path maps 8436.14 MiB of non-routed/static decode spans; routed
  tensors are supplied by exact selected cache entries.
- In the controlled 32-slot, two-token profile, baseline selected loading had
  664 misses, 4.38 GiB requested, 62.63 s in `pread`, and the generic mapping
  additionally paged the routed model. The retained path had 672 misses,
  4.43 GiB requested, 278.502 ms in `pread`, and 1.596 s total selected-read
  synchronization, with no full-routed paging.
- On the current upstream plus the user's initial edits, three automatic-cache
  measurements gave a median first-token latency of 31,947.516 ms, median wall
  time of 97.66 s, and a rounded steady rate of 0.03 token/s for two generated
  tokens at a 128K allocation.
- The final 16-token automatic-cache trace recorded 3006 hits, 2370 misses,
  15.62 GiB explicit reads, 872.436 ms total `pread`, 2.452 s selected-read
  synchronization, and a 55.9% hit rate. Its useful split-overlap counter was
  zero; no SSD/GPU overlap improvement is claimed.
- Baseline and final model processes reported zero process swap operations.
  During the long MTP snapshot, system swap was already 13.06 GiB and remained
  unchanged across samples; `memory_pressure` reported 74% free and zero
  throttled pages.
- A second profile targeted the interactive `processing 7 input tokens` case.
  GLM 5.3 used the two-token batch crossover inherited from M5 Max/GB10.
  The 7-token append consequently remapped full routed layers, populated none
  of the 8.20 GiB bounded decode cache, and ran at 0.18--0.24 token/s. The
  exact one-token path populated only router-selected experts and reached a
  three-run median 2.42 token/s for the same 20-to-27-token append.
- In the cache-backed 8-token diagnostic, the second append had 1,737 hits and
  951 misses (64.6% hit rate), read 6.27 GiB, and spent 1.163 s in selected-ID
  synchronization. The batch control kept the dynamic cache at zero entries
  and retained 87.75 GiB of mmap wrapper spans. Eight tokens were not retained:
  its `0.001106382` maximum full-logit delta exceeded the current `0.001` gate.

Affected phase/context:

Single-token ordinary decode, other top-8 IQ2/Q2 one-row calls, and live-session
appends of at most seven tokens on the exact target. Initial and larger batch
prefill are unchanged. Integrated MTP target verification uses a two-row target
path and therefore remains slow; MTP was disabled throughout the native follow-up
pass.

Expected upper bound:

The removable cost was the repeated routed-model paging, not just the explicit
selected `pread`. The measured upper bound was established by immediate
end-to-end reruns rather than by summing isolated timers.

Correctness surface:

Router-selected expert identity, IQ2 gate/up binding, Q2 down accumulation,
address-buffer and cache-entry lifetime through command completion, complete
logits, MTP static-weight mapping, and authoritative session publication.

Smallest candidate change and fallback:

Use the existing selected-address cache and pair-SwiGLU/Q2 sum kernels for one
exact M2 Max/GLM 5.3 Q2 top-8 shape. All other devices, shapes, quality mode,
TP modes, batches, empty-cache cases, and an explicit disable environment
variable retain the previous generic path.

## Experiments

### Top-8 selected address tables without a top-8 down consumer — reverted

- Intended mechanism: exclude full routed tensors and feed eight selected
  entries through existing address tables.
- Result: static mapping fell to 8436.14 MiB, but decode failed closed because
  `direct_down_sum` did not admit top-8 on one device. No token was published.
- Decision: reverted before the next experiment.

### Skip selected-cache preparation — reverted

- Intended mechanism: remove selected reads that appeared unused by the old
  fallback.
- Result: Metal returned
  `kIOGPUCommandBufferCallbackErrorOutOfMemory`; no token was published. The
  reads had also been providing page residency to the generic full map.
- Decision: reverted completely.

### Increase selected-read workers from 9 to 18 — reverted

- Intended mechanism: expose more random reads to the internal SSD.
- Result: an apparent first-run improvement disappeared on repetition;
  identical 4.38 GiB workloads spent 62.63 s versus 62.22 s in `pread`, a 0.7%
  difference. End-to-end variance erased the gain.
- Decision: reverted completely; no worker-count source change remains.

### Sort at most 24 selected reads by GGUF offset — reverted

- Intended mechanism: make gate/up/down reads more sequential.
- Result: `pread` wait increased from 62.63 s to 64.09 s and wall time from
  97.89 s to 100.26 s.
- Decision: reverted completely; the existing inter-tensor concurrency is
  better on this SSD.

### M2 Max GLM 5.3 top-8 address consumer — retained

- Code area: `ds4.c`, `ds4_gpu.h`, `ds4_metal.m`, `metal/moe.metal`.
- Mechanism: admit the GLM selected cache for this exact layout, bind its
  existing address tables to fused IQ2 gate/up and Q2 down, and use the
  validated `nei0` value (1..8) as the Q2 slot-loop bound. The six-slot fixed
  kernel is unchanged.
- Activation predicate: exact Metal device name `Apple M2 Max`; SSD streaming;
  non-resident, non-quality, one-token, single-device call; 288 total and eight
  selected experts; dimensions 4096/2048/4096; IQ2_XXS gate/up and Q2_K down;
  exact row/expert byte strides; no additive TP input; non-empty address cache;
  and absence of `DS4_METAL_DISABLE_M2_GLM53_TOP8_STREAM_ADDR`.
- Correctness risk: the Q2 down sum now consumes eight cache addresses. The
  host bounds both the entry count and `nei0` by the existing eight-entry
  maximum, and entries remain in-flight until GPU completion.
- Result: retained. The three-run median first token improved 93.87%, median
  end-to-end wall time improved 59.38%, all selected tokens matched, and the
  largest 4095..4100 full-logit delta was `1.7357e-4`, below the documented
  `0.001` Metal comparison tolerance.

### Streaming MTP static map — retained correctness fix

- The integrated nextn block runs before ordinary target decode installs its
  static decode map. Once routed tensors were no longer broadly mapped as a
  side effect, MTP failed closed at `enorm`.
- `glm_graph_mtp_step` now prepares the immutable non-routed static decode spans
  before nextn execution; routed experts remain cache-backed. Failure returns
  before session publication.
- Greedy and exact-sampling MTP then completed with target-verified ACCEPT
  cycles. This is a necessary correctness fix, not a performance claim.

### Automatic versus bounded small cache — automatic retained

- A 32-slot diagnostic avoided large cache residency but had zero hits and 672
  misses over two generated tokens. It measured median first-token latency
  1.555 s and median steady rate 3.43 token/s in the focused two-token sweep.
- Automatic cache reached 55.9% hits over the longer 16-token agent-like run
  and 5.91 steady token/s when warm. It remained bounded and did not cause
  process swap. Automatic remains the production configuration; cache-32 and
  `--ssd-streaming-cold` remain diagnostics only.

### Resident-entry victim index — retained

- Hypothesis: global victim selection scanned all 60 x 512 possible cache
  cells although only about 1,244 entries were live.
- Code area: `ds4_metal.m`. A 3,840-byte active-entry bitset is maintained on
  install, clear, and eviction. Ordered set-bit iteration preserves the old
  layer-major/expert-major tie-break exactly. The generic matrix scan remains
  behind `DS4_METAL_DISABLE_STREAMING_EXPERT_ACTIVE_INDEX`; a debug invariant
  checker compares the bitset, matrix, and live-entry count.
- Profile: visited entries fell from 30,720 to 1,244 per victim scan and total
  scan time from 675.306 to 200.989 ms in the contemporaneous decode trace.
- Controlled 128-token A/B medians: steady decode 5.648 to 6.155 token/s
  (+8.98%); p50 latency 159.825 to 149.622 ms (-6.38%); p95 245.782 to
  232.318 ms (-5.48%); wall 55.10 to 52.80 s (-4.17%). Process swap was zero.
- Decision: KEEP. No cache policy, victim comparator, expert order, or tensor
  content changed.

### Cached/missing split extension to top-8 — reverted

- Intended mechanism: overlap SSD reads with already-resident expert compute
  using the existing split scheduler.
- Result: the profile reported `split_layers=0`; after router readback the
  required live command-buffer precondition was not available, so the candidate
  never activated. Source was restored byte-identically before the next test.
- Decision: REJECT; no split-path source change remains.

### Generic batch selected-address top-8 prefill — reverted

- Intended mechanism: load the unique experts selected by a tiny batch instead
  of mapping every routed layer. The first safe fail-closed run exposed that a
  resource-lifetime list had a 49-entry batch cardinality while the kernel
  router cardinality remained eight; the diagnostic bound was corrected only
  for the experiment.
- Result: two 8-token frontiers remained at 0.23 token/s versus the 0.24
  token/s batch control despite much less I/O. The 64 token-expert-pair matrix
  work dominated at this small row count.
- Decision: REJECT; the eligibility and temporary lifetime-bound edits were
  removed completely.

### M2 Max cache-backed short session resume — retained

- Hypothesis: the GLM 5.3 live-session batch crossover of two tokens was tuned
  on M5 Max/GB10 and is wrong for M2 Max Q2 SSD streaming. A tiny batch maps the
  routed model but does not seed the bounded decode cache.
- Code area: `ds4.c`. For the exact M2 Max, GLM53, 288/top-8,
  IQ2_XXS-gate/up plus Q2_K-down, single-GPU SSD path with at least 128K
  allocated context, append lengths 1 through 7 use the trusted serial
  cache-backed path. The existing environment override retains authority, and
  `DS4_METAL_DISABLE_M2_GLM53_SHORT_RESUME` restores the old batch crossover.
- Exact A/B command shape (MTP absent):

  ```sh
  ./ds4-bench -m "$MODEL" --metal --ssd-streaming \
    --prompt-file speed-bench/promessi_sposi.txt \
    --ctx-start 20 --ctx-max 27 --ctx-alloc 131072 --step-incr 7 \
    --gen-tokens 0 --dump-frontier-logits-dir "$LOGITS" --csv "$CSV"
  # Fallback A/B adds:
  DS4_METAL_DISABLE_M2_GLM53_SHORT_RESUME=1
  ```

- Performance: the exact 20-to-27-token append measured 0.18 token/s through
  the fallback and candidate runs of 1.73, 2.42, and 3.01 token/s (median
  2.42, min/max shown because cache and system state vary). Against the faster
  0.24 token/s repeated batch control this is about 10.1x.
- Correctness: frontier-27 argmax was `554` on both paths; all 154,880 logits
  were finite; maximum absolute delta was `0.000214517`, top-eight maximum
  `0.0001211`, inside the `0.001` Metal batch contract. Frontier 20 was
  bit-identical. The tested eight-token form was rejected, not hidden, because
  its maximum delta was `0.001106382`.
- Memory: the candidate uses the already planned dynamic cache (about 7.9 GB
  maximum RSS in this short run) and recorded zero process swaps. One exact
  fallback run expanded system swap from 8.60 to 18.00 GiB while walking the
  broad map; no additional fallback repetitions were run after that safety
  signal. `memory_pressure` subsequently reported 95% free and zero throttled
  pages.
- Decision: KEEP at seven tokens only.

## Final patch

Task-owned source changes, relative to the exact new-upstream + initial-user
baseline, are:

- `ds4.c`: exact top-8 selected-cache admission for GLM 5.3/M2 Max; exact
  seven-token live-resume crossover; CPU-only compile fallback; pre-MTP static
  non-routed map preparation.
- `ds4_gpu.h`: M2 Max device predicate declaration and non-Apple stub.
- `ds4_metal.m`: exact device detection, full activation predicate, top-8
  selected-address binding, checked 1..8 Q2 address encoder bound, and the
  ordered resident-entry bitset used by victim scans.
- `metal/moe.metal`: use validated `args.nei0` for the address-table Q2 sum
  loop; fixed six-slot kernels are untouched.
- `ds4_bench.c`: opt-in per-token timing CSV written outside the decode loop;
  the default benchmark path performs no extra formatting or output.
- `PERF_GLM53_M2MAX96.md`: this report.

No public engine/session API changed, no per-token Objective-C object,
formatting, lock, or pipeline lookup was introduced. The only persistent new
cache metadata is a 3,840-byte bitset. The static map shrinks by about 81.6 GiB
of mapped tensor spans on the target decode path; those spans were mmap views
rather than copied resident bytes. Explicit disable variables and all
nonmatching predicates retain the generic paths.

## Before/after performance

The primary decode figures are one excluded warm-up plus three measured runs,
same prompt bytes, two generated tokens, automatic cache, 128K allocation, and
current upstream. CSV rates round the 31-second baseline to 0.03 token/s.

| Workload | Context allocation / live context | Cache mode | Baseline | Final | Change | First-token | Peak footprint / process swap |
|---|---:|---|---:|---:|---:|---:|---|
| Short prefill | 128K / 0→2K | auto streaming | 39.13 t/s | 46.36 t/s | +18.5% observed; patch inactive | n/a | 5.055→5.057 GB / 0 |
| Interactive continued prefill | 128K / 20→27 | auto streaming | 0.18 t/s exact fallback; 0.24 repeated batch control | 2.42 t/s median (1.73–3.01) | about 10.1x vs 0.24 control | n/a | 0.244→7.93 GB max RSS / 0 process swap |
| Continued prefill | 128K / 4K→6K | auto streaming | 38.45 t/s | 36.82 t/s | -4.2%; within 5% rule, patch inactive | n/a | same matrix / 0 |
| Medium prefill | 128K / 6K→8K | auto streaming | 37.91 t/s | 37.12 t/s | -2.1%; patch inactive | n/a | same matrix / 0 |
| Medium prefill | 128K / 10K→12K | auto streaming | 37.67 t/s | 37.49 t/s | -0.5%; patch inactive | n/a | same matrix / 0 |
| Ordinary decode, 3-run median | 128K / 16 | auto streaming | 0.03 steady t/s; 97.66 s wall | 3.23 steady t/s; 39.67 s wall | >100x rounded steady; -59.38% wall | 31,947.516→1,958.091 ms (-93.87%) | 8.675→8.995 GB / 0 |
| Ordinary decode, longer trace | 128K / 16 | auto streaming | n/a | 3.84 total, 5.56 steady t/s | diagnostic | 1,464.370 ms | 13.513 GB / 0 |
| GLM greedy MTP | 128K / 33 | auto streaming | verifier failure, invalid performance comparison | 0.06 t/s, two ACCEPT cycles | correctness restored; slower than ordinary | verify2 31.56/32.37 s | 9.283 GB / 0 |
| GLM exact-sampling MTP | 128K / 27 | auto streaming | ordinary control 1.19 t/s | MTP 0.07 t/s | -94.1%; do not enable for speed | verify2 28.696 s | 9.283 GB / 0 |
| Winning production cache | 128K / 16 | automatic 1244 slots | old full-map 0.03 steady t/s | warm trace 5.91 steady t/s, 55.9% hits | selected-address path retained | 920.299 ms in warm trace | 13.513 GB / 0 |

Large batch-prefill variation is reported, not claimed: the top-8 kernel
specialization still requires `n_tokens == 1`. The retained session scheduling
change affects only exact 1..7-token live appends; 8-token and larger prefill
continues to use the previous batch path. At 6K–12K all changes remained within
5%.

## Boundary, quality, and state evidence

- Tokenizer-backed frontiers ended at exactly 4095, 4096, 4097, 4098, 4099,
  and 4100 rendered tokens with a 131072 allocation.
- Baseline/final argmax IDs were respectively `325, 264, 650, 19501, 459, 11`
  in both builds; all logits were finite.
- The fresh 4095 prefill logits were byte-identical. Incremental 4096..4100
  maximum absolute deltas were `5.615e-5`, `1.0073e-4`, `6.747e-5`,
  `1.3542e-4`, and `1.7357e-4`; every value is below `0.001`.
- The actionable prompt was tokenizer-verified at 5207 tokens before the final
  instruction and 5233 after it. Output was exactly `BOUNDARY_OK`.
- Ordinary snapshot across that prompt passed top-eight logits before and after
  continued decode at `1e-6` tolerance.
- Snapshot + integrated MTP passed 16 replay cycles (10 single, 6 double, 22
  committed tokens), sync-back, and four reuse cycles (3 single, 1 double).
- The retained 7-token resume differential compared all 154,880 frontier
  logits: same argmax, finite values, maximum absolute delta `0.000214517`.
  The 8-token candidate exceeded `0.001` and was narrowed before retention.

## QA matrix

- **PASS** — warning-clean Metal build:
  `make clean && make`; logs `build-metal-final.log` and follow-up
  `/tmp/glm53-m2max96-short-prefill/short-resume-final-build-metal-restored.log`.
- **PASS** — warning-clean Metal restore after CPU build:
  `make clean && make`; log `build-metal-final-restored.log`.
- **PASS** — CPU compile-only, no model inference:
  `make clean && make cpu`; logs `build-cpu-final.log` and follow-up
  `/tmp/glm53-m2max96-short-prefill/short-resume-final-build-cpu.log`.
- **PASS** — `git diff --check`; log `git-diff-check-final.txt`.
- **PASS** — `make test-glm53-kda`; log `test-glm53-kda-final.log`.
- **FAIL** — bare `make test`: all targets compiled, including the
  `DS4_NO_GPU` placement object, then the aggregate `./ds4_test` attempted the
  absent default `ds4flash.gguf`. The exact Q2 was not copied/renamed and the
  unsafe aggregate model run was not forced. Log `make-test-final-rerun.log`.
  Model-free `./ds4_test --server`, eval extractor, agent, Q4_K, and MXFP4
  subtests passed.
- **PASS** — follow-up `make test-glm53-kda`; log
  `/tmp/glm53-m2max96-short-prefill/short-resume-retained-kda.log`.
- **FAIL — missing default artifact, not a test regression** — follow-up
  `make test`: all model-free targets and the `DS4_NO_GPU` object compiled and
  passed, then bare `./ds4_test` could not open unprovided `ds4flash.gguf`.
  The user's Q2 file was not copied or renamed. Log
  `/tmp/glm53-m2max96-short-prefill/short-resume-retained-make-test-r2.log`.
- **NOT RUN — baseline unavailable** — official 100-case scorer before the
  patch. No claim is made that a local baseline scorer passed; the old path's
  repeated full-routed paging was diagnosed before a complete 100-case run.
- **PASS** — official 100-case scorer on the retained top-8 build, before the
  later cache-index and short-resume scheduling edits, exact command:
  `score_official MODEL manifest.tsv glm53-q2-final.tsv 131072 --ssd-streaming`.
  Exit code 0; 100 cases and 11,559 target tokens; average NLL
  `0.459185213`, first-token match `89/100`, average greedy prefix `7.110`.
  The documented Q2 reference is `0.458030488`, `89/100`, and `7.37`, while
  the accepted compact-Metal control is `0.458177271`, `90/100`, and `7.390`.
  The local NLL is 0.252% above the reference, with the same first-token count,
  and remains in the repository's accepted Q2 band. The process recorded zero
  swaps, 8.9936 GB maximum RSS, and 13.5609 GB peak footprint. Artifacts:
  `glm53-q2-final.tsv` and `glm53-q2-final-score.log`.
- **PASS** — exact 4095..4100 frontiers, selected tokens, finite logits, and
  complete-logit tolerance; artifacts `final-boundary-4095-4100.csv`,
  `final-boundary-logits/`, and `boundary-logit-deltas.jsonl`.
- **PASS** — post-4096 actionable exact-output task; logs
  `final-post4096-boundary-ok.stdout` and `.stderr`.
- **PASS** — streaming snapshot at 128K; command uses
  `DS4_TEST_SSD_STREAMING=1`, the 5233-token prompt, and
  `DS4_TEST_SNAPSHOT_CTX=131072`; log `final-session-snapshot.log`.
- **PASS** — post-resume-change streaming snapshot at 128K, MTP disabled;
  log `/tmp/glm53-m2max96-short-prefill/retained-snapshot.log`, zero process
  swaps and 9.15 GB peak footprint.
- **PASS** — same snapshot with `DS4_TEST_GLM_MTP=1`; log
  `final-session-snapshot-mtp.log`.
- **PASS** — ordinary greedy MTP comparison and exact-sampling MTP comparison;
  byte-identical generated output against their ordinary controls.
- **NOT RUN — unsafe harness** — `make test-metal-session-batch` with the Q2.
  `tests/test_metal_session_batch.c` does not expose SSD-streaming engine
  options and uses resident Metal sessions. Forcing two/four Q2 sessions would
  violate the 96 GB admission constraint. This patch does not affect native
  batch (`n_tokens == 1` exact predicate).
- **PASS** — SSD automatic repeated prompt, one 32-slot diagnostic, and one
  explicit `--ssd-streaming-cold` diagnostic. Cold: 16.5% hits, 3.70 GiB live,
  8.993 GB peak footprint, zero process swap. Generic fallback disable run:
  24,038 ms first token and 0.03 steady token/s, zero process swap.

- **PASS** — server unit harness `./ds4_test --server`.
- **PASS** — local OpenAI chat server smoke on changed port only:
  `--host 127.0.0.1 --port 18081 --ctx 131072 --ssd-streaming`; `/v1/models`
  returned 200 and the chat response was exactly `OK`. The server was shut down
  cleanly and did not remain listening.
- **NOT RUN — not affected** — Responses, Anthropic, SSE, tool-transition, and
  disconnect full-model server smokes. Server/protocol code is not part of the
  task-owned patch.
- **NOT RUN — hardware unavailable / no remote permission** — CUDA, ROCm,
  distributed, TP, and RDMA. Shared signatures were inspected; CPU compiled.
- **NOT APPLICABLE** — vision, quantization generation, model download, and
  model movement. None was modified or performed.

The official 100-case scorer was completed on the retained top-8 build before
the cache-index and short-resume edits. The index preserves the exact victim
comparator/order, and the resume edit is inactive for the scorer's initial
prefill and one-token target-eval calls. It was not rerun because the previous
complete run consumed several hours and the task requires permission before
launching another many-hour matrix. This distinction is recorded rather than
describing the prior artifact as a new post-edit run.

## Remaining measured risks and next work

- Integrated MTP verification still takes about 29–32 seconds per two-token
  target block and is a net loss versus ordinary one-token selected-address
  decode on this M2 Max. Any future work must profile and specialize the
  two-row target verifier without weakening target authority.
- The final automatic-cache trace still spent 2.452 s synchronizing selected
  loads across 16 generated tokens and reported no useful split overlap. A
  future overlap change is justified only if buffer lifetime and target logits
  remain within the same oracle.
- No sparse native-batch claim is made. The repository's ordered fallback
  remains required above the dense frontier.
- Initial short prefill remains batch-bound (0.56--0.77 token/s in the small
  observed prompts). The retained change targets only a live append of at most
  seven tokens. The rejected selected-address batch experiment showed that
  extending the current batch kernel is not the next useful optimization;
  a new profile would need to isolate its 64 token-expert-pair compute floor.

## Read-only comparison with `origin/main`

This comparison was requested while the final scorer was running and did not
modify or check out `main`. At inspection time `origin/main` was
`8db89fe083ae4d17c9a2428ccd29803d3ae8f577` (`download: add GLM 5.3 Flash
models (#888)`). Its runtime and README still define DeepSeek V4 and GLM 5.2;
the commit adds GLM 5.3 release artifacts to the downloader but does not add a
GLM 5.3 runtime shape or variant.

DeepSeek V4 Flash and Pro select six routed experts. `origin/main` already has
the matching Metal SSD decode machinery: selected-expert cache preparation,
the fused IQ2 pair-SwiGLU route, a direct Q2 top-6 sum, and six-slot kernels.
The retained patch in this branch instead repairs a GLM 5.3 top-8 shape and
its integrated-nextn static mapping. Those changes are not applicable to
DeepSeek V4's top-6 router or its separate DSpark path. `origin/main` does not
have the exact `Apple M2 Max`/GLM-top-8 predicate, but the inspected DeepSeek
path does not need it. No missing DeepSeek V4 optimization was inferred from
this GLM profile, and no change was applied to `main`.

## Retained artifacts

All raw environment, Git-integration, build, test, profile, CSV, full-logit,
memory-pressure, `vm_stat`, `iostat`, scorer, MTP, snapshot, and server artifacts
are retained under:

`/tmp/glm53-m2max96-20260830-190934`

The native-decode active-index A/B artifacts are under
`/tmp/glm53-m2max96-native-pass-20260830-234025`; short/continued-prefill
profiles, rejected candidates, full-logit dumps, build logs, snapshot, and the
retained three-run matrix are under
`/tmp/glm53-m2max96-short-prefill`.

## Native-decode pass 2 — 2026-08-31

This addendum supersedes the earlier statement that the scorer had not been
rerun after the cache-index and short-resume changes. The full scorer was run
on the final pass-2 source. Every performance number below is **native raw
decode, MTP disabled**, with a 131072-token allocation.

### Environment and final identity

- Same Apple M2 Max, 38-core GPU, 96 GB unified-memory host and model recorded
  above. Model SHA-256 remains
  `e81fd6241c6e55a64e1e14e47a3eab61a173fa8d7e4b5c1d1848827119705b32`.
- Branch `glm-5.3-flash`, base/final HEAD
  `6cf658a4da3fc20f4f6717f05746d44a3823cdde`; the work is an uncommitted local
  specialization and the user's unrelated dirty-tree files were preserved.
- Final restored Metal `ds4` SHA-256:
  `6719a37d5aa7ac6794a433fcaf0e2abfba7c87b867af4b2b8da2a6f25b2a023a`.
- Production cache remains automatic: 12.00 GiB routed budget = 3.80 GiB
  prefill reserve + 8.20 GiB dynamic cache, 1244 expert slots. Planned memory
  at 128K remains 17.25 GiB.

### Critical-path measurement and floors

The controlled 32-token profile separated a 7175.568 ms GLM streaming critical
path into 5507.305 ms early selected-load/boundary work (172.10 ms/generated
token), 1634.732 ms routed compute (51.09 ms/token), 31.300 ms shared-expert
submission, and 2.144 ms post work. This is a dependency timeline; the numbers
must not be added to independent SSD aggregate time a second time.

The 128-token automatic-cache profile recorded 30,003 hits, 13,005 misses
(69.8%), 85.73 GiB read, 5104.165 ms aggregate `pread`, 15,375.043 ms selected
sync, and 3707.752 ms cache/bind work. The larger-cache control below proves
that removing SSD bytes alone does not remove the selected-ID boundary.

The six-token all-hit diagnostic preseeded 1134 trace-selected experts (7.48
GiB) without changing router output. Across two release runs, stable token
indices 2..5 had median 92.229 ms and p95 108.111 ms: an observed all-hit floor
of 10.84 tok/s at p50 and 9.25 tok/s at p95. The measured routed kernel stage
at layer 42 was approximately 0.4--0.8 ms gate/up, 0.28--0.48 ms down, and
0.03--0.08 ms activation/reduction. Therefore 40 raw tok/s (25 ms/token) is not
attainable by cache tuning alone on this path; both per-layer boundary and
Metal/non-MoE compute remain above that budget.

| Component | p50/equivalent ms/token | p95/equivalent | Serial on current path | Removable evidence |
|---|---:|---:|---|---:|
| Selected load + GPU/CPU boundary | 172.10 profile average | tail visible in token p95 | yes per streamed layer | all-hit floor removes a large fraction |
| Routed Metal compute | 51.09 profile average | stage-dependent | yes within each layer | nsg=1/4 did not help |
| All-hit full token floor | 92.229 | 108.111 | yes | lower bound, not production result |
| Production token latency | 137.181 median | 218.531 | yes | final three-run median |

### Pass-2 experiments

| Experiment | Mechanism and evidence | Decision |
|---|---|---|
| Exact GLM hotlist seeding | Fixed explicit GLM Q2 mixed `IQ2_XXS` gate/up + `Q2_K` down hotlist preload, previously rejected by a historical same-type/top-6 predicate. One-token and six-token traces seeded all 336/1134 requested entries. Diagnostic only; default GLM demand-fill is unchanged. | KEEP correctness/measurement fix |
| Selected-ID trace top-8 | Binary record/replay accepted 1..8 IDs instead of exactly six; exact traces contain 128×42 ordered top-8 records for standard, coding, and reasoning prompts. Selected-profile logging now prints slots 6 and 7 too. | KEEP diagnostic correctness fix |
| Route-hotness decay 64 | Offline replay predicted 24,944→23,065 misses, but real steady medians were 6.66→6.63 tok/s. | REJECT; reverted |
| Redundant address-write suppression | Avoid repeated `didModifyRange` when an address was unchanged. Baseline/candidate steady medians 4.95→4.82 tok/s (-2.6%). | REJECT; reverted |
| Async selected loading | Existing async path: 4.99→4.91 tok/s and profile phase 7175→7318 ms. | REJECT; no code retained |
| M2 `nsg=1` | Exact top-8 gate/down pipelines with one SIMD-group. All-hit wall 33.60→35.48 s (+5.6%); gate/up became slower and more variable. | REJECT; reverted |
| M2 `nsg=4` | Exact top-8 pipelines with four SIMD-groups. All-hit wall 34.32→34.83 s (+1.5%), no stable stage gain. | REJECT; reverted |
| 16 GiB routed budget | Misses 13,005→9289 and read bytes 85.73→61.23 GiB, but three-run steady median 6.77→6.49 tok/s (-4.1%), p95 218.531→235.900 ms. | REJECT; auto 12 GiB retained |
| 2 full layers in 16 GiB | Removed two readback boundaries but increased streamed misses to 14,889 and produced 6.66 tok/s in the diagnostic run. | REJECT; no default change |
| Selected shared event | Short sync 4.98→4.65 s, but long steady 6.75 versus 6.77 control median and p95 237.066 versus 218.531 ms. | REJECT; reverted |
| Compact ordered top-8 addresses | Replaced full-table IDs with ordered 0..7 addresses. Selected sync 4.98→6.16 s and first token 1.324→2.863 s in the focused run. | REJECT; reverted |

### Final production performance

The final ordinary-decode automatic-cache repetitions were process-cold runs
with identical prompt bytes, 16 live prompt tokens, 128 generated tokens,
temperature zero, 128K allocation, and MTP absent.

| Metric | r1 | r2 | r3 | Median |
|---|---:|---:|---:|---:|
| Total generation tok/s | 5.68 | 6.60 | 6.30 | 6.30 |
| Steady generation tok/s | 6.20 | 7.07 | 6.77 | 6.77 |
| First token ms | 2035.732 | 1443.646 | 1565.566 | 1565.566 |
| Token p50 ms | 148.437 | 132.805 | 137.181 | 137.181 |
| Token p95 ms | 231.352 | 204.091 | 218.531 | 218.531 |
| Process swaps | 0 | 0 | 0 | 0 |

The retained active-entry index remains the pass's measured production code
win: its earlier controlled identical-binary A/B improved steady decode
5.648→6.155 tok/s (+8.98%) while preserving the victim comparator and order.
The exact top-8 cache-backed path remains the dominant earlier win over broad
mapping: 0.03→3.23 tok/s controlled median, with later warm/process-cold runs
now sustaining a 6.77 tok/s median. Warm best values are not used as the main
claim.

### Final quality, QA, and live qualitative smoke

- **PASS** — official GLM 5.3 Q2 scorer, final pass-2 build, exact command:
  `score_official MODEL manifest.tsv OUTPUT 131072 --ssd-streaming`.
  100/100 cases, 11,559 target tokens, average NLL `0.458446458`, first-token
  match `89/100`, average LCP `6.960`, exit 0. The previous local full scorer
  was `0.459185213`, `89/100`, `7.110`; NLL improved 0.161%, first match is
  identical, and LCP remains in the accepted band. Maximum RSS was
  8,991,473,664 bytes, peak footprint 13,563,747,696 bytes, process swaps 0.
- **PASS** — warning-clean clean Metal build and clean Metal restore after CPU;
  logs `build-metal-final.log` and `build-metal-final-restored.log`.
- **PASS** — warning-clean CPU compile-only build; no large-model CPU inference;
  log `build-cpu-final.log`.
- **PASS** — final `git diff --check` and `make test-glm53-kda`.
- **FAIL — missing repository-default model path, not a test regression** —
  `make test` passed the Q4_K, MXFP4, extractor and agent tests, then bare
  `./ds4_test` could not open absent `ds4flash.gguf`. The user's Q2 was not
  copied or renamed.
- **PASS** — `./ds4_test --server` model-free harness.
- **FAIL — pre-existing upstream M2 oracle failures** — `./ds4_test
  --metal-kernels` had 29 compressor/gather failures, reproduced in the clean
  detached upstream HEAD. It is not attributed to or hidden by this patch.
- **PASS** — prior final tokenizer-backed 4095..4100, post-4096 actionable task,
  snapshot and snapshot+MTP gates listed above remain the applicable exact
  state evidence. Pass 2 changes only opt-in trace/preload and diagnostic log
  behavior on top of the already-scored production path.
- **PASS** — agent-owned live CLI smoke, final restored binary, `--ctx 131072
  --temp 0 --nothink --metal --ssd-streaming`, MTP disabled. Turn 1 returned
  exactly `GLM53_OK`. Turn 2 emitted a correct C99 checked `size_t` addition
  using `b > SIZE_MAX - a` before addition (minor formatting miss: Markdown
  fences despite a code-only request). Turn 3 correctly returned lower-bound
  index 1 with the first-`>=3` explanation in two sentences. Continued-turn
  timings were 1.73/4.08 and 1.67/4.23 prefill/generation tok/s. No incoherent,
  simplified, partial, or silently corrupted answer was observed.
- **NOT RUN — unsafe resident harness** — Q2 Metal multi-session batch; its
  harness still cannot request bounded SSD streaming.
- **NOT RUN — hardware/permission unavailable** — CUDA, ROCm, distributed, TP,
  RDMA. No validation claim is made. MTP performance is out of scope for this
  native-decode pass and was not enabled in any pass-2 performance run.

Pass-2 artifacts, including all-hit traces, three real routing traces,
per-token CSVs, cache sweeps, rejected-kernel A/Bs, build/test logs, final TSV,
scorer log, memory and swap evidence are retained under:

`/tmp/glm53-m2max96-native-pass2.mItgnW`

## Native-decode pass 3 — 2026-08-31

This pass continued from the retained pass-2 working tree. Every model run in
this section used a 131072-token allocation, automatic 12 GiB routed budget,
temperature zero, one process, and **native raw decode, MTP disabled**. No
pass-3 production-code experiment met the acceptance gate: each candidate was
removed completely. Final `ds4_metal.m` is byte-identical to the saved pass-3
input at `/tmp/ds4-route-revert.nmgK7E/ds4_metal.m`; `ds4.c`, public APIs, and
the server were not changed in this pass.

### Refined critical path and lower bound

The selected-ID copy itself is not the large cost. In representative 32-token
runs, 2688 selected calls spent only 0.67--0.75 ms total copying IDs, while
GPU completion synchronization spent 5.14--5.62 s total. Cache/bind work was
2.34--2.52 s and aggregate routed-expert `pread` work was approximately
1.1--1.7 ms per load call. The boundary is therefore a real router dependency,
not a generic 32-byte-copy problem.

The strongest diagnostic replay disabled the early CPU selected-ID readback
and replayed the exact recorded top-8 trace with its measured hot set. Stable
latencies were 55.623, 58.682, 61.014, 64.359, and 74.803 ms, giving 15.90
steady tok/s as reported by `ds4-bench` (median 61.014 ms, p95 64.359 ms by the
same discrete convention used in the harness). This is an optimistic
diagnostic floor, not a production result: replay removes the authoritative
router boundary and may not be used to claim normal decode speed.

| Removable cost | Measured equivalent | Evidence and implication |
|---|---:|---|
| Selected/router boundary | 172.10 ms/token in the 32-token phase profile | Dominant; ID copy is negligible, but a real miss needs the authoritative router result. |
| Routed Metal compute | 51.09 ms/token in the same profile | Exact top-8 unrolling and alternative SIMD-group schedules did not reduce it end-to-end. |
| Cache/bind policy work | about 29.0 ms/token in the 128-token profile | Active-entry index is already retained; policy replay found no robust cross-prompt replacement. |

Thus `A`, the current controlled production p50, remains approximately
137--150 ms/token; `B`, the strongest all-hit/replay diagnostic floor, is
61.014 ms/token; and the measured kernel plus non-MoE floor `C` remains above
25 ms/token. Forty native tok/s is not supported by these measurements.

### Experiment 3.1 — GPU selected-route gate

#### Hypothesis

Replace the broad command-buffer completion used at the selected-ID boundary
with a narrow Metal shared-event gate.

#### Code delta

The temporary code had an exact M2 Max/GLM53/top-8 predicate and retained the
existing completion fallback.

#### Correctness

The initial cold variant failed closed before publishing a token. The lifetime
bug was corrected for measurement; output remained identical in successful
runs.

#### Performance

The all-hit diagnostic improved substantially, but natural routing improved
only about 3.4% in the short control and did not beat the accepted production
median. Tail latency worsened. The experiment was therefore not promoted to a
long production gate.

#### Decision

**REJECT.** Fully reverted; the event did not remove the router dependency on
real miss traffic.

### Experiment 3.2 — exact unrolled top-8 Q2 down kernel

#### Hypothesis

Compile the exact M2 shape with eight slots known at compile time, avoiding the
generic address-kernel loop bound.

#### Performance

At routed layer 42, the ordinary address kernel measured approximately
0.288--0.323 ms for the down stage; the exact candidate measured
0.337--0.471 ms. The six-token release control reported 15.49 versus 14.74
steady tok/s in the diagnostic all-hit window. Output was identical.

#### Decision

**REJECT.** Reverted. The extra specialization was slower on M2 Max.

### Experiment 3.3 — cache trace replay and prediction

#### Hypothesis

Use actual top-8 traces to find a lower-churn replacement for the current
route-hotness/age policy or a safe previous-token prefetch.

#### Performance

Previous-token top-8 precision was only 30.54% on the standard trace, 18.14%
on coding, and 23.39% on reasoning, wasting 69--82% of speculative expert
reads. Static hot sets did not transfer: a set trained on the standard prompt
hit 75.69% on standard but only 17.92% on coding and 21.79% on reasoning.

At the real 1244-entry budget, offline replay produced:

| Trace | Current hotness tail hit | LRU | Layer LRU | SLRU |
|---|---:|---:|---:|---:|
| Standard | 75.43% | 66.09% | 62.86% | 70.03% |
| Coding | 50.04% | 37.11% | 37.95% | 51.12% |
| Reasoning | 62.24% | 50.59% | 51.09% | 63.79% |

SLRU's small coding/reasoning advantage did not generalize to the standard
trace and was below the required predicted 10% byte/wait reduction.

#### Decision

**REJECT.** No runtime policy or prefetch code was added.

### Experiment 3.4 — adaptive `F_RDADVISE` suppression

#### Hypothesis

Avoid synchronous advisory calls after the first token while preserving the
normal production preload and first-token behavior.

#### Correctness

All six natural-routing A/B runs emitted byte-identical decoded text (SHA-256
`740e98...`) and reported zero process swaps.

#### Performance

Replay initially predicted a repeatable improvement, but authoritative natural
routing did not confirm it:

| Metric | Existing readahead median | Candidate median | Delta |
|---|---:|---:|---:|
| Steady decode | 6.39 tok/s | 6.27 tok/s | -1.9% |
| First token | 1972.630 ms | 1452.718 ms | -26.4% |
| Token p50 | 145.271 ms | 149.919 ms | +3.2% |
| Token p95 | 233.171 ms | 242.669 ms | +4.1% |

The first-token improvement did not compensate for worse steady decode and
tail latency in the primary workload.

#### Decision

**REJECT.** Fully reverted; no new environment switch remains.

### Experiment 3.5 — one fully resident routed layer

#### Hypothesis

Spend the automatic prefill/full-layer reserve on one 1.90 GiB routed layer to
remove one selected-ID boundary without increasing the 17.25 GiB planned
footprint.

#### Performance

One diagnostic run gave 7.00 versus 6.91 steady tok/s (+1.3%, below noise),
but process-cold wall time increased from 31.65 to 50.25 s and first token from
1007.111 to 2073.949 ms. The dynamic cache shrank from 1244 to 956 experts.
Both processes reported zero swaps; global swap was unchanged.

#### Decision

**REJECT.** Automatic zero full layers remains the production policy.

### Experiment 3.6 — top-8 resident/missing split overlap

#### Hypothesis

Generalize the existing exact masked address-table split from top-6 to 1..8,
run resident expert gate/up work while missing experts are read, then perform
the Q2 down reduction in the original router order 0..7.

#### Correctness

The first activation exposed two latent top-6 assumptions: the decode-maturity
counter expected the first routed layer at layer zero, and the pre-load address
publication required missing entries to be present before the deferred load.
Temporary exact-M2 fixes made the split execute successfully. Successful output
matched the fallback byte-for-byte; the earlier failure stopped before token
publication.

#### Performance

Across the 32-token profile, 641 mixed layers averaged 3.91 resident and 4.09
missing experts. Useful post-read wait was only 0.083 ms/layer, while the extra
stage increased overhead. Steady decode fell from 5.57 to 5.10 tok/s (-8.4%),
p50 rose from 172.864 to 184.317 ms, p95 from 229.785 to 278.067 ms, and first
token from 1039.883 to 1527.988 ms.

#### Decision

**REJECT.** The complete top-8 masked/split experiment and both enabling fixes
were reverted. DeepSeek V4's fixed top-6 kernels were never changed in the
retained tree.

### Pass-3 final state and QA

- **PASS** — final warning-clean Metal build and restored Metal build after the
  CPU gate: `build-pass3-final-metal.log` and
  `build-metal-pass3-restored.log`.
- **PASS** — warning-clean `make cpu`, compile only; no large-model CPU
  inference: `build-cpu-pass3-final.log`.
- **PASS** — `git diff --check`.
- **PASS** — `make test-glm53-kda`; `GLM-5.3 KDA GPU tests: PASS`.
- **FAIL — missing repository-default model path, not a regression** —
  `make test` passed Q4_K, MXFP4, extractor, and agent tests, then bare
  `./ds4_test` could not open absent `ds4flash.gguf`, identical to pass 2.
- **PASS (applicable unchanged source evidence)** — official final pass-2
  100-case scorer: 100/100, average NLL `0.458446458`, first-token match
  89/100. It was not rerun after pass 3 because no pass-3 production inference
  change was retained and the relevant source was restored exactly.
- **PASS** — final live two-turn CLI on the restored Metal build, 128K context,
  automatic SSD cache, temperature zero, and MTP disabled. It returned exactly
  `GLM53_OK`, then correctly explained in one sentence that dereferencing a
  possible null C pointer is undefined behavior and requires a null check.
  Continued-turn generation was 3.95 tok/s. Maximum RSS was 8,829,911,040
  bytes, peak footprint 13,515,529,584 bytes, process swaps 0.
- **NOT RUN — out of scope** — MTP performance; it was never enabled in pass-3
  benchmarks.
- **NOT RUN — no hardware/permission** — CUDA, ROCm, distributed, TP, RDMA.
  No claim is made for those paths.

Final restored binaries for this pass are SHA-256 `8f2d670e...` (`ds4`),
`721655c2...` (`ds4-bench`), and `7fb429d6...` (`ds4-server`). All pass-3 raw
CSVs, per-token traces, complete logs, cache simulations, rejected source
measurements, build/test logs, live-smoke output, memory, power, and swap
artifacts are retained under:

`/tmp/glm53-m2max96-topology-pass3.x4D0Iy`

## Native-decode pass 4 — bitsets, allocation audit, and rejected compiler paths

This pass followed
`$USER_HOME/Desktop/CODE_AUDIT_GLM53_M2MAX96_UNION_BITSET_ASM.md`.
It retained only allocation/layout hardening; it does not claim an additional
decode-throughput gain. Every full-model performance run used a 131072-token
allocation, automatic SSD streaming, temperature zero, and **native raw decode,
MTP disabled**.

### Retained host-layout changes

- Repeated expert membership sets that had used `bool seen[384]` now use six
  64-bit words (`48` bytes). Five local decode/prefill uses in `ds4.c` and the
  Metal prefill-selected use in `ds4_metal.m` were converted to O(1) checked
  bit tests/sets. Expert IDs remain range checked; no route, order, weight, or
  victim decision changed.
- The hotlist builder's large arrays were collected into one cold-path heap
  workspace instead of one large stack frame. The exact old stack components
  totalled 273,340 bytes; the new workspace is 246,800 bytes. The bitset saves
  26,540 bytes and a static assertion caps the workspace at 256 KiB.
- A hotlist smoke loaded four entries across two layers in 4.758 ms. These are
  stack-safety and layout improvements, not steady-token speed claims.

### Audited and rejected

- **REJECT — early selected handoff.** Moving the selected-ID handoff earlier
  did not remove the authoritative router dependency and did not give a stable
  end-to-end gain. It was reverted.
- **REJECT — compact one-base address metadata.** The combined-buffer layout
  did not reduce the measured critical path enough to justify a second format.
  It was reverted.
- **REJECT — ThinLTO.** The executable became smaller, but first-token latency
  regressed 21.6% and total throughput regressed 3.6% in the controlled run.
  All LTO flags were removed.
- **NOT IMPLEMENTED — output-head GPU argmax, PGO, and handwritten assembly.**
  The profile showed that output/logit selection was small compared with the
  router completion and cache/bind boundaries. Adding a less transparent path
  there would not address the measured dominant cost.

### Pass-4 quality result

The complete pre-main scorer processed 100/100 cases and 11,559 target tokens:
average NLL `0.457843948`, first-token match `89/100`, and average greedy prefix
`7.110`. Maximum RSS was 8,991,686,656 bytes, peak footprint 13,556,276,640
bytes, and the process reported zero swaps. This superseded the earlier local
pass-2 NLL `0.458446458` while preserving the same first-token count.

Pass-4 artifacts are retained under:

`/tmp/glm53-m2max96-union-pass4.OpaJWF`

## Migration to merged `origin/main` — 2026-08-31

GLM 5.3 support was merged upstream while this worktree still contained the
uncommitted M2 Max specialization. `git fetch origin` advanced `origin/main` to
`ec7642cdd9ec81d01ad4b1fd8f8a3d1511533748`. The local branch name `main` was
already checked out by the separate `$DSTUDIO_ROOT/ds4`
worktree, so this worktree was switched with merge preservation to the new
tracking branch `glm53-m2max96-main`. Its HEAD and `origin/main` are identical.
No reset, stash, clean, model move, or unrelated-worktree edit was performed.

The migration produced two textual conflicts:

- `ds4.c`: upstream's merged GLM streaming map/accounting was combined with the
  exact M2 Max/GLM53/Q2/top-8 address predicate;
- `ds4_bench.c`: upstream's new multi-token DSpark/speculative publication loop
  was combined with the local per-token timing CSV. The first token in one
  multi-token publication records the cycle latency and the remaining tokens
  record zero; ordinary native decode remains exactly one token per cycle.

No new production optimization was introduced to make the merge appear faster.
The complete pre-migration patch is
`/tmp/glm53-main-migration.W8oL8J/working-tree-before-main.patch`.

### Contemporaneous pre-main/main A/B

The same 16 real prompt tokens, 128 generated tokens, prompt bytes, automatic
12 GiB cache, 131072 context allocation, temperature zero, and MTP-disabled
command were used. One warm-up was excluded and three process runs were
measured on each binary. Text output was byte-identical in all six runs.

| Metric | Pre-main median | Merged-main median | Change |
|---|---:|---:|---:|
| Prefill | 0.54 tok/s | 0.54 tok/s | 0.0% |
| Total decode | 5.45 tok/s | 5.44 tok/s | -0.18% |
| First token | 1,973.498 ms | 1,983.057 ms | +0.48% |
| Steady native decode | 6.02 tok/s | 5.91 tok/s | -1.83% |
| Per-token p50 | 154.742 ms | 157.672 ms | +1.89% |
| Per-token p95 | 239.484 ms | 234.410 ms | -2.12% |
| Process wall time | 53.24 s | 53.80 s | +1.05% |
| Median max RSS | 8.833 GB | 8.832 GB | unchanged |
| Median peak footprint | 13.513 GB | 13.513 GB | unchanged |
| Process swaps | 0 | 0 | unchanged |

The `-1.83%` steady difference is below the repository's 5% clean-rerun rule,
is paired with a `2.12%` p95 improvement, and is treated as measurement noise,
not an optimization win or a regression.

### Main-port official continuation quality

The official GLM 5.3 Q2 fixture was rerun after the migration, rather than
reusing pass-4 evidence:

```text
score_official MODEL \
  gguf-tools/quality-testing/data/glm53-flash-openrouter-zai-fp8-100/manifest.tsv \
  glm53-q2-main-final.tsv 131072 --ssd-streaming
```

| Metric | Pre-main pass 4 | Merged main | Delta |
|---|---:|---:|---:|
| Cases / target tokens | 100 / 11,559 | 100 / 11,559 | identical |
| Average NLL | 0.457843948 | 0.457842235 | -0.000001712 (-0.000%) |
| First-token match | 89/100 | 89/100 | identical |
| Average greedy prefix | 7.110 | 7.110 | identical |

Case comparison was 23 new wins, 29 old wins, and 48 ties; aggregate quality is
unchanged. The main scorer recorded 8,993,734,656 bytes maximum RSS,
13,553,049,064 bytes peak footprint, and zero process swap operations. The
system-wide `vm.swapusage` nevertheless grew from 11,772.94 to 13,772.88 MiB
during the 6,055-second whole-fixture scan. After the process exited it fell to
13,303.56 MiB and `memory_pressure` reported 93% free, no throttled pages, and
no thermal warning. This host-level swap cost is reported explicitly and is not
described as zero-swap scorer behavior; the ordinary 128-token decode runs and
the boundary/snapshot checks reported zero process swaps and no positive global
swap delta in their retained samples.

### Main-port sparse-boundary and state checks

- The tokenizer-backed 4095, 4096, 4097, 4098, 4099, and 4100 frontiers were
  rerun with `--ctx-alloc 131072`, automatic streaming, and zero generated
  tokens. Every JSON file, including all 154,880 logits, was byte-identical to
  the validated pre-main artifact. Argmax IDs remain
  `325, 264, 650, 19501, 459, 11`; all values are finite by byte-identical
  comparison with the prior finite oracle.
- The ordinary streaming snapshot was rerun with the tokenizer-verified
  5,233-token prompt and `DS4_TEST_SNAPSHOT_CTX=131072`:
  `session-snapshot: OK`. It used 3,118,415,872 bytes maximum RSS,
  9,615,477,184 bytes peak footprint, and zero process swaps.
- The actionable instruction after the 4096 frontier was rerun with a
  131072-token allocation and returned exactly `BOUNDARY_OK`. A first command
  with `--tokens 1` returned only the first output token `BOUND`; that command
  was an invalid truncating test and was rerun with `--tokens 16`. The retained
  run completed in 176.88 s, used 5,108,252,672 bytes maximum RSS and
  13,620,253,496 bytes peak footprint, and reported zero process swaps.
- GLM integrated MTP was deliberately not enabled in this native-decode pass.
  The pre-main MTP snapshot evidence remains historical only and is not claimed
  as a post-main run.

### Main-port QA matrix

- **PASS** — warning-clean Metal build and final Metal restore:
  `make clean && make`.
- **PASS** — warning-clean CPU compile-only build:
  `make clean && make cpu`; no full-model CPU inference was run.
- **PASS** — `git diff --check`; no conflict markers remain in tracked source.
- **PASS** — `make test-glm53-kda`; `GLM-5.3 KDA GPU tests: PASS`.
- **FAIL — missing default artifact, not an observed code regression** —
  `make test` passed Q4_K, MXFP4, extractor, and agent checks, then bare
  `./ds4_test` could not open the absent repository-default `ds4flash.gguf`.
  The 90 GiB Q2 was not copied, renamed, or made resident to satisfy this
  aggregate target.
- **PASS** — the remaining model-free tests run individually after that stop:
  `test_layer_pack` 97/97, `test_engine_mgpu_placement` 108/108,
  `test_gpu_args`, `test_gpu_args_cli.sh` 88/88, `test_sampling`, and
  `./ds4_test --server`.
- **PASS** — official GLM 5.3 Q2 scorer, 100/100, results above.
- **PASS** — 4095..4100 complete-logit boundary, byte-identical to the prior
  accepted artifacts.
- **PASS** — ordinary 5,233-token streaming session snapshot at 128K.
- **PASS** — post-4096 actionable task, exact output `BOUNDARY_OK`.
- **PASS** — live three-turn CLI, `--ctx 131072 --temp 0 --nothink`, automatic
  streaming, MTP absent. It returned exactly `GLM53_MAIN_OK`, emitted a correct
  C `clamp_int` that safely swaps inverted limits, then correctly reviewed its
  behavior at `INT_MIN`/`INT_MAX`. Warm continued-turn generation was 3.50 and
  3.86 tok/s; no incoherent or silently corrupted behavior was observed.
- **PASS** — local OpenAI chat smoke on the changed runtime port only:
  `--host 127.0.0.1 --port 18081 --ctx 131072 --ssd-streaming`. `/v1/models`
  reported the three GLM 5.3 aliases at context length 131072 and chat returned
  exactly `SERVER_MAIN_OK`. The server drained and port 18081 was verified
  closed. The source default port remains 8000.
- **NOT RUN — MTP out of scope** — no post-main MTP performance or snapshot
  run; no MTP speed claim is made.
- **NOT RUN — unsafe resident harness** — Q2 Metal multi-session batch still
  lacks a bounded streaming admission path.
- **NOT RUN — unavailable local hardware / no remote authorization** — CUDA,
  ROCm, distributed, TP, and RDMA. Shared interfaces compiled where covered by
  the CPU/Metal builds; no runtime correctness claim is made.

### Main-port decision

**KEEP.** The exact M2 Max GLM53 Q2 top-8 selected-address path, active-entry
victim index, and bitset/layout hardening survive on merged main. The port does
not create a measurable new performance gain, but it preserves performance
within noise, preserves complete-logit boundary behavior byte-for-byte, and
preserves official continuation quality. The next measured limit remains the
authoritative router completion/cache-bind boundary; the strongest diagnostic
replay floor is about 61 ms/token (15.9 tok/s), still above the 25 ms/token
required for 40 native tok/s.

All migration logs, raw CSVs, token-latency files, complete scorer TSV/log,
boundary logits, snapshot output, server JSON, build/test logs, memory and swap
samples are retained under:

`/tmp/glm53-main-migration.W8oL8J`

## Second synchronization with `origin/main` — 2026-09-04

`git fetch origin` advanced `origin/main` by 31 commits, from
`ec7642cdd9ec81d01ad4b1fd8f8a3d1511533748` to
`b0a147a7fba6d1a104d047d5a140e9bb4bfc13cd`. The incoming history includes
conversation-prefix conditioning, DeepSeek Vision-Exp, Metal tensor-parallel
work and GLM 5.3 ROCm changes. None of those backend-specific changes is
reported here as tested merely because it was merged.

The dirty working tree was captured before the operation. A normal
`git merge --ff-only origin/main` stopped before changing files because all
eight locally modified inference/server sources also changed upstream. The
old branch pointer was retained as
`backup/glm53-m2max96-main-pre-b0a147a-20260904`; the working changes were then
three-way merged onto `origin/main` with merge-preserving `git switch -m` while
recreating the current branch name `glm53-m2max96-main`. The merge completed
without textual conflicts. No reset, stash, clean, model operation or edit to
the separate `ds4` worktree was performed.

### Semantic merge audit

The following local behavior remains present after the port:

- the exact Apple M2 Max / GLM 5.3 / 288 routed expert / top-8 / IQ2_XXS plus
  Q2_K / one-token / SSD-streaming / single-GPU activation predicate;
- the generic fallback and
  `DS4_METAL_DISABLE_M2_GLM53_TOP8_STREAM_ADDR` disable switch;
- the top-8 selected-address Metal consumer, while DeepSeek V4's fixed top-6
  kernel remains unchanged;
- direct bounded-cache binding of the router-selected experts;
- the active-entry cache victim bitset/index, hotlist bitsets and bounded
  startup workspace;
- the 1..7-token M2 Max streaming continuation path and its exact fallback;
- the integrated-MTP static-map correctness fix, although MTP remained disabled
  in this validation;
- local DStudio/server memory-pressure and observability changes, preserved but
  not attributed to this optimization work.

### Build-system correctness fix found during the port

The updated Metal object references the new DeepSeek Vision helper
`ds4_deepseek4_attention_bounds`, defined in `ds4_image.o`. Upstream's focused
`test-glm53-kda` link rule still linked only `tests/test_glm53_kda.o` and
`ds4_metal.o`, so it failed with an undefined symbol before executing the KDA
oracle. `Makefile` now links `ds4_image.o` into the Metal and CUDA forms of that
focused test. This is a test-target linkage fix, not an inference optimization.
After the fix, the test reports `GLM-5.3 KDA GPU tests: PASS`.

### QA for the second synchronization

- **PASS** — warning-clean Metal build and restored Metal build:
  `make clean && make`.
- **PASS** — warning-clean CPU compile-only build: `make clean && make cpu`;
  no large-model CPU inference was run.
- **PASS** — `git diff --check` and explicit tracked-source conflict-marker
  scan.
- **PASS** — `make test-glm53-kda` after the focused link-rule fix.
- **PARTIAL / expected missing artifact** — `make test` compiled its targets and
  passed Q4_K, MXFP4, extractor and agent tests, then bare `./ds4_test` stopped
  because the repository-default `ds4flash.gguf` is absent. The 89.87 GiB GLM
  Q2 was not copied or forced through an unsafe resident default harness.
- **PASS** — remaining model-free tests executed individually:
  `test_layer_pack` 97/97, `test_engine_mgpu_placement` 109/109,
  `test_gpu_args`, `test_gpu_args_cli.sh` 88/88, `test_prompt_prefix`,
  `test_sampling`, and `test_deepseek4_vision_image`.
- **PASS** — `./ds4_test --server` (`server: OK`).
- **PASS** — one live, three-turn GLM 5.3 CLI session with
  `--metal --ssd-streaming --ctx 131072 --tokens 96 --temp 0 --nothink`, no MTP.
  It returned exact `PORT_MAIN_OK`, produced a correct overflow-free C
  `clamp_int`, then coherently completed the truncated explanation in the same
  session. The two substantive generation reports were 5.26 and 5.20 tok/s.
  These are smoke timings with different turn lengths, not a controlled
  before/after performance claim.
- **PASS** — live-process memory observation: maximum RSS 8,830,631,936 bytes,
  peak footprint 13,517,167,984 bytes, process swaps 0. System memory remained
  healthy (91% free after exit); existing system-wide swap decreased from
  9,790.88 MiB to 9,742.88 MiB during the bounded run.
- **NOT RUN — scorer cost / no new speed claim** — the official 100-case scorer
  was not repeated for this source synchronization. The earlier 100/100 result
  at `ec7642c` remains historical evidence only, not a claimed result for
  `b0a147a`.
- **NOT RUN — unchanged expensive frontiers** — 4095..4100 full-logit and the
  5,233-token snapshot were not repeated in this bounded synchronization.
- **NOT RUN — out of scope** — MTP was disabled throughout.
- **NOT RUN — unavailable local hardware / no remote authorization** — CUDA,
  ROCm, distributed, TP and RDMA runtime tests. The CPU fallback compiled; the
  CUDA KDA dependency rule was corrected but not compiled locally.

### Decision

**KEEP.** The M2 Max GLM 5.3 specialization is now carried on the latest
`origin/main` without a detected semantic merge conflict. The port adds no
claimed decode optimization and no new benchmark delta. It does add the
necessary focused-test linkage fix exposed by the incoming Vision code. Full
release-quality acceptance on this exact new HEAD still requires repeating the
official scorer and long boundary/snapshot matrix if a release is cut from it.

All logs, before/after patches, hashes, status captures and the live CLI log for
this synchronization are retained under:

`/tmp/glm53-main-port-20260904.4MiTxn`

## Native-decode pass 5 — topology-aware profiling on current main — 2026-09-04

This pass follows the topology-aware research plan with **native raw decode,
MTP disabled**.  The checked-out branch and `origin/main` were both
`b0a147a7fba6d1a104d047d5a140e9bb4bfc13cd`.  The model remained
`GLM-5.3-Flash-Q2.gguf`, 96,505,816,384 bytes, SHA-256
`e81fd6241c6e55a64e1e14e47a3eab61a173fa8d7e4b5c1d1848827119705b32`.
Every performance command used Metal, automatic bounded SSD streaming,
`--ctx-alloc 131072`, the same 16-token prefix of
`speed-bench/promessi_sposi.txt`, 128 generated tokens, and no MTP flag.

### Reproduced production baseline

One excluded warm-up and three measured process-cold runs gave:

| Metric | Warm-up | r1 | r2 | r3 | Measured median |
|---|---:|---:|---:|---:|---:|
| Total generation | 6.55 | 7.24 | 7.14 | 6.57 tok/s | 7.14 tok/s |
| Steady generation | 6.98 | 7.89 | 7.72 | 7.04 tok/s | **7.72 tok/s** |
| First token | 1334.396 | 1580.389 | 1456.896 | 1437.105 ms | 1456.896 ms |
| Token p50 | 132.598 | 113.567 | 115.939 | 135.605 ms | 115.939 ms |
| Token p95 | 204.319 | 196.738 | 215.934 | 204.495 ms | 204.495 ms |
| Process swaps | 0 | 0 | 0 | 0 | 0 |

This current-main result reproduces and exceeds the historical 6.77 tok/s
last-known-good without attributing the difference to a new source change.

### Critical path, floors, and cache topology

The existing timing counters attribute 19,227.269 ms of 20,211.086 ms total
generation time (95.132%) to the synchronous GLM streaming layer path. This
comparison includes the first token: the 127-token steady window was
18,057.973 ms and must not be used as the denominator for all 128 tokens.
Across 128 tokens, its host intervals were 13,258.560 ms in early load,
240.846 ms in shared-expert host encoding, 5,716.471 ms in the routed phase,
and 10.918 ms after it.  `early_load` includes completion of earlier GPU work,
so it is a boundary interval rather than wholly removable CPU overhead.

The production trace contained 5,376 routed-layer calls and 43,008 selected
expert lookups: 30,174 hits and 12,834 misses (70.159% hit rate), with 84.60
GiB read by `pread`.  The exact per-token grouping showed:

- **0/128 completely all-hit tokens**;
- median 93 missing experts/token, p90 158, p95 169, p99 225;
- only 663/5,376 (12.33%) individual routed-layer calls were all-hit;
- the minimum observed miss count was 36 experts/token.

Consequently, a whole-token optimistic GPU execution followed by rollback on
any miss would have fallen back on every observed token at the automatic 8.20
GiB dynamic-cache budget.  It was not implemented.

The natural trace accumulated 1,134 unique `(layer, expert)` entries in its
first six tokens and exceeded the 1,244-entry cache during token seven.  An
exact hot preload therefore provided a natural, authoritative six-token
all-hit window: after the first token, the stable four-token interval was about
70.8 ms/token.  A longer diagnostic route replay, constrained to that 1,134
entry union, measured 57.107 ms mean, 56.370 ms p50, 60.943 ms p95, and 17.51
tok/s.  It is a diagnostic floor, not production throughput.

Timing-only ablations on the same replay measured about 39.122 ms p50 with
routed MoE removed and 42.019 ms with both routed and shared experts removed.
These runs do not preserve model output and are not additive performance
claims; they establish that the current non-MoE floor alone remains above the
25 ms/token required for 40 native tok/s.  The routed path's observed marginal
floor was about 17 ms/token.

The structural command-buffer trace counted 170 post-prefill completed command
buffers for two decode tokens: 85/token, matching two boundaries for each of
42 routed layers plus the output boundary.  Timing from that trace was
discarded because the verbose profiler was invasive.

### EXP-5.1 — suppress immediate expert `F_RDADVISE`

**Hypothesis.** The profiler recorded 38,502 advisory calls taking 1,746.605 ms
(13.65 ms/token) immediately before selected-expert reads.  Suppressing them
might remove synchronous host work while leaving `pread` authoritative.

**A/B design.** Three alternating process-cold pairs compared the normal path
with the existing diagnostic
`DS4_METAL_DISABLE_STREAMING_EXPERT_READAHEAD=1`; all other flags were
identical, MTP was absent, and per-token latency was recorded without the
verbose streaming profiler.

| Metric | Existing readahead median | Disabled median | Delta |
|---|---:|---:|---:|
| Total generation | 6.49 tok/s | 6.52 tok/s | +0.5% |
| Steady generation | 7.07 tok/s | 7.00 tok/s | **-1.0%** |
| First token | 1757.952 ms | 1681.175 ms | -4.4% |
| Token p50 | 131.210 ms | 132.018 ms | +0.6% |
| Token p95 | 199.457 ms | 226.643 ms | **+13.6%** |
| Process swaps | 0 | 0 | unchanged |

**Decision: REJECT.** The advisory calls are measurable CPU work, but the
storage hint reduces enough demand-read tail latency to pay for itself.  The
new-main full-disable control corroborates the earlier rejected adaptive
suppression experiment.  No production code was changed and no cleanup patch
was required.

Pass-5 raw CSVs, per-token timing, route traces, profile logs, replay input,
hotlist, A/B logs and summaries are retained under:

`/tmp/glm53-m2max96-topology-pass5.2ImgG5`

### EXP-5.2 — offline cache bound, no production policy change

**Hypothesis.** Separate compulsory demand fills from avoidable re-reads before
changing cache capacity or policy. The standalone `cache_bound.py` diagnostic
uses the exact 128-token top-8 trace, protects all eight current entries, and
simulates equal-sized, mandatory-demand admission. It never executes the model
or changes its cache. Belady uses future information only as a lower bound on
fills, not as a deployable policy or an I/O-latency prediction.

**Correctness.** The simulated current hotness/age policy reproduces every one
of the 5,376 observed per-layer miss counts. All 43,008 IDs also match the raw
binary route trace byte-for-byte. An independent exhaustive dynamic-programming
oracle agrees with the batch Belady implementation on 15,552 tiny cases.

| Dynamic entries | Current policy fills | LRU fills | SLRU fills | Offline Belady bound |
|---:|---:|---:|---:|---:|
| 933 | 16022 | 21511 | 18360 | 9834 |
| 1120 | 13932 | 18890 | 15076 | 8378 |
| 1244 (automatic) | 12834 | 15423 | 13890 | 7663 |
| 1368 | 11898 | 12734 | 13101 | 7096 |
| 1820 | 9338 | 9186 | 11271 | 5783 |
| 2488 | 7033 | 6813 | 6747 | 5066 |
| 3732 | 5356 | 5267 | 5360 | 5066 |
| 5066 | 5066 | 5066 | 5066 | 5066 |

There are 5,066 distinct entries in this window. Even offline Belady produces
**zero completely all-hit tokens** at every simulated capacity: new entries
continue to appear. At the automatic budget, its 7,663-fill bound is 40.3%
below the observed 12,834 fills. That is room in traffic, not a demonstrated
40.3% wall-time saving. Physical SSD traffic and critical-path wait cannot be
deduced from these payload counts alone.

**Decision: KEEP diagnostic; REJECT tested online policy replacements.** Neither
LRU nor the tested SLRU beats the current policy at the automatic capacity.
No production cache code, allocation, route, or budget was changed. Larger
capacities in this table were simulated offline, not admitted on the host.
Generalization beyond this single natural-text trace remains untested.

Reproduction, from the pass-5 artifact directory (choose an unused output path):

```sh
python3 cache_bound.py --self-test --log profile-token-allhit.log \
  --binary trace-routes.bin --output cache-bound-repeat.csv
```

### EXP-5.3 — Metal System Trace attribution and measurement limits

One bounded **profile run**, same 16-token prompt, 128 generated tokens,
131072 allocation, automatic streaming, MTP disabled, completed with exit 0.
The installed `Metal System Trace` template captured 53.129 seconds including
startup and prefill. The final trace is `metal-system.trace`; its exact launch
arguments and environment are in `metal-system-toc.xml`.

The trace's once-per-token seven-encoder command buffer provides 128 anchors.
Adjacent anchors agree with the independent token-latency CSV: in the 126
complete steady intervals (excluding first and unanchored final token), median
anchor discrepancy is 0.061 ms and maximum discrepancy is 0.164 ms. CPU and GPU
intervals were unioned and intersected, not naively summed.

| Observed interval | Mean ms/token | p50 ms/token | p95 ms/token | Fraction of total traced steady wall |
|---|---:|---:|---:|---:|
| GPU active compute intervals | 83.931 | 82.364 | 117.161 | 54.71% |
| Command-buffer creation-to-submission interval, excluding GPU overlap | 19.383 | 17.161 | 39.665 | 12.63% |
| Neither interval active: I/O, other host work, waits, scheduling | 50.096 | 43.237 | 76.547 | 32.66% |
| Total token interval | 153.410 | 146.072 | 231.215 | 100% |

The creation-to-submission interval includes intervening host work; it is not
a measurement of pure encoding CPU cycles. Per-component percentiles are not
additive. Median command-buffer count is 85;
mean is 85.087. Observed host-encoding/GPU overlap averages only 0.0013 ms/token.
This supports investigating serial scheduling; it does **not** make the entire
50.096 ms unattributed interval removable. GPU active intervals can include
device stalls, not just arithmetic. Individual kernel occupancy, bandwidth,
and shader stalls remain **NOT MEASURED**: this template had no counter set and
shader timeline disabled, and `metal-counter-values.xml` contains zero rows.

The same capture's 1 ms CPU samples over these 126 steady tokens attribute
1,601 ms to `ds4_gpu_stream_expert_readahead_range` (12.71 ms/token) and 244 ms
to slab `mlock` (1.94 ms/token). Workers account for 16,849 ms in `pread`, but
that is aggregate sampled time across threads, **not** 133.72 ms/token of
serial I/O wait. Main-thread running samples total 3,131 ms. These samples
corroborate the explicit readahead counter; they do not prove that migrating
the advisory calls to workers would improve overlap or tail latency.

The tracer is intrusive: its benchmark reported 5.97 total / 6.53 steady tok/s,
which are not release-timing numbers. System swap increased approximately
660 MiB during collection; no causal attribution to the model versus tracing
or other applications was established. The benchmark finished all 128 tokens;
the tracer was asked to stop and then allowed to finish saving. No further
full-system capture is planned without narrowing its cost. Trace files remain
local under `/tmp` and may contain unrelated application metadata; do not
publish them without redaction.

Reproducible offline processing tools and outputs: `xctrace_decode.py`,
`metal_critical_path.py`, `metal-submissions-valid.csv`, `metal-gpu-active.csv`,
and `metal-critical-path.csv`. `metal-submissions.csv` is an earlier partial
parser output, not used by the analysis. The parser now consumes only the
first schema-bearing table of an export and rejects inconsistent row shapes.

**Environment correction.** After reconnection, AC power was verified. A
pre-existing Qwen `llama-server` (PID 774) was found inactive but still owning
approximately 7.5 GiB of swapped memory. With explicit user permission it was
terminated; the empty router process was left alone. Any subsequent benchmark
is labeled `ac-exclusive`, not treated as a code A/B against runs with that
different background state. System-wide swap was already present and is not
the same quantity as the benchmark process's swap count. No production source
was changed in this investigation.

### AC/exclusive control after authorized Qwen shutdown

One excluded warm-up and three process-cold repetitions used the **unchanged**
`ds4-bench` SHA-256
`4147de1d864832c48883a9bdac95c48797760ea2a67b95c74677e0c5881bf929`.
AC was attached; no thermal warning was reported. These are native raw decode,
MTP disabled, 16 actual raw prompt tokens, 131072 context allocation, 128
generated tokens, automatic cache, no verbose profilers. This is an environment
control, not a before/after optimization comparison.

| Metric | Warm-up (excluded) | r1 | r2 | r3 | Measured median |
|---|---:|---:|---:|---:|---:|
| Prefill tok/s | 0.58 | 0.62 | 0.63 | 0.59 | 0.62 |
| Total generation tok/s | 6.57 | 6.84 | 6.68 | 7.06 | 6.84 |
| Steady generation tok/s | 7.37 | 7.46 | 7.26 | 7.75 | **7.46** |
| First token ms | 2224.594 | 1701.220 | 1645.581 | 1723.909 | 1701.220 |
| Steady token p50 ms | 116.737 | 119.291 | 122.168 | 113.760 | 119.291 |
| Steady token p95 ms | 223.472 | 196.758 | 215.375 | 214.574 | 214.574 |
| Steady token p99 ms | 358.944 | 499.863 | 463.271 | 355.656 | 463.271 |
| Process wall seconds | 50.97 | 45.28 | 45.27 | 45.89 | 45.28 |
| Process swaps | 0 | 0 | 0 | 0 | 0 |

Measured peak RSS was at most 8,832,139,264 bytes, peak footprint at most
13,513,383,232 bytes. The automatic plan remained 24.86 GiB, with 1,244 dynamic
expert entries (8.20 GiB) and 3.80 GiB prefill headroom. System swap decreased
overall from 9,588.88 to 6,943.25 MiB; this does not mean the system started
swap-free. `pmset` reported no thermal or performance warning. Desktop
responsiveness was not independently rated by a human during this control.

Exact command for each `NAME` (`warmup`, `r1`, `r2`, `r3`), executed separately:

```sh
/usr/bin/time -l env DS4_BENCH_TOKEN_TIMING_FILE="$RUN_DIR/ac-exclusive-$NAME-tokens.csv" \
  ./ds4-bench -m "$DSTUDIO_ROOT/ds4/gguf/GLM-5.3-Flash-Q2.gguf" \
  --metal --ssd-streaming --prompt-file speed-bench/promessi_sposi.txt \
  --ctx-start 16 --ctx-max 16 --ctx-alloc 131072 --step-incr 1 --gen-tokens 128 \
  --csv "$RUN_DIR/ac-exclusive-$NAME.csv" > "$RUN_DIR/ac-exclusive-$NAME.log" 2>&1
```

`RUN_DIR` is the pass-5 artifact directory. The benchmark itself performs
greedy target decode; it has no `--temp` option. No MTP environment or flag
was supplied. `ac-exclusive-before.txt` records binary/prompt hashes, power,
thermal and environment checks.

Current-pass QA: **PASS** `make` (already up-to-date, not a clean rebuild),
**PASS** `make test-glm53-kda` (rebuilt focused test, Metal primitive PASS,
no warnings), **PASS** `git diff --check`. Full current-HEAD official scorer,
boundary/snapshot and release matrix remain **NOT RUN in this pass**; historical
quality results above must not be relabeled as current-HEAD acceptance. No new
runtime optimization is accepted by these control runs.

### EXP-5.4 — bounded all-hit encoder anatomy

The existing `DS4_METAL_ENCODER_TIMELINE` diagnostic was used on six natural
decode tokens with the previously verified 1,134-entry hotlist. All 252 routed
layer calls were all-hit: 2,016 demand hits, zero demand misses/evictions. The
1,134 reported cache misses and 7.48 GiB read were the explicit preload, not
decode demand. No route replay or MTP was used. The hotlist contains future
route information, so this configuration is diagnostic only.

The capture contains exactly 85 batch command buffers per decode token and
valid timestamps for every recorded event. Excluding the first two tokens,
the following are **instrumented GPU event-duration sums**, not release
latencies or an uninstrumented compute floor:

| Kernel family | Mean ms/token in the four profiled tokens |
|---|---:|
| Q8 matrix-vector projections (all shapes, including head) | 27.072 |
| Routed IQ2 gate/up + SwiGLU | 18.817 |
| Routed Q2 down + ordered expert sum | 9.154 |
| Dense Q4_K projections | 7.447 |
| Compact QK low-rank projection | 6.146 |
| BF16 projections | 4.502 |
| Shared Q8 gate/up + SwiGLU | 3.211 |
| Recurrent KDA kernel | 1.541 |
| All recorded events, including remaining graph operations | 90.031 |

The remaining operations are included, not skipped. Per-shape counts, grids,
threadgroup sizes, minima/maxima, and medians are in
`allhit-kernel-anatomy.csv`; `encoder_anatomy.py` validates event counts and
token boundaries. This diagnostic gives each dispatch group a separate
encoder, changing scheduling: observed token times were 2490.661, 216.179,
129.166, 172.878, 130.339, and 124.917 ms. Do not compare these directly with
the unprofiled all-hit floor. No occupancy/stall counter was available, and
no occupancy percentage is inferred from threadgroup count.

Observed geometry narrows the next investigation: IQ2 gate/up already launches
2,048 threadgroups and routed down 512; they are not trivially a three-group
grid. In contrast, the 90 tiny-output BF16 mHC projections launch only three
groups each, and the compact QK low-rank kernel uses 64. Geometry alone is not
proof that changing either schedule helps.

Exact profile command (same `MODEL` and `RUN_DIR` as above):

```sh
/usr/bin/time -l env \
  DS4_METAL_STREAMING_EXPERT_HOTLIST="$RUN_DIR/hotlist-first6.txt" \
  DS4_METAL_STREAMING_EXPERT_TIMING_SUMMARY=1 \
  DS4_METAL_ENCODER_TIMELINE="$RUN_DIR/allhit-encoder-timeline.txt" \
  DS4_BENCH_TOKEN_TIMING_FILE="$RUN_DIR/allhit-encoder-tokens.csv" \
  ./ds4-bench -m "$MODEL" --metal --ssd-streaming --ssd-streaming-preload-experts 1134 \
  --prompt-file speed-bench/promessi_sposi.txt --ctx-start 16 --ctx-max 16 \
  --ctx-alloc 131072 --step-incr 1 --gen-tokens 6 \
  --csv "$RUN_DIR/allhit-encoder.csv" > "$RUN_DIR/allhit-encoder.log" 2>&1
```

The process exited successfully, reported zero swaps and zero `mlock`
failures, and peaked at 13,303,421,744-byte footprint. The timeline is 932 KiB,
not another full-system multi-gigabyte trace.

### EXP-5.5 — full-shape BF16 grid probe, not integrated

**Hypothesis.** The 16384-input, 24-output mHC projection might benefit from
24 one-SIMDgroup threadgroups instead of three eight-SIMDgroup groups without
changing per-row arithmetic. This is a different kernel and measured shape
from the previously rejected global MoE SIMDgroup tuning.

The standalone Objective-C probe `bf16_grid_probe.m` compiles the **original**
checked-out BF16 matrix-vector shader prefix (file SHA-256
`27d93dcfe81b09f93ed65cd986aaa0b9c1ca1df7fc43e58c15da533284d50db5`), with the
same default Metal compile options. It allocates under 1 MiB of payload and
uses deterministic synthetic finite data at the full mHC dimensions. No
GGUF is loaded or changed, no runtime selector is changed, and this is not a
full-model numerical oracle.

**PASS** — warning-strict Objective-C build; 2,200 dispatches, all 24 outputs
bit-identical to the original eight-SIMDgroup result after every 100-dispatch
batch. One warm-up pair was excluded, followed by ten order-alternated pairs.

| GPU microbenchmark | Original (8 SIMDgroups) | Probe (1 SIMDgroup) |
|---|---:|---:|
| Median microseconds/dispatch | 25.998 | 24.273 |
| Min/max microseconds/dispatch | 19.035–37.301 | 16.628–33.374 |

**Decision: REJECT integration on this evidence.** Timings drift strongly
during this short probe and do not establish a stable gain. The pooled median
difference is only 1.725 microseconds per projection (about 0.155 ms over 90
calls), nowhere near a demonstrated end-to-end improvement. No production
change was made or needed reverting. This rules out treating the smaller
threadgroup count alone as sufficient evidence for a fast path; it does not
rule out a differently measured projection implementation.

Commands and retained outputs:

```sh
xcrun clang -O3 -g -std=c99 -Wall -Wextra -Werror -fobjc-arc \
  "$RUN_DIR/bf16_grid_probe.m" -framework Foundation -framework Metal \
  -o "$RUN_DIR/bf16_grid_probe"
"$RUN_DIR/bf16_grid_probe" metal/glm53_bf16.metal "$RUN_DIR/bf16-grid.csv"
```

`bf16-grid-build.log` and `bf16-grid.csv` retain the build and per-pair results.
The unprofiled baseline binaries remain unchanged. The next larger observed
compute costs are Q8 projections and IQ2 gate/up; compact QK low-rank is also
measurable. Any candidate still needs a focused oracle and release-timing A/B,
not extrapolation from this invasive anatomy.

## Pass 6 — exact-arithmetic projection probes and current-main quality baseline

Artifacts: `/tmp/glm53-m2max96-qklow-pass6.SCufLP`. This pass starts from
`b0a147a7fba6d1a104d047d5a140e9bb4bfc13cd` plus the preserved local diff;
`source-before.patch`, `status-before.txt`, and `hashes-before.txt` record it.
The baseline benchmark binary and Metal object were copied into that directory.
**Metal shader sources are loaded at runtime**, so a saved executable alone
does not freeze a benchmark if those sources subsequently change. None of the
production shaders or runtime sources was modified for the probes below.

AC power was confirmed; macOS reported no thermal/performance warning. The
unrelated Qwen worker was stopped with the user's authorization. Only its empty
router remained. System swap still contained historical pages (6,511.25 MiB
at this pass's check); this is not a claim of zero system swap. Production
measurements remain **native raw decode, MTP disabled**, allocation 131072.

### EXP-6.1 — compact QK row-grid probe

**Hypothesis.** The compact QK projection's 64 threadgroups might benefit from
assigning one independent output row per thread across 512 groups, retaining
the exact scalar dot implementation. The prior instrumented anatomy attributed
6.146 ms/token to 11 calls, but that invasive value is not the removable cost.

The probe reads the actual `blk.3.attn_k_b.weight` Q8_0 payload (8,912,896
bytes, absolute GGUF offset 1,632,462,272), with the full shape: 64 heads,
256 input coordinates, 512 output coordinates. GGUF metadata was parsed using
the repository's binary-reading helpers; no model file was modified.

**PASS:** strict warning-free Objective-C compilation, eight finite fixtures
(zero, impulse, six seeded random inputs), all 32,768 output values
bit-identical. Timing also checks output after every ten dispatches. One
1,000-dispatch warm-up per variant is excluded; ten alternating measured
pairs of 100 dispatches follow (4,000 timing dispatches overall).

| GPU microbenchmark | Original | Row grid |
|---|---:|---:|
| Median microseconds/dispatch | 305.826 | 297.248 |
| Min/max microseconds/dispatch | 303.745–307.113 | 296.376–297.738 |

**Decision: REJECT integration.** The median difference is 8.578 microseconds,
about 0.094 ms across 11 calls per token. It does not justify a runtime
specialization or an end-to-end speed claim. This also shows why the invasive
kernel-duration sum must not be used as an unprofiled compute floor.

```sh
xcrun clang -O3 -g -std=c99 -Wall -Wextra -Werror -fobjc-arc \
  "$RUN_DIR/qklow_probe.m" -framework Foundation -framework Metal \
  -o "$RUN_DIR/qklow_probe"
"$RUN_DIR/qklow_probe" "$MODEL" metal/dsv4_misc.metal \
  "$RUN_DIR/qklow_rowgrid.metal" "$RUN_DIR/probe.csv"
```

Here and below `RUN_DIR` is the pass-6 artifact directory and `MODEL` is the
unchanged Q2 path recorded in Environment. `probe-build.log`, `probe.log`,
and `probe.csv` retain the results.

### EXP-6.2 — KDA low-rank Q8 SIMDgroups assigned independent rows

**Observed issue.** For `kda_f_b` and `kda_g_b`, input width is 128, output
width 8192, Q8_0 row size 136 bytes. The generic kernel allocates four
SIMDgroups to two rows, but only the first 16 lanes of SIMDgroup zero have a
quant block to process. There are 68 such projections per native token.
This is a specific block-count mismatch, not another global MoE NSG sweep.

**Candidate mechanism.** Assign two rows to each SIMDgroup, eight rows per
threadgroup. Each row retains its eight-product local accumulation and both
SIMD reduction stages; no inter-SIMDgroup scratch/barriers are needed because
the original other three groups contributed zeros. Gate/KDA recurrence and
all model operations remain outside this primitive and are not approximated.

**PASS:** strict warning-free build; 32 fixtures on each of four real tensors
(`f_b`/`g_b` in layers 0 and 44), including zero, impulse, alternating sign,
large finite values, and seeded random inputs. All 8192 outputs are finite and
bit-identical in all 128 comparisons. Timing validates every ten dispatches;
4,000 timing dispatches include the excluded warm-up and ten alternating
measured pairs. Buffers total about 1.1 MiB, not a full loaded engine.

| GPU microbenchmark | Original | Independent SIMD rows |
|---|---:|---:|
| Median microseconds/dispatch | 34.114 | 7.994 |
| Min/max microseconds/dispatch | 31.642–40.657 | 7.152–10.264 |

**Decision: NOT ACCEPTED — diagnostic candidate only.** Multiplying the
microbenchmark median difference by 68 suggests about 1.78 ms/token, not a
measured end-to-end saving. An exact runtime predicate, complete model
comparison, and release-timing A/B are still required. This result must not be
advertised as a fourfold inference speedup. No production delta is retained.

```sh
xcrun clang -O3 -g -std=c99 -Wall -Wextra -Werror -fobjc-arc \
  "$RUN_DIR/q8_lowrank_probe.m" -framework Foundation -framework Metal \
  -o "$RUN_DIR/q8_lowrank_probe"
"$RUN_DIR/q8_lowrank_probe" "$MODEL" metal/dense.metal \
  "$RUN_DIR/q8_lowrank.metal" "$RUN_DIR/q8-probe.csv"
```

`q8-build.log`, `q8-probe.log`, `q8-probe.csv` preserve evidence. The probe
uses the original checked-out generic shader as its numerical oracle.

### EXP-6.3 — wider generic Q8 output-row tile

**Hypothesis.** Increasing the generic Q8 tile from two to eight output rows,
without changing its four SIMDgroups or either reduction tree, might improve
input reuse on the larger measured Q8 projections. This uses the existing
template implementation, not a new arithmetic approximation.

**PASS:** strict build; 160 real-weight full-shape fixtures, finite and
bit-identical; 20,000 timing dispatches across five shapes with per-shape
warm-up and ten alternating measured pairs. Peak payload allocation is under
35 MiB. No full-model process was active during these GPU probes.

| Input→output | Original median µs | Tile-8 median µs |
|---|---:|---:|
| 128→8192 | 34.993 | 33.072 |
| 4096→8192 | 82.684 | 86.810 |
| 8192→4096 | 79.054 | 85.689 |
| 4096→128 | 4.112 | 6.164 |
| 4096→64 | 3.795 | 6.140 |

**Decision: REJECT.** Larger projections and small-output projections regress;
the low-rank shape benefits much less than the independent-SIMD-row probe.
No runtime change was made, so no production revert is necessary. The result
rules out applying a wider Q8 tile globally based on input reuse alone.

```sh
xcrun clang -O3 -g -std=c99 -Wall -Wextra -Werror -fobjc-arc \
  "$RUN_DIR/q8_tile_probe.m" -framework Foundation -framework Metal \
  -o "$RUN_DIR/q8_tile_probe"
"$RUN_DIR/q8_tile_probe" "$MODEL" metal/dense.metal \
  "$RUN_DIR/q8_tile.metal" "$RUN_DIR/q8-tile.csv"
```

Logs: `q8-tile-build.log`, `q8-tile.log`, `q8-tile.csv`.

### Current-main full quality baseline — completed; final results below

The earlier completed 100-case results precede the current main-port HEAD and
are not substituted for this gate. `make` and `make -C gguf-tools quality-score`
passed with no warnings; `git diff --check` passed. `scorer-build-hashes.txt`
records the exact executable, linked-object and shader hashes.

The complete scorer (no `--max-cases`, no MTP) was launched as the only huge
model process, with automatic bounded streaming and allocation 131072:

```sh
/usr/bin/time -l gguf-tools/quality-testing/score_official "$MODEL" \
  gguf-tools/quality-testing/data/glm53-flash-openrouter-zai-fp8-100/manifest.tsv \
  "$RUN_DIR/current-main-baseline-100.tsv" 131072 --ssd-streaming \
  --dump-first-logits "$RUN_DIR/current-main-baseline-first-logits.bin" \
  > "$RUN_DIR/current-main-baseline-100.log" 2>&1
```

This uses the official manifest and scoring implementation, but the user's
131072 allocation instead of the QA example's 4096 allocation; any candidate
comparison must match 131072. Intermediate cases are not a completed quality
result. `scorer-before.txt` records power, swap, VM counters and DS4 environment.

### Memory-observability correction and safety guard

The current scorer's early `vmmap` reported roughly 1.5 GiB in its SWAPPED
column. `footprint --help` explicitly describes that column as
swapped/compressed. It must not be equated to disk writes, nor ignored in favor
of the historical zero from `time -l`. The checked-out macOS SDK
`sys/resource.h` marks `ru_nswap` as NU; Apple's
[rusage implementation](https://github.com/apple-oss-distributions/xnu/blob/main/bsd/kern/kern_resource.c)
does not update it alongside the task fault/page-in counters in `calcru`.
Consequently the previous zero-swap claims are narrowed at the top of this
report, without replacing any recorded measurements.

A warning-strict C probe uses the permitted read-only task-name port and
`TASK_VM_INFO` revision 6. No privilege, entitlement, security setting, task
state, or process code is changed. The separate
[`ledger_swapins` field](https://github.com/apple-oss-distributions/xnu/blob/main/osfmk/kern/task.c)
is read along with compression, footprint, and decompressions. An interim
sample (`scorer-ledger-check.txt`) returned:

| Observation | Bytes / count |
|---|---:|
| Task resident size | 8,824,291,328 |
| Task peak resident size | 8,991,129,600 |
| Task physical footprint | 13,518,036,336 |
| Task compressed | 214,417,408 |
| Graphics footprint compressed ledger | 1,849,868,288 |
| Task swap-in ledger | 0 |
| Task decompressions since launch | 2,398,648 |

These compression fields have distinct accounting scopes; they are not a
claim that all memory is resident. In particular, a zero swap-in ledger is
not proof that no never-revisited page has been swapped out. System Swapouts
increased by 248 16-KiB pages (3.875 MiB) early in this run and then remained
at 6,304,042 in subsequent observations; the owner of those writes is not
established. System swap usage declined. Memory pressure was normal (level 1),
and the observed footprint stayed near 12.6 GiB. The complete memory gate
remains pending until the run and retained observations are reviewed.

`scorer_guard.py` checks the exact PID, command and start-time identity every
ten seconds. It sends SIGINT only to this owned scorer if its swap-in ledger
becomes nonzero, footprint exceeds a conservative 32 GiB, or memory pressure
is critical/sustained warning. It exits without signalling on identity change
and reports observation failure rather than mistaking it for process exit.
This is an external diagnostic safeguard, not a runtime feature or a stronger
zero-paging guarantee. The model cache budget remains unchanged.

```sh
xcrun clang -O2 -Wall -Wextra -Werror "$RUN_DIR/task_vm_probe.c" \
  -o "$RUN_DIR/task_vm_probe"
python3 "$RUN_DIR/scorer_guard.py" 34852 "$RUN_DIR/task_vm_probe" \
  > "$RUN_DIR/scorer-guard.log" 2>&1
```

PID 34852 identifies this run only; a later run must resolve its own exact
process. The additional `task_vm_ledger_probe.c` prints the graphics ledgers.
`scorer-vmmap-early.txt`, `scorer-footprint-early.txt`, `scorer-task-vm-first.txt`,
`scorer-ledger-check.txt`, and `scorer-vm-interim.txt` retain the observations.
No additional GPU or SSD benchmark is launched alongside the scorer.

## Research pass 7 — bounded I/O preparation and offline layer quotas

Artifacts: `/tmp/glm53-m2max96-mtlio-pass7.Q9Cu3T`. Production sources,
binaries and dynamically loaded Metal shaders remain unchanged while the
current-main 100-case scorer runs. This pass concerns **native raw decode,
MTP disabled**. There is no new end-to-end speed claim.

### EXP-7.1 — per-layer minimum occupancy, offline only

**Hypothesis.** A small guaranteed occupancy per routed layer could prevent
global hotness eviction from starving some layers, reducing misses without
increasing the automatic 1244-slot cache.

`quota_probe.py` preserves the existing hotness/age/key victim comparator,
current-top-8 protection and hit-then-install touch order. It decrements layer
occupancy while selecting each victim, so batch eviction cannot accidentally
cross the quota. If the requested top-8 cannot otherwise fit, demand admission
has priority over the quota. No runtime policy was changed.

**Correctness: PASS** for 400 randomized zero-quota differential traces and
1200 quota lifecycle/invariant traces. Zero quota also reproduces every one
of the 5376 observed layer miss counts from the pass-5 natural routing trace.

| Minimum entries/layer | Total fills | First 64 tokens | Last 64 tokens |
|---|---:|---:|---:|
| 0, current policy | 12,834 | 7,189 | 5,645 |
| 8 | 12,834 | 7,189 | 5,645 |
| 16 | 12,834 | 7,189 | 5,645 |
| 24 | 12,823 | 7,171 | 5,652 |
| 29 | 12,889 | 7,148 | 5,741 |

All variants use 1244 entries, retain eight router-selected experts per layer,
and require no below-quota fallback on this trace. The best total differs by
only 11 fills (0.086%, 74.25 MiB over 128 tokens), while its later half is
worse. Halves of this single trace are descriptive, not independent prompt
validation. Read payload is known; physical SSD traffic, critical I/O wait
and latency p95 cannot be inferred from these fill counts alone.

**Decision: REJECT runtime integration.** The result does not meet the byte
reduction gate and does not justify a costly full-model policy experiment.
No production revert is needed because the simulator is external only.

```sh
python3 /tmp/glm53-m2max96-mtlio-pass7.Q9Cu3T/quota_probe.py \
  /tmp/glm53-m2max96-topology-pass5.2ImgG5/profile-token-allhit.log \
  > /tmp/glm53-m2max96-mtlio-pass7.Q9Cu3T/quota.csv \
  2> /tmp/glm53-m2max96-mtlio-pass7.Q9Cu3T/quota-test.log
```

### EXP-7.2 — Metal resource-loading primitive, prepared but not run

**Hypothesis.** The pass-5 trace attributes substantial time to selected-load
completion and host/GPU gaps. Metal resource loading is a distinct I/O API
experiment, not another worker-count or read-order change. Apple's
[resource-loading description](https://developer.apple.com/videos/play/wwdc2022/10104/)
documents concurrent load commands, completion status and cancellation; it
does not establish that GLM expert loads on this host are faster or avoid
internal staging. Those properties must be measured.

`build_ranges.py` uses the repository GGUF metadata reader and exact recorded
top-8 IDs to validate 96 source ranges: four token/layer groups, eight experts
per group, three unchanged quantized payloads per expert. It verifies tensor
shape, quant type, byte count, model size and route-trace hash without loading
the full model. `expert-ranges.csv` and `fixture-hashes.txt` retain identities.

`mtlio_probe.m` compares the extracted, unchanged nine-worker `pread` pool
against `MTLIOCommandQueue` into final shared buffers. The proposed probe has
one in-flight command buffer, at most nine commands in flight and 162 MiB of
explicit result/oracle payload, locked once before timing. It keeps identical
read-advice policy on both sides and checks every loaded byte. Planned cases
cover one, three and eight experts with an excluded warm pair and ten
alternating measured pairs. The oracle warms the file cache: this is explicitly
an **OS-file-cache-warm API diagnostic**, not an SSD-cold or end-to-end result.

The external probe also contains short-read, invalid-fd and cancellation tests
using only its own tiny temporary file. Their execution and the complete
model/session failure-atomicity gate are **NOT RUN**. The scorer remains the
only huge model; no GPU or payload I/O probe is run concurrently with it.

**PASS:** metadata/range preparation and warning-strict compilation.
**NOT RUN:** runtime byte comparisons, timings, error/cancellation tests,
internal staging measurement and useful I/O/GPU overlap.
**Decision: no runtime integration pending those results.** Before any runtime
candidate, the URL-based Metal handle must also be shown to retain the exact
loaded model file identity, rather than silently opening a replacement path.

```sh
RUN_DIR=/tmp/glm53-m2max96-mtlio-pass7.Q9Cu3T
python3 "$RUN_DIR/build_ranges.py" "$MODEL" \
  /tmp/glm53-m2max96-topology-pass5.2ImgG5/trace-routes.bin \
  > "$RUN_DIR/expert-ranges.csv"
xcrun clang -O3 -g -std=c99 -Wall -Wextra -Werror -fobjc-arc \
  "$RUN_DIR/mtlio_probe.m" -framework Foundation -framework Metal \
  -o "$RUN_DIR/mtlio_probe" > "$RUN_DIR/build.log" 2>&1
```

`MODEL` is the unchanged absolute GGUF path in Environment. The following
command is prepared, **not yet executed**, and must wait for the scorer to exit:

```sh
/usr/bin/time -l "$RUN_DIR/mtlio_probe" "$MODEL" \
  "$RUN_DIR/expert-ranges.csv" "$RUN_DIR/mtlio.csv" \
  > "$RUN_DIR/mtlio.log" 2>&1
```

The probe now also records per-task disk-read/write deltas outside each wall
timing interval, plus Metal allocated bytes and process footprint. These are
task-attributed counters, not a claim that all storage/device work is charged
to that task. CPU `pread` task preparation is included in its wall time, just
as Metal I/O encoding is included on the other side. The updated probe still
compiles warning-clean and remains **NOT RUN**.

### EXP-7.3 — cache lifetime and repack break-even

**Hypothesis.** A different GPU-native payload layout must save enough time
before eviction to repay its on-fill transformation cost. A warm kernel gain
alone cannot answer this for sustained streaming.

The external `reuse_probe.py` retains the original LFU/age/key order and tracks
each installation through eviction or the end of the recorded window.
**PASS:** a hand-computed lifecycle, 500 randomized differential traces,
conservation of every lookup/fill, and all 5376 measured layer miss counts.

| Installation lifetime | Installs | Uses in window | Mean uses/install | Single-use installs |
|---|---:|---:|---:|---:|
| All | 12,834 | 43,008 | 3.351 | 10,773 |
| Evicted in window | 11,590 | 13,441 | 1.160 | 10,710 |
| Still resident at end | 1,244 | 29,567 | 23.768 | 63 |

83.94% of installations have only one observed use. The last row is
right-censored: those entries could have further uses after the trace ends.
This analysis starts from the same observed cache state and does not select
a future hot set for an inference run.

With unchanged slot size/policy and no hidden packing overlap, packing every
fill breaks even only when `pack_cost / saving_per_expert_use < 3.351` over
this window. For example, a **hypothetical, not measured** 10 µs saving per
expert use permits less than 33.511 µs packing per fill and would save at most
3.360 ms/token before packing costs. At 20 µs/use those values are 67.022 µs
and 6.720 ms/token. These are accounting thresholds, not achievable speedups.

Packing only when an entry reaches its second use would trigger 2061
promotions and cover 30,174 remaining uses (14.640 uses/promotion). This is a
possible constraint for a later measured layout experiment, not authorization
to add dual-format cache state now. No repack kernel, new format or runtime
promotion policy was implemented.

**Decision: REJECT unconditional on-fill repack as an unmeasured next patch.**
First obtain a real payload/kernel benefit and transformation cost; retain
the bounded I/O comparison as the next executable experiment after the scorer.

```sh
python3 /tmp/glm53-m2max96-mtlio-pass7.Q9Cu3T/reuse_probe.py \
  /tmp/glm53-m2max96-topology-pass5.2ImgG5/profile-token-allhit.log \
  > /tmp/glm53-m2max96-mtlio-pass7.Q9Cu3T/reuse-lifetimes.csv \
  2> /tmp/glm53-m2max96-mtlio-pass7.Q9Cu3T/reuse-test.log
```

### Scorer memory/I/O observation — incomplete gate, not native timing

At 00:22:53 Europe/Rome on September 5, the original scorer was still alive.
`scorer-memory-interim.txt` records pressure level 1, zero task swap-ins,
13,531,798,920 bytes footprint, 209,207,296 task-compressed bytes and
1,198,374,912 graphics-footprint-compressed bytes. Compression fields have
different accounting scopes and must not be added blindly. The task reported
11,940,419 decompressions since launch; no CPU/GPU duration is attributed to
that count without a phase-specific measurement.

Importantly, system Swapouts had reached 6,346,259 pages, **42,465 pages
(663.516 MiB) above the pre-scorer observation**, not merely the early
3.875 MiB delta. System swap usage fell from 6479.25 MiB to 4457.50 MiB.
Writes and current occupancy are different metrics; the owner of those swap
writes is not established. This supersedes any inference of a flat whole-run
system swap counter from early samples. The process zero-swap gate remains
**UNPROVEN**, despite normal pressure and its zero swap-in ledger.

`proc_io_probe.c` adds a read-only `proc_pid_rusage` observation without model
instrumentation. Strict compilation and seven argument/missing-process cases
plus ten self-observation identity/monotonicity checks passed. The later
`scorer-proc-io-v2.txt` records 3,895,655,522,304 task-attributed disk-read bytes
and 7,507,968 disk-written bytes since launch. These are full-scorer counters,
including repeated prefill, not native decode bytes/token. Apple's
[task rusage implementation](https://github.com/apple-oss-distributions/xnu/blob/main/osfmk/kern/bsd_kern.c)
supplies separate task I/O and logical-write accounting. Neither field proves
the absence of swap writes performed by other kernel work.

The observer preserves raw CPU absolute-time counters and the runtime
timebase (125/3 on this host). The first exploratory snapshot labelled those
two raw fields `user_ns`/`system_ns` incorrectly; they are **not nanoseconds**.
That raw artifact is retained with this correction; the v2 output and source
use `user_abstime`/`system_abstime`. No timing claim uses the incorrect labels.

```sh
xcrun clang -O2 -std=c99 -Wall -Wextra -Werror \
  /tmp/glm53-m2max96-mtlio-pass7.Q9Cu3T/proc_io_probe.c \
  -o /tmp/glm53-m2max96-mtlio-pass7.Q9Cu3T/proc_io_probe
/tmp/glm53-m2max96-mtlio-pass7.Q9Cu3T/proc_io_probe 34852
```

The two-second host sample retained in pass 6 captured
`ds4_session_sync → glm_graph_forward_indexed_tokens → ds4_gpu_end_commands`
with the main thread waiting for Metal and idle SSD workers. This is a
**prefill** observation, not proof of the native decode bottleneck or a pure
GPU compute duration. Any residency/compression experiment must first repeat
the new task counters on the actual native decode window. No residency or
cache budget setting was changed during the scorer.

### I/O identity test preparation

The external Metal I/O probe now tests file replacement explicitly. It creates
two private 512-byte temporary fixtures, replaces only its own first pathname,
then compares a Metal `/dev/fd/N` URL with a pathname URL. A passing result must
read the original bytes through the still-owned descriptor and the replacement
bytes through the pathname. Both tiny fixtures are retired after completion.
The model load uses the still-owned descriptor URL too; no GGUF file is renamed,
written or replaced by this test.

This is **compiled, NOT RUN**, pending scorer completion. Support for descriptor
URLs and exact identity retention is not assumed from POSIX behavior alone.
An unsupported or mismatching result rejects this proposed I/O integration;
the production `pread` path remains unchanged. The focused probe is not a
session rollback, cancellation or publication oracle for a future runtime patch.

### Scorer artifact checker

`verify_score.py` independently checks the final 100 ordered IDs against the
official manifest, finite TSV fields, integer counts, NLL/mean serialization
consistency and the unique final summary. Missing/truncated cases cannot pass.
Its focused synthetic tests passed, including rejection of duplicate/missing
cases, absent/duplicate summaries, NaN and inconsistent totals. Decimal bounds
cover only the scorer's printed `%.9f`/`%.3f` rounding, not model-logit drift or
quality tolerance. The complete live TSV check remains pending until exit.

The current scorer's `--dump-first-logits` saves **only the first target token
of case_000**, not every case or continuation step. Despite the chosen `.bin`
suffix it is textual `# ds4 first logits v1` with hexadecimal float values.
The already-complete dump was checked: 154,880 ordered finite logits,
argmax/target both token 2, SHA-256
`78d36f292772df73118818252f8bc681b0241e59463ce9f274892a4d63acdcc4`.
This is a first-case artifact check, not a 100-case quality result. The scorer
itself checks every full-logit vector for finiteness during continuation.

```sh
python3 /tmp/glm53-m2max96-mtlio-pass7.Q9Cu3T/verify_score.py --self-test \
  --first-logits /tmp/glm53-m2max96-qklow-pass6.SCufLP/current-main-baseline-first-logits.bin
```

Evidence: `score-verifier-test.log` in pass 7. The verifier is an external
artifact audit; no repository test or scorer implementation was modified.

The external `analyze_mtlio.py` also passed synthetic completeness, duplicate,
byte-mismatch and nonfinite-value rejection tests (`mtlio-analysis-test.log`).
It requires all 264 planned samples and excludes round -1 before comparing
40 paired measurements per expert count. It reports per-range-set median
spread and nearest-rank p95, without treating aggregate CPU/read time as a
serial component. This is analysis preparation only; no I/O performance
result is claimed until the actual probe has executed and passed.

### Current-main scorer completion — September 5

**PASS: complete official scoring execution and artifact validation.** The
original process (PID 34852) exited with status 0 after 5381.00 s; its safety
observer exited normally without sending a stop signal. All 100 cases and
11,559 continuation tokens are present, with finite local logits throughout
the scorer. This run uses **native raw decode, MTP disabled**, automatic
streaming and a 131072-token allocation; it is a quality workload, not a
native generation timing run.

| Quality metric | Current-main local baseline | QA section 3 Q2 reference | QA compact-graph reference |
|---|---:|---:|---:|
| Weighted NLL | 0.458046251 | 0.458030488 | 0.458177271 |
| First-token match | 89/100 | 89/100 | 90/100 |
| Mean greedy prefix | 7.110 | 7.370 | 7.390 |

The NLL and first-match values are close to the current accepted references;
the shorter mean greedy prefix is recorded, not concealed. The earlier local
pre-main report has mean prefix 7.110 too, but its complete TSV is not present
in the retained current directories. **NOT RUN: a complete paired per-case
comparison against that older build.** No bit-identical old/new continuation
claim is made. The completed current-main TSV is the authoritative local
baseline for the next candidate. API-logprob agreement is **NOT AVAILABLE**:
the scorer reports zero comparable API target/top-logprob coverage, not a
perfect API match.

The command is retained in the pass-6 section. Its executable, objects and
runtime-loaded shaders were hash-checked again before completion and had not
changed. Artifact directory:
`/tmp/glm53-m2max96-qklow-pass6.SCufLP`.

- `current-main-baseline-100.tsv`, SHA-256
  `f71847be441242b61c472b172e914cb051cc647a03f58e64c5ce4a7d4d9b0f97`;
- `current-main-baseline-100.log`, including final summary and resource report;
- `scorer-artifact-verification.log`, independently checked 100 manifest IDs,
  finite fields, NLL totals and first-case full vocabulary;
- `current-main-baseline-first-logits.bin`, text dump of case_000 only;
- `scorer-guard.log`, `scorer-guard-summary.txt` and `scorer-99-vmstat.txt`.

Peak RSS was 8,991,129,600 bytes; peak footprint 13,566,041,504 bytes.
All 505 guard observations report normal pressure (level 1) and zero task
swap-ins; the last live observation records 32,738,623 decompressions.
System Swapouts grew by 58,487 pages, **913.859 MiB**, while swap occupancy
fell from 6479.25 to 3971.50 MiB. The owner of these writes remains unknown,
so **zero process swap is still UNPROVEN**, not passed. The final live
`proc_io_probe`/ledger attempt raced with normal process exit and produced
empty `scorer-99-proc-io.txt`/`scorer-99-ledger.txt`; they are not zero-value
measurements. The resource report's negative page-reclaim value and zero
`ru_nswap` must not be interpreted as reliable paging totals.

### EXP-7.2 execution — raw Metal I/O short-source failure

After the scorer and its observer exited, process inspection found no loaded
model competing with the bounded probe. `mtlio_probe` ran alone, exited 1
in 0.52 s and used 183,025,664 bytes peak RSS. The GGUF was opened read-only;
all malformed data came from the probe's own 512-byte file.

**PASS:** descriptor URL preserves original file bytes after pathname
replacement; the unchanged `pread` reference rejects short reads and an
invalid descriptor. **FAIL:** a Metal I/O request for 1024 bytes from that
512-byte file did not report Error/Cancelled. Timing and subsequent
cancellation tests were deliberately not reached; no comparison CSV was
produced.

A diagnostic-only rerun added status and destination inspection without
changing the failure assertion. Three sequential runs reproduced:

```text
status=3 (MTLIOStatusComplete), error=none
prefix_matches=1, tail_zero=0, tail_unchanged=512
```

The missing half retained its `0xa5` sentinel. On this host, completion status
alone is therefore **not an exact-byte-count validation**. This is a local
observation, not a claim about every Metal version. The current SDK's
`MTLIOCommandBuffer.h` and Apple's
[I/O command-buffer documentation](https://developer.apple.com/documentation/metal/mtliocommandbuffer)
expose status/error but no returned per-read byte count.

**Decision: REJECT the unguarded drop-in replacement.** No production cache,
kernel or model code was changed, so no production revert is needed. A future
checked variant must reject EOF/truncation and validate identity/ranges before
publishing a cache entry; those checks must be included in its measured cost.
The failed assertion will not be disabled to obtain performance numbers.

Evidence in `/tmp/glm53-m2max96-mtlio-pass7.Q9Cu3T`:
`mtlio.log`, original binary `mtlio_probe`, original source snapshot
`mtlio_probe.before-eof-diagnostic.m`, warning-clean `eof-build.log`,
`mtlio_probe_eof`, and `eof-r1.log` through `eof-r3.log` (each exit 1).
The first failed run's 512-byte temporary fixture is retained as
`short-read-failed-fixture.bin`; later probes clean their own tiny fixtures
after I/O completion. No user model file was moved, replaced or deleted.

## Pass 8 — checked I/O experiment, then resident-mode request

Artifacts: `/tmp/glm53-m2max96-mtlio-guard-pass8.2cVDVG`.
No production code or existing binary changed in this pass.

### Checked Metal I/O — REJECT synchronous integration

The external `mtlio_guard_probe.m` adds `fstat` identity, size, mtime/ctime
and checked source/destination bounds before encoding and after completion.
These checks are included in the measured wall/CPU intervals. The original
raw short-source failure test and binary remain preserved in pass 7; they
were not weakened or reclassified as passing.

**PASS, three runs:** exact valid bytes, EOF, preexisting truncation, invalid
descriptor/count and offset/length overflow rejection. A shared event in the
test only holds a submitted I/O operation while its own 1024-byte fixture is
truncated to 512 bytes: raw Metal status is Complete, but the checked result
is rejected before consumption. All 48 cancellation attempts were reported
Cancelled and rejected. This is a primitive gate, not a full-session rollback
or arbitrary device-error oracle. Metadata validation is not a payload
checksum and is not represented as protection against adversarial rewriting
that defeats file identity/version observations.

Each run verifies all 264 payload samples byte-for-byte. An excluded warm pair
and ten alternating measured pairs are used for each of four real expert
sets and three miss sizes. This is **OS-file-cache-warm**, with zero
task-attributed disk-read bytes in the timed samples; physical SSD-cold
latency and useful GPU overlap were not measured.

| Experts loaded | `pread` median ms | Checked MTLIO median ms | Latency change |
|---|---:|---:|---:|
| 1 | 0.302000 | 0.377979 | +25.16% |
| 3 | 0.696958 | 0.864354 | +24.02% |
| 8 | 1.989167 | 2.145125 | +7.84% |

Values are medians of three run medians. Per-run distributions, nearest-rank
p95 and paired counts are in `summary-r1.txt` through `summary-r3.txt`;
full measurements are `guarded-r1.csv` through `guarded-r3.csv`. MTLIO is
slower in all three runs for every shape. Maximum observed Metal allocation
was 170,262,528 bytes, peak RSS 183,123,968 bytes and footprint 174,785,208
bytes. Internal staging is not inferred from these totals.

**Decision: REJECT synchronous runtime integration.** The checked API adds no
measured benefit even before full-model admission and state integration.
No production revert is needed. Compilation initially caught a potentially
uninitialized local `stat` object; zero-initialization fixed it without
weakening warnings. `build-first.log` retains the failure and `build.log` is
warning-clean with `-Wall -Wextra -Werror`.

```sh
xcrun clang -O3 -g -std=c99 -Wall -Wextra -Werror -fobjc-arc \
  "$RUN_DIR/mtlio_guard_probe.m" -framework Foundation -framework Metal \
  -o "$RUN_DIR/mtlio_guard_probe"
/usr/bin/time -l "$RUN_DIR/mtlio_guard_probe" "$MODEL" \
  "$RUN_DIR/expert-ranges.csv" "$RUN_DIR/guarded-r1.csv"
```

### User scope change — full residency, no further SSD-streaming runs

On September 5 the user requested no more SSD streaming and full in-memory
loading. The I/O runs above had already finished. The planned native
streaming memory-profile run was **NOT STARTED**, and no other streaming
inference was launched after this instruction.

Before attempting residency, `resident_plan.c` opened the model through the
public engine API with `inspect_only=true`, no warmup and no session. It used
the current public estimator with `ssd_streaming=false`, context 131072 and
MTP disabled. **PASS:** metadata-only execution, exit 0, peak RSS 15,450,112
bytes. No model payload residency or inference was attempted.

```text
Physical RAM:           103079215104 bytes = 96.000000 GiB
Model:                   96505816384 bytes = 89.878045 GiB
Graph/context:            4966609296 bytes =  4.625515 GiB
  compact history:        1568714752 bytes
  scratch/fixed state:    3397894544 bytes
Model + graph:           101472425680 bytes = 94.503561 GiB
Remaining before OS:                         1.496439 GiB
```

At preflight, the host already had approximately 3.51 GiB wired memory,
7.65 GiB compressor storage and active user applications; system swap usage
was 3971.50 MiB. Pressure was normal, but this is not enough headroom for a
94.50 GiB fully resident plan with the existing zero-swap/responsiveness
requirements. Allocated context remains 128K; it was not silently reduced.

The existing local `DS4UI_GLM53_STREAMING` branch in
`glm_graph_memory_guard_for_compact_cap()` returns early for GLM 5.3, so a
normal resident launch cannot be assumed to fail safely at that guard. This
inherited user change was not edited. **NOT RUN: full resident loading**;
no guard, power setting or OS protection was changed to force admission.

Evidence: `resident-plan.log`, warning-clean `resident-plan-build.log`,
`resident-preflight-vmstat.txt`, `resident-preflight-sysctl.txt`. Any next
resident experiment needs a demonstrably safe memory plan or a user choice
that changes the currently incompatible constraints; a bare omission of
`--ssd-streaming` does not establish actual full residency or safe capacity.

### Resident feasibility follow-up — metadata only, no runtime change

The existing diagnostic `DS4_GLM53_DISABLE_INDEXED_PREFILL=1` was applied
only to the metadata-only estimator, never to an inference run. Context
allocation remained 131072 and MTP remained disabled. **PASS:** exit 0,
15,433,728-byte peak RSS. The estimated graph falls from 4,966,609,296 to
3,837,006,224 bytes, saving 1,129,603,072 bytes (1.052024 GiB). The total
file-plus-graph plan is still 93.451536 GiB, leaving only 2.548464 GiB
before macOS and other applications. This is not a validated optimization.

The reason the diagnostic does not eliminate all prefill workspace is
explicit in `glm_graph_batch_row_cap()`: a zero indexed-prefill cap still
leaves the GLM 5.3 batch row cap at 2048. The compact 128K history remains
unchanged. No batch size, context frontier, numerical path or admission
guard was modified.

`resident_tensor_audit.py` then parsed only the GGUF metadata with the
repository's quantization-layout helpers. It checked all 1412 unique tensor
names, shapes, sizes, non-overlapping payload ranges and file bounds, plus
descriptor identity/size/timestamps before and after parsing. It confirmed
46 blocks including one nextn block, and used the runtime 16,384-byte page
size for page-union accounting. No tensor payload was read or transformed.
**PASS:** exit 0, peak RSS 26,230,784 bytes.

| Tensor group | Count | Payload bytes | Payload GiB |
|---|---:|---:|---:|
| Global embedding/output | 3 | 1,348,091,904 | 1.255508423 |
| Ordinary target blocks 0–44 | 1380 | 92,871,393,528 | 86.493225329 |
| MTP block 45 | 29 | 2,276,813,952 | 2.120448232 |

The ordinary-target tensor page union is 94,219,517,952 bytes. The pages
exclusive to MTP account for another 2,276,802,560 bytes; this union avoids
double-counting shared boundary pages. The normal, non-streaming engine
currently registers the entire tensor region with Metal, including MTP,
even when drafting is disabled. `weights_bind()` binds that block but the
ordinary target execution excludes it. Omitting unused MTP pages from
resident registration is therefore a source-supported memory hypothesis,
not a change implemented or validated here.

Even hypothetically excluding those MTP pages, the current estimated graph
would bring ordinary-target weights plus graph to 92.374279 GiB. Combining
that hypothetical mapping change with the diagnostic prefill setting gives
91.322255 GiB, leaving 4.677745 GiB before OS/driver/application overhead.
Neither figure proves safe admission, actual residency, or equivalent
prefill performance. No model layers used by ordinary target decode were
excluded from this accounting.

At 01:40 CEST on September 5, pressure was normal but the host still had
3.46 GiB wired memory, 7.18 GiB compressor storage and 3971.50 MiB system
swap occupied, with multiple active user applications. Wired/compressed
observations are not an additive prediction of future application memory;
they nevertheless provide no safe margin for the current fully resident
plan. No application was terminated and no heavy model process was started.

```sh
/usr/bin/time -l env DS4_GLM53_DISABLE_INDEXED_PREFILL=1 \
  "$RUN_DIR/resident_plan" "$MODEL" \
  > "$RUN_DIR/resident-plan-serial-diagnostic.log" 2>&1
/usr/bin/time -l python3 "$RUN_DIR/resident_tensor_audit.py" "$MODEL" \
  > "$RUN_DIR/resident-tensor-audit.log" 2>&1
```

Here `RUN_DIR` is `/tmp/glm53-m2max96-mtlio-guard-pass8.2cVDVG` and the
model path is unchanged. **NOT RUN:** resident model launch, resident
throughput, resident quality/state QA, or resident zero-swap validation.
Production sources and binaries remain unchanged; `git diff --check` passes.

### Resident admission audit — current device limits and estimator omissions

The next continuation performed only device-property queries and source
inspection. The preceding turn is classified as **progress**: the independent
GGUF metadata audit quantified unused MTP payloads and ruled out treating the
existing indexed-prefill rollback as a sufficient memory solution. The
resident launch remains blocked by unproved safe admission; this is not a
wait on a live model process.

`resident_device_caps.m` creates the default Metal device but no explicit
queue, library, pipeline, buffer, model mapping or residency set. Its
warning-clean build and execution passed. Peak RSS was 11,436,032 bytes.
Metal reported 65,536 allocated bytes from device/framework initialization,
not a model allocation.

```text
Device: Apple M2 Max, unified memory true
Physical memory:                103079215104 bytes = 96.000000 GiB
recommendedMaxWorkingSetSize:    100780736512 bytes = 93.859375 GiB
maxBufferLength:                 62620631040 bytes = 58.320007 GiB
iogpu.wired_limit_mb:            96112
iogpu.wired_lwm_mb:              0
```

**Environment discrepancy:** the current recommended working set is not the
88 GiB seen in earlier startup logs. Its value equals the currently observed
wired-limit setting in MiB. This pass neither changed that setting nor
established who changed it or when. It must not be attributed to a runtime
optimization. System pressure was normal and swap occupied 3963.50 MiB at
this snapshot; neither observation guarantees safe additional residency.

Apple describes the recommended size as an approximate performance
threshold, not a guarantee of available physical memory. Its residency
request may postpone preparation when other applications need resident
resources. Consequently, neither property nor a successful residency request
alone establishes a fully resident, zero-paging run.
Sources: [recommendedMaxWorkingSetSize](https://developer.apple.com/documentation/metal/mtldevice/recommendedmaxworkingsetsize),
[requestResidency](https://developer.apple.com/documentation/metal/mtlresidencyset/requestresidency()).
The Markdown versions were read directly after the web reader rejected their
content type.

Source inspection also found a material accounting omission. For this Q2
artifact, `glm_graph_layer_uses_generic_routed_moe()` is true because gate
weights are IQ2_XXS. Graph admission allocates the following independent
owned tensors in addition to the ordinary FFN intermediates:

| Q2 graph tensors | Formula at 2048 admitted prefill rows | Bytes |
|---|---|---:|
| `batch_routed_gate` and `batch_routed_up` | `2 * 2048 * 8 * 2048 * 4` | 268,435,456 |
| `batch_routed_down` | `2048 * 8 * 4096 * 4` | 268,435,456 |
| Single-token `routed_gate`, `routed_up`, `routed_down` | `8 * (2 * 2048 + 4096) * 4` | 262,144 |
| Total missing explicit estimator terms | | **537,133,056 (512.25 MiB)** |

These allocations are explicit in `glm_graph_alloc_slice()`'s allocation body
(`ds4.c`, `routed_*` and `batch_routed_*` fields), whereas
`glm_graph_workspace_bytes_for_cap()` and `glm53_graph_fixed_state_bytes()`
contain no corresponding routed gate/up/down terms. This is a source-level
discrepancy, not a measured full-process peak or a complete reconciliation of
every estimator term. The previous 94.503561 GiB estimate therefore must
**not** be treated as a hard upper bound. Adding only these identified
omissions yields approximately 95.003805 GiB, still excluding OS and
unreconciled backend/driver overhead. Disabling indexed prefill leaves the
batch row cap at 2048 and does not remove these allocations.

The separate GLM grouped-MoE helper's private scratch must not be added
again just because its formula is similar: this Q2 graph selects the generic
IQ2 routed dispatcher, which receives the owned graph buffers. No claim is
made here that the non-Q2 grouped helper runs on the target.

The normal model map remains `newBufferWithBytesNoCopy` over the tensor
region, with overlapping views required by `maxBufferLength`; shared
boundary pages are not duplicate physical payloads. Startup's default
one-MiB-stride validation touch is deliberately not a dense prefetch. No
such model mapping, touch, residency request or inference was attempted.

```sh
xcrun clang -O2 -std=c99 -Wall -Wextra -Werror -fobjc-arc \
  "$RUN_DIR/resident_device_caps.m" -framework Foundation -framework Metal \
  -o "$RUN_DIR/resident_device_caps"
/usr/bin/time -l "$RUN_DIR/resident_device_caps" \
  > "$RUN_DIR/resident-device-caps.log" 2>&1
sysctl vm.swapusage kern.memorystatus_vm_pressure_level \
  iogpu.wired_limit_mb iogpu.wired_lwm_mb \
  > "$RUN_DIR/resident-device-live-sysctl.txt"
```

Artifacts remain in `/tmp/glm53-m2max96-mtlio-guard-pass8.2cVDVG`, including
`resident-device-caps-build.log`. **NOT RUN:** full-resident loading and all
dependent performance/quality/state gates. No production code, operating
system setting or user application was changed. The memory-estimator and
resident-footprint issues remain unresolved; no speedup or safe resident
capacity is claimed.

### Blocked audit — September 5, 01:51 CEST

The preceding continuation was **progress**, because it found the Q2
workspace-accounting omission and revalidated current Metal limits. This
continuation is a **no-progress revalidation**, not a verified wait:
`resident-blocker-recheck.log` confirms that no DwarfStar model, scorer or
probe is running and that the capacity condition remains unresolved.

The same blocker has persisted across the initial resident preflight, the
MTP/tensor accounting continuation, the Metal/admission audit, and this
recheck: full residency of the current Q2/128K plan has no safe OS/application
headroom, while further SSD-streaming runs are explicitly disallowed.
The current unmodified plan cannot meet the no-thrashing/responsiveness
requirements merely by changing launch flags. The live desktop still has
active Java/Lunar, Chrome, Discord and other applications; none was closed
under the old permission to terminate a different model process.

The goal is therefore **BLOCKED, not complete**. Continuing full-model
performance/quality validation requires a user-directed change in desktop
resource availability and a reconciled/reduced resident memory plan, or a
different explicitly approved capacity constraint. Closing applications
alone is not represented as sufficient. The proposed MTP mapping/workspace
reductions remain unimplemented and unvalidated. Further unchanged memory
polling, relaunching the completed scorer, or unrelated microbenchmarks
would not establish safe admission and will not be substituted for the
requested end state. All prior work and artifacts remain preserved.
