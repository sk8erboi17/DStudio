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
delta is [classified by changed path](#main-delta-review), and since
November 12 Laguna's share of it has a [porting review](#laguna-port-review)
that leaves 11 porting candidates open; the commits upstream has added past
the recorded tips are not reviewed.

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
| Laguna | [`448d569`](https://github.com/antirez/ds4/commit/448d5695d1c86401a4e9447c440feb983b73e6de) | No new branch commits on November 12. Of main's 243 integrated commits, 11 are [porting candidates](#laguna-port-review), not yet ported; complete macOS mode coverage remains open. Other backends are outside this campaign. |
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

No commit is classified `equivalent` by path. The matrix held 2,457 review
entries on November 11; each cites the
[commit inventory](upstream/main-delta-2026-11-11.json) by SHA-256. The MLX
target lists only its two MLX tracks, so it has none. On November 12 the
[Laguna porting review](#laguna-port-review) added 232 Laguna entries (231 not
applicable, 1 equivalent), which also cite the review file: 2,689 in all.
Laguna's row then reads 0 integrated, 288 not applicable, 1 equivalent and 11
unclassified.

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
   make. The [porting review](#laguna-port-review) of November 12 makes it.

### What this does not establish

- That any change behaves correctly, or that a checkpoint executes it. All
  main checkpoints share one build: a commit that changes only a Qwen kernel
  is `integrated` for GLM too, because the kernel is compiled into the same
  Metal library. Per-checkpoint reachability was not analysed.
- That a shared file's change matters on macOS. A commit that edits `ds4.c`
  for a CUDA code path counts as integrated; no `#if` analysis was done.
  Ten commits are integrated only through `Makefile` lines that make parses
  on macOS; whether they alter the default build was not analysed.
- Anything about Laguna's 243 commits (the [porting review](#laguna-port-review)
  covers them, with its own limits), or about commits upstream added after
  the recorded tips.
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

<a id="laguna-port-review"></a>
## Laguna porting review of main's delta (November 12)

Laguna S 2.1 builds from its own branch, so the path classification above left
open the 243 commits that the main targets integrate. On November 12 each of
them was read against that branch and given one verdict: its first-parent
diff, compared with the Laguna sources at `448d569` and with DStudio's Laguna
patches, not its message. The result is
[`upstream/laguna-port-review-2026-11-12.json`](upstream/laguna-port-review-2026-11-12.json).
It is a **source review**: no engine or model ran, nothing was ported, no
patch was written and no gate receipt was added.

| Verdict | Commits | Meaning |
| --- | ---: | --- |
| Present | 1 | Already in what DStudio builds for Laguna |
| Porting candidate | 11 | Laguna has the same code path and lacks the change |
| Not applicable | 231 | Laguna lacks the code, does not build it on macOS, or never runs it |
| Unresolved | 0 | |

The one **present** commit is `e33a5b2` (agent tasks continue across context
compaction). It is not on the Laguna branch: DStudio's Agent/Cowork patch
version 99 (`patch/ds4-agent-jsonl/laguna.patch`) backports its text-only
part. The manifest records it as `equivalent`, citing that patch in its reason.
`git cherry` finds no commit of the interval with an equivalent patch on the
branch itself.

The **not applicable** commits, by reason:

- 124 change code the Laguna branch does not have: DeepSeek V4.1 (85) and
  Qwen3.8 Flash Next (39), which reached main after Laguna forked at `efdadd4`
  on July 20.
- 45 change paths the Laguna engine refuses when it opens a model: SSD expert
  streaming (11), tensor parallelism (19) and DSpark (15). The Laguna block of
  `ds4_engine_open_internal` also refuses distributed inference, layer slicing
  and multi-GPU placement.
- 12 change another model family's graph, which a Laguna session never runs:
  GLM (8) and DeepSeek V4 routed MoE or indexer (4). The Laguna graph calls its
  own `laguna_*` kernels and the GLM routed-MoE entry points.
- 7 are CUDA or ROCm only, and 7 concern image input (Laguna is text-only).
- 20 touch the server, agent, build, downloads or a shared Metal kernel, but
  only for code that Laguna does not run. Examples: DSML-only syntax, Qwen or
  vision rendering, test targets for files Laguna lacks, downloads of other
  checkpoints, and multi-slot routing.
- 16 are merges that carry nothing beyond commits reviewed individually or
  main commits before the base. Their conflict resolution was read with
  `git show --remerge-diff`.

Some of these verdicts rest on how DStudio runs Laguna today, and their reasons
say so: Chat starts `ds4-server` with one slot and without `--dflash`, and
Agent/Cowork run the JSONL agent on pipes rather than the terminal UI.
Changing that reopens them, for example `82aa7e8`, `af7c02b` and `4ff3af6`
(top-k kernels reached only through DFlash) and `4d7028e`/`ada805a`
(multi-slot routing).

### Porting candidates

None has been ported. Each needs its own adaptation, tests and a versioned
patch under `patch/`, scheduled separately.

| Commit | What the main change fixes | Laguna at `448d569` |
| --- | --- | --- |
| `5b3cc8b` | The server's sampling tracker recognises GLM-syntax tool calls, so their names and keys are sampled greedily and argument values with the request's sampling | `ds4_server.c`'s `dsml_decode_tracker_update` finds only DSML starts, so Laguna's `<tool_call>` blocks are never tracked. A port must treat `SERVER_MODEL_SYNTAX_LAGUNA` like GLM (main tests only GLM) and bring `d077fa6` with it |
| `759dd7c` | A tool call cut off by the output limit ends as `finish=length` instead of starting a tool-error continuation | `generate_job` runs the recovery for any unterminated call, and `decode_again` resets the budget, so a second full budget can be generated (non-streaming only) |
| `fc6414c` | A literal `</tool_call>` or `</think>` inside an argument no longer ends or drops the call | `parse_glm_generated_message_ex`, which parses Laguna's calls, uses `strstr`/`find_last_substr`; decoding stops when `observe_tool_markers` sees `</tool_call>`. The marker part needs `5b3cc8b` first |
| `d108ae4` | Tool argument text survives render, parse and streaming byte for byte | The parser and both tool streams decode every HTML entity (`dsml_unescape_text`); the agent's `agent_glm_tool_parse` rejects a value containing `</tool_call>`. Needs `ds4_tool_text.h`, which Laguna lacks |
| `6eac69e` | The tool-error recovery stays within the remaining output budget and respects a client stop; a debug scan no longer reads past short output | Same recovery in `generate_job`; the scan bound `text.len - 20` underflows below 20 bytes (non-streaming recovery) |
| `a8ce74a` | A blank `reasoning_content` echoed by a client renders like absent reasoning | `parse_messages` keeps it and `render_laguna_chat_prompt_text` emits it between think tags, so the replayed prompt misses the cached prefix and is prefilled again |
| `67f2ca9` | `/v1/models` reports input and output modalities | Same `append_model_json_values` without them; additive metadata, no inference change |
| `b36e26e` | Agent file tools replace files atomically and detect concurrent changes; reads, searches and background shell jobs stop truncating or stalling silently | Same tools in `ds4_agent.c`, but `laguna.patch` rewrites the read/write/list region and `agent_execute_tool_call`, so a port must be merged with that patch |
| `a4c922c` | Buffers of a freed Metal session are released instead of staying referenced by the reading thread | `ds4_gpu_tensor_contents`/`_write`/`_read` in `ds4_metal.m` read buffer contents without an autorelease pool; the Laguna graph and its session save/restore use them. Upstream measured the leak with GLM 5.3; it was not measured on Laguna |
| `c0a6119` | An in-memory session snapshot keeps its final byte | `ds4_session_save_snapshot` opens an `fmemopen` buffer of exactly the payload size. Latent for DStudio: only `ds4-bench` calls it on the Laguna branch |
| `064bc22` | `ds4_metal.o` is rebuilt when `ds4.h` changes | The Makefile rule omits `ds4.h`, which `ds4_metal.m` includes. Build hygiene only: a clean build is unaffected, and DStudio's Laguna patches do not touch `ds4.h` |

The server candidates overlap. `fc6414c` and `d108ae4` rework the same
parser, and `759dd7c` and `6eac69e` rework the same recovery path. The
continuation they bound runs only for non-streaming requests.

Only some diffs apply as they stand, checked with `git apply --check` on an
index of `448d569`, without and with each DStudio patch:

- The `ds4_metal.m` part of `a4c922c` and the `ds4.c` part of `c0a6119` apply
  both without and with `patch/ds4-laguna-prefill-chunk`.
- The `ds4_server.c` part of `759dd7c` applies both without and with
  `patch/ds4-server-metrics/usage-metrics.patch`.
- The other server candidates do not apply as they stand, even to the
  unpatched branch, and need adapting.

### What this does not establish

- That a candidate is a measured defect on Laguna weights, or that porting it
  is safe; no Laguna run was made.
- That a not-applicable commit could never matter: it would if Laguna's engine
  stopped refusing streaming, tensor parallelism or DSpark, or if DStudio
  started using DFlash or several server slots.
- Anything about the 311 main commits between the merge base `efdadd4` and the
  base `f4d03f6`, which the Laguna branch also lacks, or about commits after
  the recorded tips. Neither group was reviewed for Laguna.
- An independent second reading. The verdicts were recorded once and were not
  re-reviewed. Commit titles are provenance, not verified claims.

### Revisions read on November 12, 2026

A fresh clone of `https://github.com/antirez/ds4` was made at 00:30 UTC into
the ignored `tests/.artifacts/laguna-port-review/`. The main checkout's
`tests/.artifacts/engine-delta-review/` held only the test's synthetic runs,
not the November 11 review checkouts. In the clone:

- `refs/heads/main` was `b3f50180ec2c7324892be1f50bc83555ccb8d5e7`, as on
  November 11.
- `refs/heads/laguna-s2.1` was `448d5695d1c86401a4e9447c440feb983b73e6de`,
  unchanged.
- The merge base of `890898c` and `448d569` is `efdadd4`. The branch has 17
  commits after it (July 23–27, 2026).
- `src/engines/ds4-laguna-s21` equals `448d569` file by file, apart from the
  declared omissions.

With main and Laguna checkouts at their recorded revisions (no other
repositories, no app), admission's `UNCLASSIFIED_COMMIT` issues fell from
1,055 to 823. All 232 fewer are Laguna's. Its remaining 127 are the 11
candidates and the 116 main commits after the recorded tip. Admission still
fails, as it must.

### Revise it

Edit a verdict in the JSON file, then run `node scripts/engine-delta-review.mjs`.
The script regenerates the Laguna target's reviews and renders the file
canonically. The target names the file in `portReview`. Only `present` (as
`equivalent`) and `not-applicable` become reviews; a candidate or unresolved
commit stays an admission issue until it is ported or decided.

The script refuses a file that misses a verdict, adds one for a commit the
path rules decide, gives a commit two verdicts, uses an unknown verdict or
names other revisions or another inventory. `make test-engine-delta-review`
checks all of this.

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
whose output goes through the real admission checker. It also checks that
Laguna's [porting review](#laguna-port-review) gives exactly one verdict to
each commit the main targets integrate, for the pinned revisions and this
inventory, and that the manifest's Laguna reviews follow those verdicts. It
reviews no commit.

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
[stated limits](#main-delta-review), not judgments about behaviour; Laguna's
are source verdicts of its [porting review](#laguna-port-review), not tests. The full inventory, independent graders, platform/driver and weight
identities, suite revisions, final source freeze and release review are still
required. Metal results do not qualify CUDA, ROCm or Vulkan, which are outside
the macOS-only campaign.

There is no new model-quality score or speed benchmark in this update.
