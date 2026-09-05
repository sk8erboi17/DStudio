# GLM 5.3 Q2 / M2 Max — managed main port

2026-09-05. **The port is integrated and locally built. Full-model release QA
is not complete.** This pass packages the already measured implementation; it
does not claim a new inference speedup or a DeepSeek speedup.

## Delivery and activation

The maintained engine delta is [`native-decode.patch`](native-decode.patch),
SHA-256 `497f378a4aecb1ccb427358e06eed0eaf0a75ef27fd32b93d482da1f0eef93fa`.
It is byte-identical to the previously delivered patch. No new engine algorithm
was added in this integration pass. The source worktree was not edited.

The destination is `DStudio/ds4`, branch `main`, upstream commit
`b0a147a7fba6d1a104d047d5a140e9bb4bfc13cd`, with its existing DStudio patches.
The DStudio baseline was `a8ba8af78b5b1256356b765a6ca748b147dfabf4`, already dirty.
No commit, checkout, fetch or pull was performed on either real checkout.
Unrelated ongoing Cowork/PDF/UI/PLD changes were preserved, not incorporated as
new GLM optimizations.

The macOS hook `scripts/apply-ds4-glm53-m2max.sh` applies the complete patch
after the existing GLM runtime patch and restores it before that patch during
managed updates. This is the existing DStudio managed-source patch pattern:
the `.patch` is the maintained artifact; the build checkout contains its
reversibly applied result. It is not a second permanent source fork.

The hook uses `git apply` from Apple Command Line Tools, also on source archives.
All hunks are checked before application; source drift and partial states fail
without applying other hunks. It neither stages files nor uses a parent Git
index. Linux and non-GLM checkouts are skipped by this packaging hook. The
compiled Metal runtime has its own exact device/model/layout predicate.

- GLM53 Q2, Apple M2 Max, 288 routed experts / top-8, one-token decode,
  IQ2_XXS gate/up and Q2_K down, SSD streaming, single GPU: cache-backed path.
- The ordered active-cache index follows that same narrow activation.
- The short-resume path additionally requires allocation >=131072 and 1..7
  appended tokens. It does not change the dense/sparse frontier.
- Other shapes/devices keep their existing paths; DeepSeek's fixed top-6
  kernels are unchanged. Shared small host bitsets are included, without a
  claimed DeepSeek performance benefit.
- Existing disable switches remain available. The integrated-MTP static-map
  correctness fix is preserved, but MTP was not enabled or benchmarked.

This hook **does not enable SSD, MTP or PLD, change context, choose a cache
budget, replace a model, or change the user's saved settings**. The current
GLM Q2 file is not safely full-resident at 128K allocation on this 96 GiB host.
The inherited memory-guard bypass is not proof that residency is safe.

## Build integration

Chat checks the actual server binary for the managed GLM capability as well as
exact throughput metrics. Agent/Cowork and the derived Chat builder apply the
hook before their freshness checks; Design launch applies it before its
existing source-signature build. The update path restores in reverse order and
refuses to fetch/pull if tracked user edits remain afterward.

Rebuilt here: `ds4`, `ds4-bench`, `ds4-server`, `ds4-agent-jsonl`, `ds4-cowork`,
`ds4-server-pld`, `ds4-design`, `dstudio`, and the local `DStudio.app`. Building
the existing PLD derivatives is not a PLD inference/performance test. Their
temporary Agent/server sources were restored/removed by the existing builders.
The native Agent/server source bytes still match the pre-integration backup.
The saved engine selection already points to `DStudio/ds4`; it was not changed.

From the DStudio root, inspection and model-free verification:

```sh
DS4_DIR="$PWD/ds4" sh scripts/apply-ds4-glm53-m2max.sh check
node tests/integration/glm53_m2max_patch_test.mjs ds4
make -C ds4 -j2
make -C ds4 test-glm53-kda test-metal-stream-index
make test-lan-unit test-glm53-m2max-patch test-pld test-frontend-unit test-design-build-freshness
```

Use `restore` instead of `check` to remove this port's hunks. That changes source
only, not an already linked executable; rebuilding is required to change the
binary. Do not restore/apply patches concurrently with another build or update.

## QA from this integration pass

| Command / check | Status |
|---|---|
| `node tests/integration/glm53_m2max_patch_test.mjs` | PASS: all shipped anchors, dry check, apply/restore, idempotence, drift, partial state, unrelated edits, spaces, parent Git isolation, platform skip |
| Same command with `ds4` argument | PASS: complete five-patch stack on a local pristine clone; exact tracked-source restoration. Legacy hooks leave their existing `.orig` backups |
| `make -C ds4 -j2` | PASS, Metal, warning-clean |
| `make -C ds4 test-glm53-kda test-metal-stream-index` | PASS, actual M2 Max Metal; synthetic bounded data, no GGUF load |
| Top-8/cache focused test | PASS: 1152 installs/replacements, same ordered victims, 3840-byte index; Q2 real 2048x4096 shape, counts 1/2/6/7/8, exact CPU oracle, invalid/null guards |
| `make -C ds4 ds4_test`; `(cd ds4 && ./ds4_test --server)` | PASS, model-free server parsing/rendering |
| `make -j2 dstudio tests/.build/dstudio-server-test tests/.build/lan_unit`; `make app` | PASS, warning-clean builds and local bundle |
| `make test-lan-unit test-glm53-m2max-patch test-pld test-frontend-unit test-design-build-freshness` | PASS; PLD's 27885 assertions use a stateful test double, not real-model quality evidence |
| `./tests/.build/dstudio-server-test --build-jsonl "$PWD/ds4"` | PASS, Agent and Cowork compiled; repeat cached |
| `./tests/.build/dstudio-server-test --build-server-pld "$PWD/ds4"` | PASS, derived Chat compiled; repeat cached |
| `DS4_DIR="$PWD/ds4" bash extension/design/build-design.sh build` | PASS, Design compiled; repeat cached |
| Binary marker checks and packaged hook/patch byte comparison | PASS |
| `git diff --check`; `git -C ds4 diff --check` | PASS |
| CPU compile-only and ASan/UBSan | NOT RUN again here; PASS for this identical patch in the preceding port phase, logs archived below |
| Full `make test` / general Metal suite | NOT RUN again here; preceding phase had 29 identical baseline/candidate Metal assertions and stopped the unsafe default-model snapshot gate. Not a green full-suite result |
| Live CLI questions, GLM scorer, logits/boundary/snapshot, native session batch, performance A/B | NOT RUN — full residency unsafe at 128K; the earlier no-SSD instruction was not silently overridden |
| MTP, PLD inference, vision, CUDA/ROCm, distributed/TP/RDMA, other Mac devices | NOT RUN — out of this integration scope or unavailable hardware/permission |

The model-free tests do not prove full session error atomicity, continuation
quality or absence of silent full-model errors. The historical QA record is
[`PORT_QA.md`](PORT_QA.md), copied unchanged from the prior, then-unapplied
delivery. Its statement that the destination is unapplied describes that earlier
phase, not the current managed build.

## Performance and memory

No inference benchmark was run during this integration. Native raw decode,
MTP disabled: **no new tok/s, p50/p95 or first-token number**. Historical source
measurements (not validation of these rebuilt DStudio binaries) are preserved in
[`PERF_GLM53_M2MAX96.md`](PERF_GLM53_M2MAX96.md): 7.46 tok/s median
(7.26..7.75), 16 actual raw prompt tokens, 131072 allocation, automatic SSD
streaming. The historical completed scorer records NLL 0.458046251,
first-token match 89/100 and mean greedy prefix 7.110.

This pass ran on battery (61% initially, 55% at the recorded final check),
Apple M2 Max / 96 GiB. Host swap was already present: 3671.06 -> 3623.06 MiB;
pressure level stayed 1 at the sampled checks. These are host observations,
**not a process zero-swap result**. No large model or listening server was
started. No model file, power mode, protection, port or streaming preference was
changed. No new performance experiment was retained or reverted.

## Backup, artifacts and old worktree

Durable local archive/log directory, outside the old worktree:

`DStudio/.tmp/glm53-port-finish.3FQTPN/`

- `glm-worktree-before.tar.gz`: old working files, local changes, reports and
  ignored binaries. Its `gguf` entry remains a symlink, not a model copy.
- `ds4-common-git.tar.gz`: the shared Git metadata/objects, including shallow
  boundaries. **Keep this together with the worktree archive.**
- `glm-branch.bundle`: supplemental only. Standalone clone FAILED because this
  is a shallow repository; bundle verification against the source was not a
  sufficient restore test. Do not use this bundle alone as the backup.
- `recovered-working.patch`, `recovered-status.txt`, `recovered-git-fsck.log`:
  a separate restore using the common-Git archive plus worktree archive produced
  an identical source diff and status. Git fsck exited 0 with dangling-object
  notices, not corruption errors.
- `ds4-sources-before.tar.gz`, `ds4-binaries-before.tar.gz`,
  `dstudio-touched-before.tar.gz`, `dstudio-app-before.tar.gz`: pre-change
  recovery copies. The old generated app bundle was replaced by `make app`;
  it is recoverable from its archive.
- `previous-port-qa.tar.gz`, `historical-scorer.tar.gz`,
  `historical-timing.tar.gz`: copies of the earlier `/tmp` QA and CSV artifacts.
- `build-*.log`, `glm-focused.log`, `server-parsing.log`,
  `final-model-free.log`, `pinned-stack.log`, `*-idempotent.log`,
  `final-binary-sha256.txt`, `backup-sha256.txt`: current evidence.

The porting pass preserved the old `ds4-glm5.3` worktree; it was subsequently
retired from the project directory. The maintained patch, reports, models and
rebuilt runtimes do not depend on that folder. Keep the recovery archives above;
deleting a folder is not a substitute for unregistering a linked worktree.
The live-model QA gate remains open regardless of directory cleanup.

## Integration files changed

`scripts/apply-ds4-glm53-m2max.sh`, `src/dstudio_setup.c`, `src/dstudio.c`,
`src/dstudio_pld.c` (existing user-owned file, one hook call added),
`src/dstudio_updates.c`, `tests/integration/glm53_m2max_patch_test.mjs`,
`tests/unit/lan_unit.c`, `Makefile`, `README.md`, `patch/README.md`, and this
`patch/ds4-glm53-m2max/` package. The engine patch's eight paths are listed in
`PORT_QA.md`. No direct hand-edited engine delta exists outside that patch.
