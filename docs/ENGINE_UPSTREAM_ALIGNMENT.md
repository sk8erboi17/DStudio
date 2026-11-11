# Engine update admission

DStudio now checks an engine update before creating a macOS release archive.
A successful build alone is not enough: the proposed engine revision, its
patches, the app's actual installer pins and the required test receipts must
agree. Normal `make` / `.app` builds remain available while qualification is
in progress. This check never updates a user's engine or downloads weights.

**Current status: qualification is incomplete.** The
[machine-readable matrix](engine-upstream.json) deliberately contains missing
receipts and unresolved source reviews. It must fail admission until those
items are resolved. Its rows are requirements, not an announcement that all
models, backends or modes work. Since November 11 the main track's recorded
delta is [classified by changed path](#main-delta-review); Laguna's porting
review and the commits upstream has added past the recorded tips are not.

Since November 11 the matrix declares ten macOS targets, **135 required gate
slots and zero linked receipts**. These are missing bound qualification
records, not 135 failed tests. That day the MLX Qwen3.6 MXFP8 selection gained
its target (`mlx/macos/metal/qwen36-mxfp8`: MLX is installed from verified
wheels, so its two tracks record the upstream revisions those wheels were
released from, and its patch set is the three versioned mlx-lm adaptations),
and the three host-served targets (llama.cpp Qwen3.6, llama.cpp Qwen3.8-27B
and MLX) gained the gates the campaign requires of every selection: numerics,
quality-100, install-upgrade, learn, desktop and design-runtime, plus textual
isolation for the text-only ones and vision-pdf-50 for 27B. The November 4
reconciliation counted nine targets and 107 slots.
`make test-engine-upstream-manifest` (in `check-fast`) now checks, without
network or Git history, that every patch-set entry hashes to its recorded
SHA-256 and that every target's installer is the one the built app reports.
It was added because thirteen entries of the main and Laguna patch sets had
gone stale: seven patch and runtime files had changed without the manifest
being refreshed. They were refreshed on November 11; no receipt was bound to
the earlier digests. This check is not the commit-by-commit source review.
The October 1 audit's 117-slot count is historical: the Qwen targets later
moved to llama.cpp with different required gates. Existing scoped results may be
linked only after checking the exact source/patch/binary/model identity and gate
scope; no new release receipt was created by the documentation cleanup.

## Recorded sources

Main's pin was updated to upstream's November 2 revision `890898c` on
November 3, 2026 (before that, `0aaea5a`, rechecked as main's tip on
September 29, 2026); the other recorded tips retain their
September 12 review. `recordedTip` means observed, not qualified.
The command rechecks each relevant branch over the network. On November 11
every branch except Laguna's was ahead of its recorded tip
([revisions read that day](#main-delta-review)); no pin was moved.

| Engine | Recorded revision | Current evidence / remaining work |
| --- | --- | --- |
| ds4 main, including Qwen3.8 Next | [`890898c`](https://github.com/antirez/ds4/commit/890898cfb437ed256be58ebcf7c58a6dfa8f2f53) | [Unified-main migration](QWEN_NEXT_MAIN_MIGRATION.md) is implemented. The Next single-file Q4 baseline is 75/100, including 8/8 long cases, on `0aaea5a`. It does not qualify `890898c`; current-stack numerical/mode/desktop qualification and independent Q2 acceptance remain open. [V4.1 evidence and remaining work](DS41_UPDATE_CHECKPOINT.md) retain the scope of each recorded revision. |
| Laguna | [`448d569`](https://github.com/antirez/ds4/commit/448d5695d1c86401a4e9447c440feb983b73e6de) | No new branch commits at the last recorded review; applicable main changes and complete macOS mode coverage remain open. Other backends are outside this campaign. |
| llama.cpp, Qwen3.6-35B-A3B and Qwen3.8-27B | [`f5027fb`](https://github.com/ggml-org/llama.cpp/commit/f5027fb21307eb264aed483242603d68c87b0fe3) (`b11836`, since October 23; `b11371` before) | Bundled unmodified in `src/engines/llama.cpp`; built offline with CMake on first use. Chat, Agent and Cowork passed the live gate on both models on `b11371` (Metal); on `b11836` only Qwen3.6 has been rerun (6/6); Design runs with structured tool calls (real page on Qwen3.6). No DStudio patch is applied. Full-model quality, long context and other backends remain open. |

The vagrillo/ds4 Qwen3.6 fork (`73434c4`), Ninnix/q36 (`1305843`) and the
signalnine/q27 candidate (`8cd7083`) were retired on October 3, 2026; their
earlier receipts stay under `docs/upstream/` and `docs/history/`.

The matrix declares ten macOS Metal targets. On September 29, 2026 the user
limited the campaign to macOS on Apple Silicon; the 23 Linux and six Windows
targets (CPU, CUDA, ROCm, Vulkan) were removed as out of scope, not qualified.
The same decision keeps only the Vision-Exp DeepSeek V4 Flash checkpoint; its
four non-Vision rows were removed. DeepSeek V4.1 Q4 and GLM 5.3 Flash are left
to contributors and remain BLOCKED in the maintainer's plan
([contributor hardware](../PLAN.MD#contributors)). On November 10, 2026 the
owner returned DeepSeek V4.1 1017 Q2 alone to the maintainer's plan with expert
SSD streaming only ([conditions](../PLAN.MD#v41-ssd)); its receipts must record
that effective memory mode and qualify no other.
Every receipt must still match its target's operating system as well as the
engine and patches. The full campaign
census, additional format/quantization choices
and final build freeze remain separate requirements.

The current Agent patch manifest is version 106; its scoped changes and
verification are recorded in [the patch notes](../patch/ds4-agent-jsonl/README.md).
Version 103 previously added unified main without changing the other variants'
source output. The separate Qwen Next target is replaced by
main/Qwen Next Q2 and Q4 rows; all their full qualification gates remain open.
The version-102 real Laguna continuation
replay passes 6/6, including separate summary review. The corresponding Qwen3.6
MoE replay retains 1 PASS, 1 timeout FAIL and 4 not-run cases, plus a summary
that counts a partial function as emitted. The 77-stage native consumer build
uses simulated responses and does not close that real-model failure. See the
[current WIP status](WORK_IN_PROGRESS.md); the earlier progression below is
historical evidence, not qualification of v102.

Laguna/older-MoE retain v98's owner-only
publication and v99's native-framed continuation with unchanged output limits.
The first real Qwen MoE continuation run passed 4/6: code, facts and tools worked,
but manual compaction announced readiness early and Stop feedback was hidden.
Version 100 separates worker ownership from display status and emits explicit
service notices across all seven variants. Patch lifecycle and focused native
thread/barrier checks pass, as does the complete 77-stage four-engine consumer
rebuild (`run-YInkMT`). The v100 real replays pass 5/6 on MoE and 4/6 on Laguna:
MoE generates invalid C return types; Laguna drops remembered facts in its
summary. Both control fixes pass. V101 strengthens the private summary policy
across seven variants; migration, fresh 77-stage native consumer builds and
focused tokenizer/continuation gates pass. The model replays remain separate.
No v100 receipt is relabeled as a v101 pass. The retired q36 `8362010` had
also passed 42 native/projector stages and 13 native search-extractor fixtures
in each of Chromium/WebKit; those browser fixtures did not perform live search
or language generation. The
[update checkpoint](DS41_UPDATE_CHECKPOINT.md) retains the original failures
and exact scope. Patch-set hashes were refreshed on November 11 (see above),
but no missing release/model receipt is filled by these fixture tests.

The two new rows are V4.1 Q2/Q4 Metal candidates. Engram and expert SSD streaming
have an explicit required gate; no V4.1 CUDA/ROCm/CPU row is invented. The
[new-commit inventory](upstream/engine-deltas-2026-09-12.json) records every commit
in each displayed interval, with complete first-parent diff hashes. Source
freshness and a build PASS do not fill missing numerical or quality receipts.

For Qwen3.6, both full commit diffs affect only `dynamicmoeinference.md`.
The other 1,525 Git tree entries, including source, kernels, build rules and
test inputs, match the earlier pin. The document links to an external
implementation; no such runtime is imported or executed by this review.
This classification does not settle older main-to-fork integration questions.

<a id="main-delta-review"></a>
## Source review of main's recorded delta (November 11)

The 300 commits of the main track between its base `f4d03f6` and its recorded
tip `890898c` (17 of them merges) are now classified for the nine targets that
list that track. The result is a **classification by changed path of what
DStudio ships**. It is not a behavioural review, it ran no engine or model, and
it fills no gate receipt.

| Targets | Integrated | Not applicable | Unclassified |
| --- | ---: | ---: | ---: |
| Six ds4 main targets (Flash Vision-Exp, GLM 5.3, Qwen3.8 Next Q2/Q4, V4.1 Q2/Q4), each | 243 | 57 | 0 |
| Two llama.cpp targets (Qwen3.6, Qwen3.8-27B), each | 243 | 57 | 0 |
| Laguna | 0 | 57 | 243 |

No commit is classified `equivalent`. The matrix holds 2,457 review entries;
each cites the [commit inventory](upstream/main-delta-2026-11-11.json) by
SHA-256. The MLX target lists only its two MLX tracks, so it has none.

### Method

[`scripts/engine-delta-review.mjs`](../scripts/engine-delta-review.mjs) wrote
the inventory and the `reviews` arrays from isolated review checkouts. Its
rules are the `PATH_RULES` table at the top of that script, repeated in the
inventory.

1. **What is shipped.** `src/engines/ds4` was compared with upstream's tree at
   `890898c` file by file: path, content SHA-256 and executable bit. All 498
   shipped files are identical; none is missing, extra or different. The
   snapshot is not the complete tree. Upstream has 3,488 files at that commit;
   the other 2,990 are the omissions declared in the
   [provenance manifest](../src/engines/manifest.json) (2,989 files under
   `gguf-tools/` and `dir-steering/`, one benchmark text under `speed-bench/`),
   and their recorded hashes match the upstream blobs. None of them is a file the macOS build
   compiles or reads. `src/engines/ds4-laguna-s21` against `448d569`: 194
   shipped files identical, 1,212 declared omissions out of 1,406, none
   missing, extra or different. The script refuses to write anything when a
   shipped file differs from its pin.
2. **What a commit touches.** The inventory records, for every commit in the
   checker's own order, its author date, title, parent count, changed files
   with status, and the SHA-256 of its first-parent diff. A merge is judged by
   its first-parent diff. Titles are provenance, not verified claims.
3. **Integrated** means the commit changes at least one file that the macOS
   runtime compiles or reads, and that file is shipped identical to upstream.
   Those files are: the include closure of upstream's Darwin `all` target,
   which DStudio's `make` builds and its Agent, Chat and Design builds link
   (50 files; `make test-engine-delta-review` recomputes the closure with the
   compiler); the Metal kernels in `metal/`, which `ds4_metal.m` reads into one
   library at start; `download_model.sh`, which DStudio executes; and
   `Makefile` lines that GNU make evaluates on macOS. The reason names the
   files and, for a ds4 main target, the patches of its patch set that modify
   them. Only `patch/ds4-agent-jsonl/main-qwen.patch` is apply-checked at
   admission; the others are bound by hash.
4. **Not applicable** means the commit changes only CUDA, ROCm or Linux-only
   sources, upstream tests and fixtures, conversion, quantization, steering and
   scoring tools with their data, benchmark programs, or documentation. One
   commit (`b14bf62`) also qualifies through a guard: its `Makefile` lines all
   sit in a branch of the `UNAME_S`/Darwin conditional that make skips on
   macOS.
5. **llama.cpp targets** get the same decision as the ds4 main targets,
   because their Agent, Cowork and Design frontends are built from the main
   checkout while llama-server serves the weights. Their reasons say that
   whether those frontends link or execute the changed code was not analysed.
6. **Laguna** is built entirely from its own branch, which forked before the
   base (merge base `efdadd4`; `git cherry` finds no commit of the interval
   with an equivalent patch on that branch). A main change reaches it only if
   someone ports it. The 57 commits that touch nothing a macOS Metal runtime
   compiles or reads are not applicable; the other 243 are left unclassified,
   because whether Laguna needs each one is a source judgment no path rule can
   make.

### What this does not establish

- That any change behaves correctly, or that a checkpoint executes it. All
  main checkpoints share one build: a commit that changes only a Qwen kernel
  is `integrated` for GLM too, because the kernel is compiled into the same
  Metal library. Per-checkpoint reachability was not analysed.
- That a shared file's change matters on macOS. A commit that edits `ds4.c`
  for a CUDA code path counts as integrated; no `#if` analysis was done.
  Ten commits are integrated only through `Makefile` lines that make parses
  on macOS; whether they alter the default build was not analysed.
- Anything about Laguna's 243 open commits, or about commits upstream added
  after the recorded tips.
- Any gate. The 135 required gate slots still have zero receipts.

### Remote revisions on November 11, 2026

Read with `git ls-remote` that day. No pin was moved, and no commit past a
recorded tip was classified. Each advanced ref descends from its recorded tip.

| Track | Recorded tip | Remote ref on November 11 | Commits not reviewed |
| --- | --- | --- | ---: |
| main (`refs/heads/main`) | `890898c` | `b3f50180ec2c7324892be1f50bc83555ccb8d5e7` | 116 |
| laguna (`refs/heads/laguna-s2.1`) | `448d569` | `448d5695d1c86401a4e9447c440feb983b73e6de` (unchanged) | 0 |
| llama (`refs/heads/master`) | `f5027fb` | `aa75ff3239f9cc675b081697deda9e1b112345c6` | 446 |
| mlx-lm (`refs/heads/main`) | `93e6d4a` | `56230fa02b8ff8330daf26dc95c28480423ed5fe` | 18 |
| mlx (`refs/heads/main`) | `36969c0` | `fc344c986c4169d99f76b5d95ae6b4a58a359a63` | 82 |

The newest main commit is titled "Read half-aligned Qwen Q2 weight rows
correctly on Metal". That title was not verified and the commit is not part of
any DStudio build.

With review checkouts at the recorded revisions and the headless test host,
admission reported 4,875 issues before this review (`UNREVIEWED_TIP` 4,
`MISSING_GATE` 135, `UNCLASSIFIED_COMMIT` 4,736) and 2,418 after it (4, 135,
2,279). The remaining 2,279 are the 116 newer main commits for nine targets
(1,044), Laguna's 243, the 446 newer llama.cpp commits for two targets (892)
and the 100 newer MLX commits. Admission still fails, as it must.

### Rebuild it

```sh
node scripts/engine-delta-review.mjs --captured 2026-11-11 \
  --repo main=/path/to/review/main --repo laguna=/path/to/review/laguna \
  --observed-tip b3f50180ec2c7324892be1f50bc83555ccb8d5e7
node scripts/engine-delta-review.mjs --check
```

The first command needs checkouts of `antirez/ds4` with the history from the
base to the tip and the Laguna tip; it reads them and never fetches. The second
needs no checkout: it rebuilds the reviews from the committed inventory, after
checking that `src/engines/` still holds the files that were compared, and
fails if `docs/engine-upstream.json` would change. Run it after changing a
patch set, because the reasons name patches. Both produce identical bytes on
every run. Diff hashes use Git's 7-digit abbreviated blob ids, as the
[September inventory](upstream/engine-deltas-2026-09-12.json) did; the seven
commits the two inventories share have the same hashes.

## Run the checks

The model-free regression tests exercise real local Git histories, actual patch
conflicts, metadata subprocesses and the production release command with a tiny
bundle fixture:

```sh
make test-engine-upstream test-engine-pins test-engine-setup-unit
```

`make test-engine-delta-review` (also in `check-fast`) checks the main-track
review without a clone: every review's evidence file hashes to its record,
names an inventoried commit once, and equals what the generator's rules give
for the inventory and the files shipped in `src/engines/`. On macOS it also
compares the compiled path rules with the preprocessor's include closure of
upstream's default build, and it runs the generator on a synthetic Git history
whose output goes through the real admission checker. It reviews no commit.

To inspect the compiled installer's pins without creating a window, loading a
profile or starting a model:

```sh
./dstudio --engine-pins
```

For admission, first prepare separate Git checkouts at the matrix's candidate
revisions, with the complete baseline-to-tip history. Do not point the command
at an archive directory inside another repository or repair a user's checkout
to make it pass. Each source checkout must have the expected origin and HEAD.

```sh
make check-engine-upstream \
  ENGINE_UPSTREAM_APP=./dstudio \
  ENGINE_UPSTREAM_FLAGS='--repo main=/path/to/review/main --repo laguna=/path/to/review/laguna --repo llama=/path/to/review/llama.cpp --repo mlx-lm=/path/to/review/mlx-lm --repo mlx=/path/to/review/mlx'
```

Every track of a selected target needs its `--repo`. The checker reads commit
history and, for an apply-checked patch, the checked-out files; on November 11
it accepted blobless and treeless partial clones of llama.cpp, mlx-lm and mlx
checked out at their pins.

The check prints JSON and exits nonzero on failure. Use a new ignored output
path for each attempt; never replace a failed receipt with a successful retry.
`--offline` permits inspection but always rejects promotion because remote
freshness was not verified. Missing Git objects must be fetched separately into
the isolated review checkout; this checker does not fetch, apply patches,
build, reset or move HEAD.

`make dist-macos` first builds and smoke-tests the bundle, then checks its own
executable with platform `macos`, before creating the archive. It does not use
an older executable elsewhere in Applications. Every declared target is macOS,
so platforms `all` and `macos` select the same rows. A `linux` or `windows`
selection has no targets and fails with `MISSING_TARGETS`; those platforms are
outside the campaign.

## What admission verifies

- Exact remote tip, baseline ancestry and every commit in the recorded delta.
  Each target must classify changes as integrated, equivalent or not applicable,
  with a substantive rationale and hashed supporting evidence. Unresolved
  changes, rewritten history and missing objects block promotion.
- Candidate HEAD and origin. Git environment overrides cannot redirect these
  reads into another repository; archive installs cannot borrow a parent Git ID.
- SHA-256 of every declared adaptation/build input. `check: apply` also runs
  `git apply --check`; `check: reverse` verifies an actually applied patch.
  Hash-only inputs describe recipes/derived builds, not proof that a patch ran.
- Compiled installer commit and archive URL, obtained through the actual native
  metadata command. A missing Qwen27B installer cannot inherit a Qwen3.6 result.
- Required gate receipts for each target, bound to its engine revision and patch
  set. Missing, failed, unfinished, stale or modified evidence blocks admission.
  A retained failed gate cannot be hidden by adding a successful retry.
- Bounded diagnostics with complete totals and target rows, even when the list
  of individual errors is truncated. No failed target disappears from the report.

A qualification receipt has this shape; hashes below are placeholders, not
valid evidence:

```json
{
  "passed": true,
  "finished": "2026-09-08T00:00:00Z",
  "qualification": {
    "schema": "dstudio.engine-qualification.v1",
    "target": "main/macos/metal/qwen38-next-q4",
    "platform": "macos",
    "engineRevision": "<exact-40-character-commit>",
    "patchSetSHA256": "<hash-reported-by-the-checker>",
    "gate": "agent",
    "evidence": [{"path": "tests/.artifacts/example/results.json", "sha256": "<full-SHA-256>"}]
  }
}
```

New runners must emit this identity alongside the actual result. Do not rewrite
historical reports or wrap a known failure as a green result. The raw evidence
must retain requests, answers, settings, source/binary/weight identities and
failures appropriate to the gate. Reviewed public aggregates may link to hashes;
private prompts, PDFs, quotes and personal paths stay ignored.

## Limits

This is admission of **declared** changes and evidence, not an answer grader,
numerical oracle or complete build lock. It cannot establish that a source
review's judgment is correct, that an omitted combination was intentionally
excluded, or that arbitrary host/source changes outside the named inputs were
tested. The main-track reviews are path classifications with
[stated limits](#main-delta-review), not judgments about behaviour. The full inventory, independent graders, platform/driver and weight
identities, suite revisions, final source freeze and release review are still
required. Metal results do not qualify CUDA, ROCm or Vulkan, which are outside
the macOS-only campaign.

There is no new model-quality score or speed benchmark in this update.
