# Qwen — checkpoint for resuming work

This document distinguishes what works, what has been verified and what still
needs implementation. Qwen3.6-35B-A3B and Qwen3.8-Flash-Next are integrated on
macOS Metal; the new Qwen3.8-27B has initial Chat, Agent and Cowork workflows
verified with images too. This does not complete every Qwen requirement in
the local implementation plan.

**Publication checkpoint:** the current slice is closed and the remaining
campaign is paused. See the [plain-language WIP status](WORK_IN_PROGRESS.md).
Dated entries below retain the evidence and limitations of each historical step;
later fixes do not retroactively turn earlier failures into passes.

## Current progress — September 13, 2026

### DStudio replay and abrupt installer termination — 01:22 UTC

The binary with corrected cache-usage reporting also passes **46/46** real
HTTP/image/tool/Stop checks (`run-Erzu5e`) and **14/14** inside DStudio
(`q36-host-live/run-KduHiw`): Chat, Agent repairing Python and running four
original tests, independently reopened Cowork Excel, images and return to Chat.
Inputs are unchanged and processes terminated. These are not tests of the real
`.app` window or Learn/Design, and do not replace the common quality score of 61/100.

A new test then found that a command could outlive an abruptly terminated
installer. A separate supervisor now observes the caller's lifetime and
terminates only owned commands, including commands that close their output
or ignore SIGTERM. **42/42 installer tests PASS**, using real processes;
the original failure is retained. The subsequent real network/build/inference
test `q36-upgrade-live/run-jkibs2` also finishes **8/8 PASS**, with 33 reused
legacy tokens, an identical uncached answer and binaries identical to those in
the two replays. Admission checks pass **16/16**, as do **94 unit checks + 15
simulated host scenarios**. Inputs are verified; no test processes remain.
The user's app was not restarted or rebuilt. Details and hashes are in the
[upstream checkpoint](DS41_UPDATE_CHECKPOINT.md).

### Upgrade with actual cache reuse — 00:58 UTC

The upgrade test now checks continuation of an old conversation in a new process,
compared with the same request without cache. It found a real bug: the server
reused the old checkpoint but reported **0 reused tokens**. In-memory prefixes
had the same problem. The fix is a separate `.patch`: publish the count only
after confirming the new session. It changes neither weights nor the KV format.

`q36-upgrade-live/run-sOSwzz` remains **3 PASS, 1 FAIL, 4 not run**. With the patch
and the same eight checks, prompts and limits, `run-MsDxvv` finishes at
**00:58:34 UTC: 8/8 PASS**. The updated engine reuses **33 tokens** from the legacy
checkpoint and answers correctly; the uncached process reports 0 and produces
the same answer bytes/tokens. The upgrade preserves the project's C files,
Makefile and links, settings and weights without compiling them or adopting them
as engine sources. Original weights and sources are rechecked; all six test
processes exit 0 and are verified absent.

**38 installer tests**, **12 patch/build lifecycle stages**, and HTTP/cache
regressions **78/78 single, 68/68 batch** pass with ASan/UBSan and simulated
numerics. Admission against the new installation passes **16/16**, without
inference. These are not a new quality score and do not close Learn, Design,
long context, the actual `.app`, other engines/backends or all of P5.
The earlier host run `q36-host-live/run-tDuo5n` retains **14/14 PASS** at
00:21 UTC: Chat, Python Agent, Cowork Excel, images and Stop on the version
without this new patch. It does not automatically qualify the new binary.
Provenance, the original failure and hashes are in the
[upstream checkpoint](DS41_UPDATE_CHECKPOINT.md).

### Updating an existing installation — 00:10 UTC

There is now a q36 upgrade path: prepare and verify the new version separately,
then exchange the directory in one operation while retaining the old one.
Legacy Metal receipts are compared with the original archive to distinguish
distributed files from user files. This does not claim data undo: preserved
user files remain shared through hardlinks, including subsequent edits.

**35 installer tests PASS**, with actual files/processes but simulated
downloads/builds in fixtures. A cleanup bug was fixed: a command could exit
before its descendant closed the listening port. Active-process detection now
uses a native handshake fixture, not a copied system program that macOS terminated
before the check.

The first real test, `q36-upgrade-live/run-Xqm7MP`, remains **1 PASS, 1 FAIL,
4 not run**: the earliest legacy build loads the model but produces unintelligible
text. With the subsequent `d67687ed`/patch `75764a9f` build already used for quality
tests, the run finishes at **00:09:58 UTC: 6/6 PASS** (`run-42nhJa`).
The 27B answers correctly before and after downloading/building `8362010`;
projects, settings, weight aliases and an actual 160,049,582-byte cache survive.
The new answer reports **0 reused tokens**: this is not yet proof of reuse or
cross-version cache-format equivalence. Weights and the original installation
are rechecked, and the test processes terminated. Hashes and limitations are in
the [upstream checkpoint](DS41_UPDATE_CHECKPOINT.md).

This does not complete the full mode matrix, other engines/backends, the actual
`.app` or all of P5. The common quality result remains 61/100.

### Installation protection and inventory — 23:27 UTC

The launcher now holds a read-only use lease in the **actual Qwen process**
until it exits: an exclusive upgrade cannot overlap loading, inference or
shutdown. App death cannot release this lease prematurely. Chat → Agent can
still verify the installation without reloading the model. File operations run
in the child, outside the HTTP loop; the persistent runtime record does not grow.

The original regression, `q36-host/run-Jm7a0A`, shows startup admitted during an
upgrade. After the fix, **94/94** identity/protocol checks and **15/15** host
scenarios pass normally (`run-ZKdGZO`) and with ASan/UBSan (`run-fnFCOq`).
These scenarios use a simulated engine and actual process barriers; they do not
measure model quality. The first repeat, `run-hqBj7p`, remains failed: test cleanup
requested Stop after the process had exited. It now requests Stop only when
work still exists.

The installer passes **22 tests**: concurrent read-only verification, concurrent
publication during lease changes, aliases, bounded inventory, preservation of
notes/cache/weights, and immediate rejection of a FIFO instead of a binary.
The new real network installation, `engine-acceptance/run-37al3S`, passes
**main + q36**, recording 147 q36 sources and **255 distributed files**.
Subsequently added data does not become installer-owned.

These are migration prerequisites, **not a completed upgrade**: old receipts
do not identify every file and cannot authorize overwriting unrecorded files.
Legacy-version migration, publication/recovery and their real tests still need
implementation. The real host replay, `q36-host-live/run-JgGSg0`, on the new
installation finishes at **23:36:35 UTC: 14/14 PASS** on the actual 27B.
Chat, streaming, Agent repairing Python, independently reopened Cowork Excel,
four tool images and return to Chat reuse one process. The exclusive lease
remains denied during use and becomes available after Stop. Host exit 0,
unchanged inputs, and host/model verified absent. This does not replace common
quality 61/100, Design, Learn or the full model/backend matrix.

### New 27B installation and DStudio tools

At 22:51 UTC, the new `8362010` installer with ordered, recorded runtime/monitor/
owner patches passes actual network installation alongside main
(`engine-acceptance/run-jVF1xy`). The subsequent DStudio replay,
`q36-host-live/run-pkigpi`, passes **14/14**: Chat, streaming/reuse, Python
changes with four unchanged tests, Cowork Excel checked by an independent reader,
four tool images, return to Chat and Stop. Generated files were not manually
corrected; the model's initial incorrect command and recovery remain documented.
Inputs are unchanged, host exit 0 and test processes terminated. Existing weights
were reused without copies.

Runner admission now distinguishes a current installation from a review checkout:
14 altered-install-receipt cases and 13 native-copy cases pass without launching
models. The live test on the new installer retains 46 API/cache cases;
preflight checks do not count as inference. The actual replay,
`q36-http-vision-live/run-oGEVFX`, finishes at 22:55 UTC: **46/46 PASS**.
All 157 inputs and weights are unchanged; checkpoints survive Stop, and the
answer/context reuse match the uninterrupted case. Engine exit 0 and PID
terminated; this is not a speed benchmark or a new general quality result.
Common quality, long context, Learn, the actual `.app`, other backends and
existing-installation upgrades remain open. Refusing to overwrite an older
installation does not complete upgrade support. These tests neither rebuilt
nor restarted the user's app. Hashes and limits are in the
[upstream checkpoint](DS41_UPDATE_CHECKPOINT.md).

### Agent update and q36 checks

The [upstream/V4.1 checkpoint](DS41_UPDATE_CHECKPOINT.md) contains the most recent
checks, separate from the common 27B quality results below. Agent v101 better
preserves facts needed later: migration across seven bases, 77 native checks
across four engines, and tokenizer/compaction checks pass. The earlier MoE v100
real replay remains **5/6**, with invalid C. The new v101 run, `agent-continuation-live/run-lC2uDg`,
passes **6/6**: 200 compiled/executed C functions, fact recall, manual compaction,
and tools before/after Stop. Exit 0, unchanged inputs and process terminated
at 20:53 UTC. This is a separate development test, not a token-matched A/B
comparison. Laguna v101 also passes **6/6** real workflows.

A separate review nevertheless finds premature completion in Laguna's summary.
For MoE, the first summary correctly records incomplete work; the second still
lists it as missing after completion and takes the form of a tool call, although
no tool events occurred during compaction. Both separate reviews remain FAIL:
faithfulness and progress tracking need a fix even though the workflows pass.
Original receipts have not been altered.

Candidate v102 supplies the summarizer with the actual response state and asks
it to update progress from subsequent results. Seven-patch migration PASS;
native tokenizers pass 18/18 Laguna-loop and 16/16 MoE checks, alongside
publication and framing checks. V101 fails the same two new open→finished
checks. The complete v102 rebuild, `run-Ethbt2`, passes 77/77 stages across four
engines with simulated responses. The new Laguna real replay, `run-b3xpGT`,
finishes at 21:46 UTC: 6/6 workflows and separate review of both summaries PASS.
It records exactly 57/200 functions while the response is open, then all 200
when completed; both facts survive without invented tool effects. Inputs are
unchanged, code compiled/executed, exit 0 and PID terminated.

This is one development test, not general qualification. MoE v102
`run-V4I1gQ` finishes at 22:05 UTC: **1 PASS, 1 timeout FAIL, 4 not run**.
It reaches 174/200 functions within the original 600 seconds; summary and context
reconstruction take 282.767 seconds. The summary retains the facts but counts an
incomplete function as emitted too (55 complete plus one partial). The native
tail retains original tokens and completes that function without making the
summary's accounting correct. The test engine is terminated with SIGTERM;
32 inputs and weight identity are rechecked unchanged. The original receipt
is retained. No deadline was extended or quality inferred from Laguna's result.

The q36 `8362010` rebuild, `run-nY4HeX`, now passes **43/43 stages** with the
projector: it also records the 52 files actually compiled, separately from the
checkout before lifecycle fixtures. The CLI review, `q36-http-review/run-fOY8Ec`,
passes **13/13** admission/rejection cases without weights or inference.
The real 46-workflow image/tool/cache replay, `run-jfuPOr`, finishes at 22:19 UTC:
**46/46 PASS** on the new commit. After Stop, the four previous files are
identical, and eight continuation fields match the uninterrupted oracle,
alongside the exact answer. Inputs and weights are unchanged, engine exit 0
and PID terminated. Broad quality, long context and candidate host integration
remain separate; this result alone did not update the installer or app.

On new q36 `8362010`, 42 native/projector stages and 13 search cases in each
of WebKit/Chromium pass (controlled pages, not live search). The new blocked-log-
write test instead fails on both original upstream and the adaptation: command
status control is still behind the mutex. Receipts are retained; this does not
qualify the monitor, model, long context or a final `.app`.

The subsequent [`monitor-owner` patch](../patch/q36-agent-tty/README.md) fixes
that path: I/O outside the mutex, a single monitor writer, Stop independent
of writes, PID identity retained through signaling, deduplicated terminal
receipts and no EOF busy loop. New native runs,
`q36-monitor-control/run-g38GQE` and `run-PnMjJT`, pass **7/7 cases and
14/14 lifecycle checks** with ASan/UBSan and, separately, ThreadSanitizer on
the included Agent. Against the same C oracle, upstream and the old terminal
patch remain **1/5** on common cases; two new cases specifically cover terminal
receipt delivery. The native Agent/PTY test, `q36-agent-tty/run-gd2ap6_q`,
passes **28 stages** and 32 normal/cancelled cycles without leaks. Profiling
also found and prompted a fix for a busy loop in the first candidate;
production gained no timers. This is a separate reproducible patch on
candidate `8362010`, not yet installer promotion or LLM/long-context quality.

### Optimized F16 reads: GPU checks pass, real request still fails

New overlay `893f7f07…` reuses query elements in registers, prepares value reads
in groups of eight, and uses at most 4 KiB of local memory per GPU group.
F16, sum/FMA ordering, context, command count and session state are unchanged.
**18 GPU cases PASS**, including small dimensions, partial tails and inactive
lanes; lifecycle **18/18 PASS**. The two previously tested GQA-sharing variants
were discarded: although they preserved exact values, they did not improve
every measured case.

Five alternating before/after pairs each pass all 18 checks. For the isolated
50,741-position/128-query case, median operator time is **423→301 ms** and GPU
time **352→233 ms**. These are synthetic inputs on actual Metal GPU hardware,
not Chat speed or LLM quality; the common 61/100 baseline is unchanged.
Per-stage profiling exists only in the tester, with no added production cost.
Preflight `q36-retained-diagnostic/run-9wwzxS` verifies the new overlay in a
private copy without loading or rehashing weights.

Replay `q36-retained-diagnostic/run-ylEDRa`, run September 9 and rechecked
September 12, finished **FAIL at the original 900-second deadline**.
The last chunk completed before expiry reaches 33,152/50,869 tokens (65.2%),
versus 58.9% in the previous attempt. This is neither a valid answer nor a
controlled speed comparison. The chunk reaching 33,280 finishes during teardown
and does not count. No new Metal error was logged; the engine is reaped with
exit 0, without SIGKILL, and sources/inputs/weights preserved. All 32,172 log
bytes are retained. No test remains running and no patch was promoted into the app.

### Where the problems originate: engine, adaptation and grader are distinct

Reproduced native q36 defects include incorrect CPU FFN input reuse across
weight formats, 35B dimensions used by 27B Metal operations, and macOS terminal
handling. DStudio had separate defects, including startup checks looking for
`ds4_agent.c` in the q36 checkout. The benchmark client and some oracles also
had bugs, documented here with original receipts and their own regressions.

The long-request failure occurs in Metal computation even without the UI,
but the executed binary includes DStudio overlays. Locating an upstream kernel
does not automatically assign upstream all responsibility for changed scheduling
or the later timeout. Original and adapted paths require separate comparisons;
these results neither qualify nor disqualify other engines, models or backends.

### New F16 patch: operators verified, real replay still fails

The [separate patch](../patch/q36-f16-attention/README.md) partitions the positions
visited by each command, not only queries. It preserves the prompt, F16
precision, context and original arithmetic order. It is not yet in the managed
download or installed `.app`.

`q36-f16-attention-patch/run-IYU0dg`: **18/18 PASS** for apply/repeat/restore,
every partial application of the three hunks, drift, links, Git environment and
build dependencies. Tests found and fixed rejection of unrelated edits at the
shader's end and an ambiguously reapplicable partial patch; failed receipts
`run-fwTex3`, `run-ian9Sq` and `run-bf2pDf` remain.
`q36-attention-work/run-rbLfBX`: **13 GPU cases PASS**, comparing every query
directly with the original kernel, including extreme values, sink, tile bounds
and positions beyond 50,000. Allocation failures and failures at every encoder
creation stage leave no incomplete submissions or leaked scratch memory;
a new explicit operation still produces the complete original result.

Separate native tests with simulated numerical sessions pass: owner **52/52**
(`run-A0gWF6`), cache **8/8** (`run-yMP4q1`), batched HTTP preparation **24/24**
(`run-31WJe5`) and cancelled admission (`run-2JPSHA`), with sanitizers on paths
covered by their respective runners. These are not additional LLM answers.
The first-slice patch is `f4ff02bb…`, on candidate d02b6a20 with the three
documented overlays; Metal build PASS. Actual preflight `run-QGuUWs` restores
and reapplies all four overlays only in a private copy: 210 files and their
identities are preserved. Admission fixtures **11/11** (`run-1fff4n`).

Real replay `q36-retained-diagnostic/run-DKItGr` finishes at 16:06 CEST:
**FAIL at the original 900-second deadline**. The last chunk completed before
expiry reaches 29,952/50,869 tokens, 58.9%; the next finishes at 30,080 during
teardown, not a valid answer. The earlier Metal error does not recur, but the
request remains incomplete: neither a qualified fix nor improved quality.
No limits were extended or model changed. The owned engine exits normally in
about 2.36 seconds, without SIGKILL; the port is free, all 29,106 log bytes
retained, and inputs/sources/weights preserved.

A three-second OS sample during prefill attributes 1,683/2,613 worker samples
to waiting for F16 segments: it locates the wait, not individual shader timings
or p99. A catalog GET returns HTTP 200 while the model works; this is not UI E2E.
The next diagnosis must separate the two GPU passes' cost and reduce necessary
work while preserving numerical checks. Installer and app are not promoted.
The common baseline remains **61/100**, and the full P0–P11 plan remains open.

### Targeted diagnosis finished: F16 command identified, fix still open

Separate replay `q36-retained-diagnostic/run-fX3sws` finishes at 15:19 CEST
with HTTP 500 after 882.23 seconds, before the original 900-second deadline.
The driver reports one **Faulted** encoder, `q36_attention_f16_parallel`, in
command `attention-tile pos=27196 queries=12 heads=24`; the server identifies
layer 23's full-attention block, with the chunk starting at token 27,136.
It is still `ImpactingInteractivity`, not a client timeout or proof of
out-of-memory. Identifying the command alone does not establish the driver's
internal cause or the required mathematical fix.

The retained long case keeps the same 27B Q6_K_XL weights, prompt, quality/F16,
65,536 context, 128 prefill, seed and limits. q36 candidate `d02b6a20` uses the
three recorded patches and explicit diagnostics; its upstream delta from the
previous pin does not change core/Metal. Frozen sources, binary and inputs are
unchanged; 26,663 log bytes are received/saved, the engine exits normally and
the port is released. Other programs are not stopped. This is diagnosis, not
a speed comparison or renewed Qwen-family qualification: the full result remains
61/100.

Before launch, fixes addressed rejection of underscores in IDs, verification
of overlapping patches, and omission of added shaders untracked by Git.
Ten behavioral groups and preflight on the actual candidate PASS; both original
failed preflights remain. The next fix must address the actual failed F16 work
and pass numerical oracles, state/cancellation checks and new real requests.
No newly installed `.app`, weight download or push belongs to this slice.

### P6 — common 100-case corpus: first 27B run finished with failures

The [readable report and Matplotlib chart](../extension/benchmarks/qwen-quality/README.md)
show the complete 61/100 result of `run-82sH0Q`, retaining all 39 failures.
Public JSON without prompts/answers/personal paths, the script and PNG are in
the worktree for reviewed publication; no push had occurred at this point.
This is not the new F16 candidate or an Agent comparison.

The original corpus is implemented in `tests/fixtures/common_model_quality_cases.py`
and `common_model_code.py`: 12 arithmetic, 12 reasoning, 15 programming,
ten debugging, ten JSON, ten extraction, ten instruction-following, eight
Italian/English, eight long-context and five insufficient-information cases.
Expected answers are not built from private documents or model answers.

`make test-common-quality-oracle` passes: **11 regression groups**
(`common-quality-oracle/run-6yr_5rmh`, then `run-1ctejn_o` after expanding
allowed Python built-ins) and HTTP with **simulated** responses
(`run-9bpZsu`, then `run-7kdP0r`). It verifies all 100 reference answers and
100 deliberately wrong answers, ten patches applied in isolated workspaces,
original pre-fix failures, preserved tests/files, strict JSON and logarithmic
binary-search reads. The OS sandbox blocks personal files, writes, networking
and fork; CPU/runtime and I/O are bounded. Memory uses a sampled 256 MiB RSS
threshold that terminates only its worker, not a hard address-space ceiling,
which macOS rejected during preflight. Runaway execution and RSS overflow have
executed regressions. None of these passes measures an LLM.

The first real run is `engine-acceptance/run-pnsGev`, with a tester-owned q36
engine, pin `d67687ed`, existing 27B Q6_K_XL weights and their complete hash
verified. Frozen settings: Metal, quality kernels, F16 KV, 65,536 context,
128-token prefill chunks, no expert streaming, thinking off, temperature 0,
seed 20260909, at most 2,048 output tokens. Ordinary/code/long deadlines are
180/240/900 seconds; long cases require at least 12,000 actually reported prompt
tokens. Manifest:
`e8e0899342d5f4b94ca97f7e0d58684757392592890f03811afc176156e95f06`.
It finishes at 09:13:15 UTC with **55 PASS, 33 FAIL, 12 not run**.
Case 88, the first long context with 50,869 prompt tokens, loses transport
after 300.85 seconds: Node's `fetch` applies its own 300-second header deadline,
before the case's declared 900 seconds. This does not demonstrate a model
timeout at 900 seconds. The tester queues no further requests after the error
and shuts down its own engine; sources, binary and weights are preserved.

A separate grader bug rejected Python intervals represented as tuples despite
preserved values, order and inputs: the task did not require mutable lists.
An independent reference reproduces the false FAIL, and four regression groups
verify the correction without accepting incorrect values, order, shape or
mutation. Only after the run finished were all saved complete answers regraded
separately in `engine-acceptance/run-pnsGev-regrade-interval-v1`:
**56 PASS, 32 FAIL, 12 not run**, changing only `code-merge-intervals`.
Original prompts, answers and receipts are unchanged; this is not new inference.
The 32 failures comprise 31 nonconforming answers and transport interruption,
not 32 model errors. Arithmetic errors, inapplicable patches and explicitly
forbidden formats remain FAIL.

The runner now reuses the harness's native HTTP client with the case's explicit
deadline and a 2 MiB response bound. `http-deadline/run-Rms94O` actually verifies
a **305.01-second** delayed response: old `fetch` fails at 300.98 seconds with
`UND_ERR_HEADERS_TIMEOUT`, while the new path finishes within the same
320-second total limit. No model participates in this regression. The full
`make test-common-quality-oracle` gate passes after both fixes, including HTTP
and regrading of simulated receipts. Subsequent inference must be labelled
`development-replay`, with the same 100 prompts, settings and deadlines;
it does not replace the first attempt.

No download, installed-app replacement or push. Full P6 qualification,
numerical oracles, other selections and the rest of the plan remain open.

Run `engine-acceptance/run-04wsyc`, a `development-replay` with the same model/
binary, 100 prompts, settings and limits, finishes September 9 at 10:04:21 UTC:
**56 PASS, 32 FAIL, 12 not run**. The first 87 cases have 56 PASS and 31 answer
failures. The long case exceeds the old client limit but receives HTTP 500 after
748.26 seconds: Metal reports
`kIOGPUCommandBufferCallbackErrorImpactingInteractivity` at token 25,344 of
50,869. This is not the 900-second deadline nor, from this log alone, proof of
RAM exhaustion or numerical instability: the later finite-value check encounters
a failed GPU command. The tester stops the queue and closes only its owned engine;
processes and port are released. This native error requires separate diagnosis
and regression; the old transport error and all original results remain.
Design browser/build checks on the same host are disclosed shared load, not
additional inference; this run is not a speed comparison. The public summary
has its own test: it rejects partial runs, missing cases, inconsistent denominators
and simulated responses without model identity; removes paths, prompts and raw
answers; and separately classifies correct values inside unwanted wrappers
while retaining their FAIL status.

### Subsequent Metal fix and new complete run

Final replay result, **September 9 at 14:42 CEST: 61/100 PASS, 39 FAIL**,
with no cases omitted or still running. Of the failures, 31 concern answers/
formatting and 8 concern long contexts: three Metal `ImpactingInteractivity`
errors and five original 900-second deadlines. The nine correct values enclosed
in a prohibited wrapper remain FAIL. The ten patch requests remain
0/10: they test returned diffs, not the complete Agent tool loop.

Eight restarts of only the tester's engine allowed later cases to run without
retrying failed ones. Source and weight identities are preserved; the final
process is closed and the port released. Original receipts and the aggregate
are in the ignored artifacts for `run-82sH0Q`. The query patch **does not yet
qualify long contexts**. The separate diagnostic binary was not used for this
result; a targeted reproduction is now needed before further mathematical
changes. No speedup is inferred from shared load, and no new app was installed
or changes published.

History of preparation and intermediate observations:

The isolated F16 operator reproduces the same driver error without opening a
model (`q36-attention-work/run-oY3ztb`). The patch now splits attention queries
into bounded GPU commands without changing shaders, arithmetic order,
F16 KV, context or the model's prefill chunk. Every query in the fixtures
is compared byte for byte with the single-query path; a separate analytical
reference allows only the declared FP32 rounding error.
Guards, six shortened views, overflow and failure of the second submission
are verified: no hidden retry or driver wait under the shared mutex.
Total operator time may increase: no speedup is claimed.

Patch `75764a9f…`: native Metal gate `q36-metal-runtime/run-ImYLpv` **40/40 PASS**,
including lifecycle/apply/repeat/restore, ownership, tools and synthetic oracles.
A new installation from sources downloaded into an empty directory passes,
with q36 still at `d67687ed`; no weights downloaded. These checks do not run
the full model or certify other backends.

The real run `engine-acceptance/run-82sH0Q` starts at 10:28:36 UTC, with server
`e94a2c75529c1e3acb2efbe2ea5c8266c21807979d0738edb5f6a70e4939f6bf` and the
same 100 prompts, weights and limits as the previous attempts. At this point
in the history, this development replay is **still running**. Explicit tester
supervision is enabled: at most eight restarts of only its own engine, after
verifying its exit, to proceed to the next case. No failed case is retried or
replaced; context, precision and deadlines remain unchanged. Simulated HTTP
checks verify the handoff barrier, retained error, restart limit, rejected
identity and stop/interruption. The real result is still pending at this point.
The installed app and the previous project bundle are not automatically
qualified by the new patch; they have not been replaced or restarted.

Update during the same run: case 88 still fails with
`ImpactingInteractivity`, this time in the full-attention block of layer 23,
at token 26,240 after **830.63 s**. Splitting the queries passes the isolated
probe but **does not yet resolve the failure in the full model**. This is not
the case deadline. The previous engine exits with code 0 and is reaped before
its replacement starts: this part of supervision is now also verified with
a real native error. Case 88 is not resubmitted.
Cases 89–91 instead reach the original limit of approximately **900 s** and
fail with timeouts; each outcome remains separate. After four restarts of the
owned engine, the snapshot with case 92 running is: **56 PASS, 35 FAIL, 9 pending**.
The commands/kernels responsible for the remaining error must be identified;
the driver message alone does not establish a numerical or RAM cause. No
changes to the active run's sources, settings or limits.

The rechecked q36 tip is `d02b6a20`, just one commit later: it changes the
Agent's private terminal, not the core or inference kernels. Downloaded into
an isolated checkout; the Metal patch applies. The delta is documented in the
[source review](upstream/q36-2026-09-09.json). The installer pin and the run's
engine remain unchanged.

### q36 terminal and GPU diagnostics — separate verification

The new upstream CLI failed on macOS with `NO_TERMINAL`: it closed the last
slave descriptor of the private terminal before the command opened `/dev/tty`.
The [dedicated patch](../patch/q36-agent-tty/README.md) keeps it until the job
closes, without handing ordinary stdin to the terminal or changing the
DStudio desktop loop. Baseline still FAIL and candidate PASS with the same
oracle: seven **fake** password scenarios, no sudo or real credentials.
The `q36-agent-tty/run-sruxs17f` gate passes **24 phases**, including 32 normal/
cancelled shutdowns without leaks, unchanged layout, apply/repeat/restore, drift,
partial patch and symlink checks. This does not test Agent answer quality.

The previous timeout `run-h1p4lodm` is retained: the test reader kept reading
EOF millions of times until each scenario's deadline. It now stops at the
first EOF. A probe using the original reader fails deterministically on the
second empty read; the corrected reader passes. Deadlines were not increased,
and terminal secrecy/restoration checks were not removed.

A three-second OS sample during case 91 mainly identifies waits for attention
GPU tiles to complete. It does not by itself identify the command responsible
for the watchdog. The new
[optional diagnostics](../patch/q36-metal-diagnostics/README.md) record encoder
phase and state within fixed limits; they are disabled by default. The
`q36-metal-diagnostics/run-5p3pcw` gate passes with real Metal commands and
explicitly simulated error receipts. The separate diagnostic binary builds,
but at this point has not yet run on the model: no fix for the failure or
complete numerical parity is inferred. The `.app` remains unchanged.

### Images in 27B tools: path implemented, qualification in progress

Agent and Cowork can now use `view_image` with the local 27B server already
loaded. The tool runtime retains the workspace's original PNG/JPEG bytes;
decoding and the projector remain in the selected engine.
A second model is not loaded. The current limits are 2 MiB per image,
eight retained observations and 16 MiB for serialized history; no silent
resizing or discarding to fit the limits.

Loading rechecks file identity, confinement and cancellation.
An interrupted response or decoder error removes only new, uncommitted
images: it retains previous observations, original files and a receipt that
does not claim to have interpreted the pixels. The change is recorded in
`patch/ds4-agent-jsonl/remote-vision.patch`; first-party fragments remain
the build inputs, with no hidden checkout rewrites.

- Real host, tools and files with simulated inference: **17/17 PASS**
  (`q36-agent-host/run-nWTjuD`), repeated with an ASan/UBSan host
  (`run-gmJd19`). These checks do not measure visual quality.
- Native builds/probes and sanitizers on the four bases main/GLM, Laguna,
  Qwen3.6 and Qwen3.8: PASS (`agent-native-build/run-neFj1v`). The image tool
  remains restricted to the explicitly admitted 27B server; no CUDA/Vulkan
  qualification is inferred from compilation on this Mac.
- Patch application/restoration: five Agent bases PASS
  (`agent-patch-migration/run-xkooOY`), nine web/server variants PASS
  (`runtime-patch-migration/run-Hq9aKO`). Development failures are retained,
  including the one that exposed rejected images being resent on the next turn.
- The real gate `q36-host-live/run-PnuF7a` finishes **14/14 PASS** at
  06:53:40 UTC, with unchanged inputs and a clean host shutdown. It retains the
  ten original checks and adds four pixel questions in Agent/Cowork.
  Agent fixes the program and runs its tests in 115.4 s; Cowork creates and
  rereads the Excel file in 209.0 s. Images take 64.9/133.0 s in Agent and
  108.1/208.4 s in Cowork. This is neither a causal speed comparison nor the
  required broad visual corpus; it does not test the UI or the installed `.app`.

Inspecting the actual requests revealed another gap: the catalog offered
`view_image`, but the prompt denied visual capability and host status reported
it as inactive in tool modes. Following the run, the worker was changed to
restore its own local configuration after the build; status uses the ready
server and the frontend actually associated with it. The new test fails on the
previous binary (`run-zN1ydR`, 2/17) and passes **17/17** with the fix
(`run-1ZbWEm`), including with an ASan/UBSan host (`run-hO9Plw`).

The UI also failed to recognize the 27B projector. It now admits its attachments
in the Chat/Tutor/Cowork paths without attributing the same capability to
text-only Qwen models, cloud or LAN. UI functions pass **24/24**
(`qwen27-model-ui/run-3B80QC`); the earlier 20/24 with four attachment failures
is retained. These tests simulate PDF preparation; they do not qualify
extraction, visual understanding or the full Tutor. The browser path connected
to the real host also identified an unnecessary reload: on a mode switch, the
UI omits the private port and cache settings, which the host replaced with
defaults. It now preserves omitted values for the same owned model, without
ignoring explicit changes. The new regression fails with the previous behavior
(`q36-host/run-T8RjFS`) and passes with the fix (`run-j9yyVo`, **12/12**).

The browser path passes **19/19** in WebKit/Chromium and light/dark themes,
with simulated inference. The oracle was then strengthened: seeing an answer
during streaming is insufficient; the real host must save it, and it must remain
visible after completion. This additional check passes **19/19** in every
combination: WebKit light `run-wXzwCR`, dark `run-FzhmtJ`, Chromium
light `run-rmGTpN`, dark `run-NMPv0o`; final screenshots inspected. The lifecycle
gate was extended to **14/14**, also with ASan/UBSan, including explicit
port/cache changes and invalid values; tools with a sanitized host pass
**17/17** (`run-UEc3MT`).

The new real run `run-9er45q` finishes **17/17 PASS** on September 9 at
07:43:20 UTC. It retains the fourteen checks and adds three WebKit cases:
exact text and two images uploaded from Chat. Answers `red`/`blue`, image
payloads and saved history are verified; screenshots inspected. Agent fixes
the code and runs the four original tests; Cowork creates and rereads the
Excel file, also checked by an independent reader. Both answer the two visual
questions. Returning to Chat preserves the model process, and Stop releases
the process/port. Inputs unchanged, host exit 0; no timeout increased. The first
Agent command on a nonexistent path remains in the receipt, along with the
subsequent recovery. This does not qualify the broad visual corpus or the `.app`.
Private checkpoint: `qwen27-vision.sUp0XU/`. P3/P4/P6 and the full plan remain
open; no push performed.

### Bundle and startup with 27B already selected

Testing in the macOS window exposed a path not covered by hosts using
`DS4UI_TEST_MODE`: during normal startup, DStudio attempted the `ds4_agent.c`
recovery check in the q36 checkout, which does not contain that source. The
false error appeared in host status before a model was even loaded.
The ds4-specific startup operations are now excluded from q36; its
Agent/Cowork frontend is still prepared separately by the launch worker.

`make test-engine-startup` exercises normal startup with a persisted checkout,
but explicitly deferred inference: before **3/4** (`run-fypKNz`), after
**4/4** (`run-7jwKt9`), including with an ASan/UBSan host (`run-eJzqri`). Real
errors for missing or modified native sources remain visible, and backups
remain intact. Setup, 28 preflight checks and 27B lifecycle **14/14**
(`run-eQymWZ`) pass with the fix. These are not numerical checks.

The local bundle was rebuilt on September 9 at 09:56 CEST, and
`make test-macos-bundle` passes: signature, materialized support files, engine
catalog produced by the executable, manifests for both 27B components and batch
commands. This build is not yet the plan's final release. The copy in
Applications was neither replaced nor restarted. The new Chat check in the real
isolated window passes (`desktop-chat/run-VXqvBB`): 27B selection through macOS
controls, keyboard input, exact JSON `{"total":23,"city":"Torino"}`, saved
history and final text in the accessibility tree. Screenshot inspected;
Thinking High, 65,536-token capacity, 1,845 prompt tokens and 91 generated,
41.93 s observed end to end. This is not a comparative benchmark. Closing only
the test window terminates the GUI, server and model and releases both ports.
This is a Chat workflow, not the full mode or vision matrix.
The first attempt `run-NXrJM0` remains failed before submission because of the
tester's cwd: the isolated-profile check correctly stopped it.

Subsequent work on the nine design systems produces a new local bundle
(September 9, 11:57:59 CEST), executable SHA-256
`35cdb4d3cc9b508161d9be9fcfceb55b73244c71d8e80d26f5b51562b149c200`:
signature and `make test-macos-bundle` PASS. This is not a new real Qwen test
and does not automatically inherit the previous bundle's desktop qualification.
The September 8 copy in Applications remains unchanged; no user app restart.

### Installation inventory

The baseline now includes q36 even when it is not selected, its two binaries,
C++/Objective-C++ sources, C fragments and CMake recipes. The regression uses
real directories and links: previously two installations were detected instead
of three; afterward the inventory is complete and deduplicated. The first updated
capture, `quality-multihardware/baseline-gKB1Mm`, records 1,108 project files,
six installations and 16 unique weight/component files, with no errors or model
starts. It does not repeat full weight hashes or qualify inference.
The subsequent `baseline-1woSTv`, after the startup fix, records 1,109 project
files and the same six engines/16 artifacts, with no errors. The complete
suite inventory and executable P0 baseline remain open.

### Agent/Cowork prompts: duplication fixed, real path 10/10

The preparation worker built the tool program with a temporary option for
remote compilation. The prompt generator interpreted that option as the model's
protocol and reinserted seven JSON signatures already sent in the `tools` field.
It now receives the admitted protocol explicitly: it does not change with
temporary compiler settings. Native legacy/DSML paths retain their own
inline catalog.

`COWORK.md` also repeated five Office signatures already supplied by every
family's runtime. It now contains operating rules and argument examples,
while the signatures remain in the runtime. Reading relevant sources in full,
reopening saved files and verifying results remain mandatory.
No filter removes user-written JSON: the test preserves an example in
`MEMORY.MD` verbatim that deliberately uses the name `read_pdf`.

- Real host, private worker, Agent/Cowork and files: **15/15 PASS**
  (`q36-agent-host/run-MXbqIc`); repeated with an ASan/UBSan host **15/15**
  (`run-2mzAaw`). Simulated inference and installer, not model quality.
- Host generator: 42 mode/protocol combinations in the
  `make test-engine-setup-unit` gate; legacy catalogs preserved.
- Runtime-produced signatures: main/GLM **10/10** (`agent-prompts/run-0ktbBu`),
  Laguna **6/6** (`run-GApdf2`), Qwen3.6 parser/tools
  (`qwen35-agent/run-vawRfn`) and Qwen3.8 (`qwen38-agent/run-BiAa4n`) PASS.
  Qwen3.8 uses the prepared candidate `b85a6174`, not the old user checkout.
  These tests do not load weights. Initial failures remain recorded:
  unsupported Qwen3.8 checkout `run-HkOKYS`, core without the preparation API
  `run-0hUdCk`, incomplete linking of the Laguna probe `agent-prompts/run-nalRNk`.
- Agent HTTP requests retain exactly the same 18 formal signatures;
  the system message shrinks from 9,538 to 7,754 bytes. In the second change,
  Cowork retains the same 21 signatures and shrinks from 15,684 to 13,753 bytes.
  These are sizes observed in fixtures, not tokens or a proven speed increase.
- The first real replay with these changes (`q36-host-live/run-IfkKfV`)
  remains **6 PASS, 1 INTERRUPTED, 3 NOT RUN**. The receipt has no terminal
  outcome; after the Mac restarted, the process and its handle no longer exist.
  Neither a timeout nor success is inferred. Original and separate note retained.

The subsequent replay `q36-host-live/run-VN7pK3` completed Agent in 202.8 s
and Cowork in 178.0 s. Code fixed, four original tests run, Excel file created
and reread: independent file checks pass. However, the gate remains
**7 PASS, 1 verifier FAIL, 2 NOT RUN**: for CSV files, the `inspect` tool already
returns all cells, but the tester required the name `read`.
The original receipt was not rewritten.

The new oracle verifies the cells actually returned and the sequence
read → create → reread. `inspect` is accepted for CSV/TSV only with complete
data; XLSX `inspect`, which returns only metadata, does not count as reading.
Sixteen regressions with the real Office helper pass
(`cowork-spreadsheet-oracle/run-lEAkkr`), alongside Office 17/17, tables 15/15,
bridge, HTTP and preview checks. The separate audit of before/after receipts
keeps old timeouts failed: a correct file does not remedy an incomplete turn.

The complete repeat `q36-host-live/run-jUOR7P` finished on September 9
at 06:03:15 UTC: **10/10 PASS**, unchanged inputs, host exited with code zero.
Agent fixes the program and runs the four original tests in 137.2 s;
Cowork reads the CSV, creates and rereads the independently verified Excel file
in 234.9 s. The same model process then answers in Chat, and Stop releases
the process and port. Unchanged 240-second limit, same weights, precision,
requests and file checks. Cowork's time is close to the limit, and one successful
run neither erases previous timeouts nor demonstrates general reliability.
No speed comparison is attributed to the prompt change. Commands,
fingerprints, failures and audits are in the ignored checkpoint
`qwen27-prompt.9HVCJl/`. Broad quality, Learn, vision across modes and other
backends remain open. No `.app` rebuild/installation, app restart
or push in this tranche.

### Metal diagnostics: measuring without changing calculations

`make test-q36-sync-profile-live` builds two private probes of the same engine,
one normal and one with counters at synchronization points. It does not change
checkouts, installed binaries or kernels. In replay `q36-sync-profile/run-Nd9StF`,
the 3,307-token prompt, eight greedy choices and hashes of all FP32 logits
match between the two probes; inputs unchanged. This proves the diagnostics'
integrity for that case, not the correctness of the answer or Agent.

The seven measured decode steps produce 2,926 command buffers: 2,695 complete
at numerical checks and 224 at RoPE steps. Call time includes prior GPU work:
**it is not all time wasted on checks**.
Finiteness checks, quality mode and precise RoPE were not disabled.
The counters occupy 440 bytes and are present only in the probes. One pair
of replays does not demonstrate a speedup, a p99 or parity with other backends;
sampled RSS does not represent the weights' total GPU memory.

### Downloading 27B from Settings: installation, Stop and resume verified

Qwen3.8-27B Q6_K_XL and its projector can now be downloaded from Settings →
Models. The compatible engine is prepared in the background; the selection and
already active model do not change. Installation, transfer and hash verification
have distinct states: the UI does not display a byte percentage as though it
measured compilation or verification. Completion requires a successful process
outcome, not merely file presence. Downloads stay in Settings;
they do not replace the model name in the composer.

- Host HTTP/processes/files: **7/7 PASS** (`qwen27-download-host/run-wMU82f`),
  repeated with an ASan/UBSan host **7/7** (`run-T5sFf2`). Installer and weight
  bytes simulated; processes and controls are real. The Stop unit check keeps
  a separate model process alive. ASan does not qualify kernels.
- Downloader: **25/25** with curl and small files over local HTTP, real hashes,
  resume, directory replacement, cancellation and concurrent leaders.
  UI functions: **18/18** (`qwen27-model-ui/run-Rqh22L`).
- Real UI/host, simulated weights: **5/5 per combination**, WebKit light
  `run-QCOTqa`, dark `run-bHaXFJ`, Chromium light `run-V81kFZ`, dark
  `run-jtk5CY`, under `qwen27-download-browser/`. The effective theme is checked
  in Settings: the operating system's dark theme alone was insufficient.
- Installation reuse and SHA-256 verification of the **two real files**, totaling
  26.2 GB: `qwen27-download-settings-live/run-C0HYkz` PASS. File identities
  and inputs unchanged. No new transfer or inference in this specific check:
  it is not a speed or quality benchmark.

The physical target for the download and Open folder remains the admitted one
even if the selected checkout changes in the meantime. The old HTTP 400
(`run-xn4rXC`) and Stop failure (`run-Y4VbST`) are retained: the child inherited
the host's SIGTERM handler. The fix blocks signals during fork and restores
only the worker's behavior before running the installer. Receipts for initial
browser tester errors remain separate from production defects.

The ignored checkpoint `qwen27-settings.zWoJQm/results.json` collects commands,
scope, failures and the twelve input fingerprints, rechecked as unchanged.
This tranche does not update the installed `.app`, publish changes or close
P3/P5: deleting private partial 27B downloads from the UI remains explicitly
unsupported; resume, verification and Stop are available. The real mode checks
and quality failures reported below remain separate.

### Agent/Cowork 27B history: connection and initial failures

The code now connects DStudio's native runtimes to the separately owned
27B server. Chat, Agent and Cowork can reuse the same model process;
the tool frontend does not load a second copy of the weights.
The path remains local and does not change cloud credentials or selection.
Response delivery is bound to both the tool process and the server generation:
Stop or loss of the model invalidates late responses.

- `q36-agent-host/run-5QgR9n`: **10/10 PASS**, real runtime and tools,
  simulated model responses and installer. Read/write, Cowork without
  shell, reuse, preparation cancellation and failure, transport interruption,
  model loss and Max at 96k. The first `run-3sYvFC` remains FAIL:
  the tester did not copy `.gitignore`, required for patch verification;
  no drift check was weakened.
- Parser/lease/model identity **82/82 PASS**; host lifecycle **12/12**
  in `q36-host/run-JdjefV`. Repeated with an ASan/UBSan host: **82/82**,
  lifecycle **12/12** (`run-zLkKfZ`) and Agent/Cowork **10/10** (`run-Z1YUZy`),
  with no sanitizer diagnostics. These checks simulate the model; the tool
  runtime is still compiled normally, not under ASan.
- Transport rerun on the updated host: ingress **18/18** (`run-jzBHN6`),
  lifecycle **6/6** (`run-XzuUUl`), direct streaming **61/61** (`run-Hqs0wS`),
  HTTP/HTTPS relay **63/63 each** (`run-dBHPTR`, `run-yI5omc`), Stop **36/36**.
  These checks do not use an LLM.
- Isolated installation `qwen27-agent.sZoEZ2`: actual download of pinned
  sources main `f62ca29a308724cde5bc99134ede19104b2a3260` and q36
  `d67687ed15ad9f52b755a9b5fdfc0214ea937555`, patches applied and executables
  built with the production installer. No new weights downloaded.
- First real tool gate `q36-host-live/run-qSbThA`: **6/10, FAIL**.
  The tester submitted before the native readiness handshake; it now waits for ready/idle.
- Real replay `run-K51Sxx`: **6/10, FAIL**. The model reads both files,
  proposes an edit with an incorrect line prefix, receives the rejection and
  fixes the source. It does not finish the turn within **240 seconds**, so this
  is not a PASS; Cowork and return to Chat were not run in this attempt.
  No deadline increase.
- Diagnostic replay `run-Pbm6tm`: **6/10, FAIL**, same deadline. The native
  trace shows that tool turns lose the already processed prefix: reconstructed
  history omits an empty `<think>` block present in the previous output.
  Comparison with the templates embedded in both GGUFs confirms that the block
  must be preserved. Sampling was not changed to obtain a PASS.
- q36 patch `09bd9201…`: fixes only the Qwen renderer; KAT, weights and numerical
  calculations remain unchanged. New native/Jinja comparison with ASan/UBSan:
  previous source `q36-chat-template/run-4zpgdgcy` **14/32 FAIL**;
  candidate `run-awibzr6v` **32/32 PASS**, 27B and 35B, thinking off and both
  explicit preserve values. These are format checks, not 32 LLM answers.
- Isolated installation `qwen27-template.aqfV1K`: main and q36 sources downloaded
  again from the network at the pins above, patches applied and binaries rebuilt.
  The first native gate `q36-metal-runtime/run-NSyTS0` remains **FAIL**: the old
  oracle for an image in history omitted the same 19 bytes required by the
  template (expecting offset 129 instead of 148). Fixed by checking the entire
  prompt and adding a case with nonempty reasoning; the old engine still fails
  the corrected case in `q36-http-vision/run-TUt5S1`.
  The complete gate was rerun from the start: `run-EhGLEr` **36/36 PASS**,
  including the corrected image oracle **48/48** in `run-A9Snfz`.
- Normal replay `q36-host-live/run-9G0TiY` and diagnostic replay `run-rhl0st`:
  both **7/10, FAIL**. Agent now fixes the file and passes the four unchanged
  tests without reloading weights. Cowork reads the CSV but does not create
  the Excel file; the final two checks are not run. The trace confirms that
  the tool prefix is preserved and identifies a second bug: q36 converts
  `sheets_json` from the string declared in the schema into an array. The model's
  data was correct; DStudio's validation rejection was correct.
- Patch `73441ab5…`: the decoder follows explicit string types in the schema
  for the final result, SSE and RAM/disk replay; no Excel-only exception and
  no weakening of tool validation. Initial corpus
  `q36-tool-schema/run-QM8Zip` **24/48 FAIL**, corrected **48/48**. The extended
  corpus retains earlier cases and adds groups, nested schemas and API forms:
  same test **27/66 FAIL** on the previous source (`run-QYwbCB`),
  **66/66 PASS** on the candidate (`run-C7PHzU`), with ASan/UBSan. These are
  explicit output fixtures, not new model answers.
- Updated complete gate `q36-metal-runtime/run-mxZQJM` **40/40 PASS**:
  includes the new checks and application/restoration of the caller in the
  upstream test. Attempt `run-9TP4TH` remains FAIL: the signature update in
  `tests/q36_test.c` was missing; it is now in the `.patch`, without removing
  the test. Jinja comparison on both GGUFs repeated **32/32** (`run-e1qc1_6a`).
- Isolated installation `qwen27-tools.nvhVvB`: main/q36 downloaded from the
  network, patches applied and real builds completed; same existing weights,
  no new download. Complete real replay `q36-host-live/run-6TDIrp`: **7/10 FAIL**.
  Agent finishes with the four tests in 235.9 seconds; Cowork now receives
  the correct type and actually creates the file, but exceeds 240 seconds
  before completing verification and the turn. Return to Chat and the final
  acceptance Stop were not run; cleanup of only owned processes completed.
  The subsequent independent check finds all 16 cells correct and the CSV
  unchanged; this separate receipt does not change the original FAIL. All
  frozen inputs are unchanged. Diagnostic replay `run-LAUIAW` completed:
  **7/10 FAIL**, same deadline. Agent finishes in 153.1 s; Cowork reads once,
  produces JSON with an extra bracket, receives the error and corrects it.
  The resulting file again passes the independent 16-cell oracle, but the
  turn is interrupted during `inspect`, without final verification. Prefix
  reused across tool turns; this trace does not show the old cache bug. Separate
  receipt `post-run-artifact-check.json`, failed original retained. This is not
  a speed comparison: generations and shared load differ.

### Excel reading and verification — September 9, tools fixed; real gate open

Cowork now reports when it reads only part of a sheet, how many other sheets
exist and when returned text was truncated. Data extent comes from cells
actually saved, not a potentially stale XLSX declaration. Document table
extraction rejects a declaration that would hide source cells.
Original document bytes remain unchanged.

The creation receipt reports actual sheet names and saved ranges, but **does
not declare the file verified**: a subsequent read is still required.
Serialization stops before expanding all cells beyond the limit; it respects
both the character budget and the native bridge's UTF-8 budget.
A non-UTF-8 CSV produces an explicit error, not silent substitutions.

- `make test-cowork test-cowork-bench-validate`: Office **17/17**, document
  tables **15/15**, native bridge, HTTP and preview PASS. Validating the
  manifest's 16 questions is not equivalent to 16 LLM answers.
- C bridge repeated with ASan/UBSan PASS; Python and kernels are not instrumented.
  Regressions include data beyond A1:T50, incorrect XLSX dimensions, Unicode,
  partial reads, normalized names and 150 deterministic matrices compared
  against the reference serializer. These are not 150 model questions.
- Real replay `q36-host-live/run-DRYH5n`: **7 PASS, 1 FAIL, 2 not run**.
  Agent finishes in 133.8 s; Cowork creates and rereads all 16 correct cells,
  but exceeds 240 s during the final answer. Independent OOXML check retained
  separately; it does not replace the FAIL. This run precedes the latest
  refinements to the serializer and `inspect`.
- Final replay `q36-host-live/run-MvbQ1F`: **6 PASS, 1 FAIL, 3 not run**.
  Agent edits the file but exceeds 240 s before running the required tests;
  Cowork and the final two checks are not run. Frozen inputs unchanged,
  test process cleanup completed. This is neither a regression attributable
  solely to the Excel change nor evidence of a performance improvement.

Commands, fingerprints and initial failures are in the ignored checkpoint
`cowork-read-scope.zKdqdQ/results.json`. The real limit was not increased;
quality, context and tool validation were not reduced.
Timeouts still need to be resolved and real qualification completed. The
installed `.app` remains the September 8, 14:01 build; no push in this tranche.

### Max admission and Goal receipts — September 9, targeted checks completed

Additional issues reproduced in the host/tool path:

- `/gsa` and `/rsa` accepted Max on 27B with an 8k context, bypassing the
  startup check. `q36-agent-host/run-QEnrMH` retains the RED: HTTP 200 instead
  of 409. The check now precedes task/graph/Goal and is repeated by the owner
  on every graph attempt. The original display preserves the Max request
  across resumes; context is not raised and thinking is not silently lowered.
- `run-ZJ01pq` reaches **12/15**, then discovers a second issue: a real Bash
  command passes, but the color code emitted before the `tool_result` frame
  causes it to be discarded. Goal continued even after the correct result.
  The decoder now follows the protocol's RS delimiter, like the host reader,
  and requires an actually returned, complete, unexpired result with exit
  status zero. Explicit tests also cover interrupted/unknown receipts and
  stdout attempting to fake a successful exit status.
- `run-u2Dq20` reaches **13/15**: an explicit clarification request did not
  stop Goal. The check read the buffer without respecting its length,
  including remnants from previous turns. It now uses the same copy bounded
  to the current attempt, excludes prompts/events and recognizes markers
  separated by progress frames. Four regressions use unterminated buffers and
  residual bytes; no limits increased.
- After the first **15/15** normal (`run-znRKBx`) and ASan/UBSan (`run-dhhcOZ`)
  passes, the check was strengthened: rejecting context only at dispatch still
  consumed an attempt. RED `run-XohLVt` **4/15** retained.
  Start/resume now validate before journaling, without spending the budget;
  dispatch retains its own revalidation. Restoring 96k lets the same Goal
  resume and finish with a real Bash verification, without recreating it.

These test the real host and tools with simulated inference, not new LLM answers.
The ten previous scenarios remain. Final gate **15/15** normal
(`run-3bbPe3`) and **15/15** with an ASan/UBSan host (`run-2nXmmo`). Goal passes,
and Task Graph passes **2,556 checks**, normal and ASan/UBSan; q36 lifecycle
**12/12** (`q36-host/run-46qbcK`) and parser **82/82** with sanitizers.
Task Graph HTTP, preflight **28/28**, launch-control **11/11**
(`http-7TSTiC`) and Qwen spawn **16/16** also pass. Agent/Cowork runtimes built
by the tester are normal builds; sanitizer qualification is not extended to
their kernels or an LLM.
The old Goal unit helper directly reset state without producing the terminal
receipt now required: it now runs the real WAITING marker reader instead.
Both unit failures (framing and terminal fixture) are retained in
`qwen27-admission.atwL6u/intermediate-commands.json`.
Commands, output and tranche identities are in the same ignored checkpoint.

Successful real verification, durable tool history, images/PDFs, real Learn
and complete qualification are still missing at this point. UI installation is
now connected as described below; it does not qualify model workflows. The
`.app` in both usual locations remains the September 8 **14:01:10 CEST** build;
no rebuild, restart or push in this tranche.

### Chat and interface

**27B answers from DStudio's real Chat in headless WebKit.** The selector
distinguishes it from Flash-Next and requires its Q6_K_XL and F16 projector
in the same engine. It does not look for a PLE, list the projector as a model
or offer other 27B quantizations as already qualified. The loader separately
owns the server and reuses weights when the configuration matches.

- Startup/publication depend on the private receipt from the owned process,
  not the port or log text. The decoder rejects hidden NULs in identities;
  fork-only children cannot retain the channel after a host crash.
  Failed/cancelled startup or changed files do not publish stale state.
- 27B uses RAM, power 100, without expert SSD, DSpark or hotlist. The UI preserves
  other models' preferences; explicitly incompatible HTTP requests are rejected
  before stopping the active model. Disk KV is separate.
- Max uses q36's native **96k** threshold, not 384k. Confirmation is bound to
  the original model/context; it cannot modify a later selection.
  Leaving Max restores only the same model's context. Learn uses its own
  temporary configuration, preserving the normal Chat configuration.
- The installer links the shared store without copying weights; its source
  fingerprint does not treat `gguf` as code. Engine setup and 27B downloads
  are now also available in Settings; the CLI remains available.

Completed checks, with distinct scope:

- `q36-host-live/run-hcsKI3`: **8/8 PASS**, real Metal model, three API answers
  plus one submitted through the WebKit UI, exact output on screen and in
  persistent history, PID reuse and Stop. Context 8,192, Q6_K_XL, projector/F16 KV,
  native quality enabled, prefill 128, disk KV capped at 256 MiB, no expert SSD.
  Screenshots opened and verified. This is not the installed `.app` window
  or a speed benchmark or new quality campaign.
- `q36-host/run-8t52FS`: **12/12 PASS** with a simulated peer; the same entire
  sequence passes with an ASan/UBSan host in `run-6K7tRF`, with no sanitizer
  diagnostics. Readiness parser **63/63**. Legacy launch-control **11/11**
  (`http-2YRoOt`) and preflight **28/28** pass.
- Catalog/settings/requests: **15/15** (`qwen27-model-ui/run-zzQctk`).
  Selector and Max with real UI/simulated engine: Chromium `run-h8UfGX`, WebKit
  `run-sFs8vX`, light/dark and 96k/256k checks. Legacy DeepSeek Max verified
  in both browsers. No quality comparison between models.
- `agent-native-build/run-MXzu2k`: four native bases rebuilt, real tools and
  structured corpus normal/ASan/UBSan PASS with the updated decoder;
  simulated LLM responses. Installer **13/13**, session UI capability **40/40**.

The RED results for both host bugs and initial tests remain in the artifacts.
The first UI checks confused an option's `disabled` state with the select's
and attempted Done after the context change closed the dialog; fixed by using
the actual DOM state and the intended transition, without extending timeouts
or removing requirements. The first session-menu harness did not load the new
27B helper: it now executes both production selectors.

**Still missing at this point:** real Agent/Cowork qualification on the resident
server, image/PDF observations, durable tool history and complete Learn,
quality, desktop/backend qualification and the other P0–P11 gates. The earlier
**11/12 remains FAIL**. The installed bundle remains the September 8, 14:01 build:
no rebuild/installation/restart of the user's `.app` or push in this tranche.
Ignored operational checkpoint: `qwen27-ui.vGl69n/CHECKPOINT.md`.

## Previous resumption — September 8, 2026

The user resumed Qwen3.8 first, then the full local plan. The stopping point
below remains **historical**, not the current implementation status.
The app was rebuilt and verified as a package without starting models;
this does not automatically update an already installed engine.

At this point, the local installation candidate is `82d0314`; the old user
checkout still needs updating. The candidate's real replay has Agent PASS and
Cowork FAIL after reset: a different tool from the one requested, followed by
an action announced but not executed. The 2/2 in the historical tranche
belongs to `66b0e3f` and does not qualify the candidate. Upstream has advanced
further to `b85a6174da6d0ea3139b48194a2ca108097657b1`: the prefill delta
was analyzed and compiled in isolation, without promoting it in the launcher.
The first replay of this candidate (`qwen38-host-live/run-8zpOrR`) retains
a Cowork cancellation timeout and a source mutation during tester bootstrap:
the required vision patch had not been prepared before inputs were frozen.

Agent/Cowork patch **92** now uses
[native preparation of a candidate session](../patch/ds4-qwen38-prepare/README.md).
Replay `qwen38-host-live/run-xdrRmf` finished with **2/2 PASS**:
Agent and Cowork, cancelled reset without losing the conversation, full reset,
tools and files reread. It keeps the same oracles and 15-second Stop limit;
complete patch preparation precedes input capture.
The old tool-selection error at `82d0314` remains recorded:
one successful replay alone does not establish its cause or a general solution.
Native check `qwen38-prepare-live/run-8t4x4R` passes eight checks,
including logits and state byte-identical to normal synchronization over 8,193
tokens and eight subsequent decodes. These are targeted regressions, not general quality.

Learn is receiving family-specific thinking/context, requests bound to the
original selection and cancellation checks. The targeted regressions execute
real functions and UI with simulated engine responses; the real-model quality
campaign remains open. At this point, Qwen27B and the required vision paths
are not yet integrated. No new quality score or speed benchmark is claimed
as a result of these fixes.

### History — 27B engine supervision, September 8, 23:13

q36 patch `467020d6…` introduces the private channel through which DStudio
will be able to own the resident server separately. The server checks the
channel before loading weights and reports `ready` only when the engine,
session and port are actually ready. The receipt identifies PID, context,
backend, KV formats and the model/projector/MTP files actually opened, even
if the path has since been replaced. The host will need to compare it with
the still-valid request: a log line or external process is not equivalent confirmation.

If the owner disappears, the server requests normal shutdown and caps
unresponsive preparation/shutdown at three seconds. It does not signal unrelated
processes or claim that already executed effects were undone. Standalone startup,
without the new internal parameter, preserves the previous behavior.

- `q36-owner/run-x4c3OQ`: **52/52 PASS**, 24 scenarios with real processes/sockets
  repeated normally and with ASan/UBSan, plus four checks on the real server.
  Engine states are fixtures: these are not 52 model questions. Includes owner
  SIGKILL before/after readiness, deliberately blocked loading, a full channel,
  invalid descriptors and identities of replaced files.
- `q36-metal-runtime/run-6GePLX`: **36/36 phases PASS**, patch apply/repeat/
  restore/drift/partial, clean Metal build, previous regressions and comparison
  of the real projector. Sources and support files frozen throughout the run.
- `q36-owner-live/run-cBaWGZ`: **5/5 PASS with real 27B Q6 on Metal**. Private
  receipt, HTTP catalog, two exact text answers and loss of the owner channel;
  the process exits with code zero and releases the port. Context 8,192,
  verified F16 projector, no expert streaming or disk KV. These are targeted
  regressions: the earlier quality result **11/12 remains FAIL**.
- Installer: `make test-q36-install`, **12/12 PASS** with test filesystems/
  processes. This does not replace a fresh network installation at this revision.

Initial tester preparation errors (`run-NBpE8u`, `run-sZCOZi`) and full-channel
checks that did not actually saturate it (`run-8wEbFw`, `run-z1vivx`) remain
in the artifacts. The saturated case now uses two native sockets not read by
Node: no deadline or assertion was relaxed.

**Still to do at this point:** connect the server receipt and PID/lease to the
DStudio launcher, reuse weights across Chat/Agent/Cowork/Learn, integrate the
27B catalog, images and durable history, then verify modes with the real model.
None of this progress already enables 27B in the selector.
App still the 14:01 build, not replaced/restarted; no new download or push.
The full P0–P11 plan remained active at this historical point, not completed by these tests.

### Structured tools — September 8, 22:31

[Agent patch 95](../patch/ds4-agent-jsonl/README.md) adds an explicit path
for structured tool calls to the existing DStudio runtime.
It does not use q36's Agent or translate Qwen text into DSML. The native process
executes tools, preserves original IDs and returns results to the model;
Cowork keeps Office tools without an arbitrary shell. The existing DSML
path remains available and verified. **At this point, 27B is not yet selectable
in the app:** connection to its resident server and modes is missing.

Call/result groups are compacted as whole units; admitted IDs remain recorded
until reset to prevent replay. Stop preserves previous effects, interrupts
the current shell job and does not execute the rest of the sequence. Model
text, incomplete JSON and invalid parameters do not become actions. Protection
against fake JSONL events preserves the original bytes in history.

Reproduced fixes: the Laguna schema accepted nonexistent search modes;
a different transport ID bypassed the identical-call check;
an error followed by `WAITING` could become success in Task Graph;
single invocations exited with code zero even after error/Stop.
The outcome is now consistent across task, node, receipt and journal recovery.

Targeted checks, **not LLM quality**:

- `agent-native-build/run-8Xg54L`: four Metal bases main/Laguna/Qwen3.8/Qwen3.6,
  Agent/Cowork/Design built and real tools; **33 scenarios** for the new
  path repeated normally and with ASan/UBSan on each base: **264/264
  executions PASS**. Models are simulated; upstream core/GPU not instrumented.
- The same run checks limits and lifetime directly in the native adapter,
  with 5,196 checks per base, layout reports and a microbenchmark labeled
  as model-free. This is not an inference speed comparison.
- `agent-patch-migration/run-F1FDrj`: five bases PASS, including application,
  repeat application, Git reversal, drift rejection and preservation of other changes.
  Historical oracle hashes were not changed to obtain the PASS.
- Task Graph: 2,556 checks and HTTP gate PASS; new error/idle test also
  with ASan/UBSan, a persistent receipt and actual journal recovery.
- Transport: ingress 18/18, stream 61/61 and two host paths 63/63 each,
  lifecycle 6/6, Stop 36/36 and UTF-8 PASS, all without real inference.

Original failures remain in `run-ez1vcd`, `run-yjlZod`, `run-sFWnE1`,
`run-9HSbvg`, `run-OWtSys` and `run-TqaBYf`. The initial Cowork comparison
requiring an added newline was a grader error: the native writer preserves
content byte for byte; the corrected assertion requires that same identity
from both writers, without deleting the failed receipt.

Next work at this point: separate lifecycle/PID/lease for the 27B server, mode
routing and image observations, durable recovery of remote history and quality
with real weights. The current watchdog still compares serialized payloads:
this tranche tests differing IDs, not general equivalence across every possible
argument format. Profiling control responsiveness under pressure and the
multihardware matrix remain open. These tests cause no `.app` rebuild, startup
or push; the 14:01 binary reported below remains installed.

### Qwen27B installation and computation — history, not yet a model in the app

Latest rebuild requested for Qwen tests: binary rebuilt at
**14:01:10 CEST on September 8**, bundle installed and verified at
**14:02:19** in both usual locations. Private receipt
`qwen-app-rebuild.diofB9/BUILD-RECEIPT.md`, executable `ca5b916f…`, included
q36 patch `c392ca1a…`. Forced build, isolated bundle smoke, signature, metadata
and targeted Qwen startup/session checks passed. Previous copies retained;
no user app start or restart, model loading or update of already installed
engines. Qwen3.6-35B-A3B and Qwen3.8-Flash-Next remain selectable;
at this point, 27B is not yet integrated into the selector. This packaging
check is not a new qualification of model quality.

The previous rebuild produced the **September 8, 13:32:24 CEST** bundle,
installed and verified at **13:33** in both usual locations.
Private receipt `qwen-app-rebuild.63WPzx/BUILD-RECEIPT.md`, executable
`e39e40ee…`, included q36 patch `4c43f699…`. Forced build, bundle smoke,
signature, metadata and targeted Qwen checks all passed. Replaced copies
are retained; no app or model startup, installed engine update or 27B enablement.
Qwen3.6-35B-A3B and Qwen3.8-Flash-Next remain selectable;
this is not a new inference qualification.

The previous `.app` was rebuilt at 12:47:14 CEST on September 8
and installed and verified at 12:49 in both usual locations.
Private receipt `qwen-app-rebuild.RHX0X1/BUILD-RECEIPT.md`; executable
`f78960f5…`. The previous 12:02 build (`b1f855ab…`) is retained in
`qwen-app-rebuild.cacLYD`, along with backups of the replaced copies.
Forced build, package smoke, macOS signature, binary metadata and targeted
Qwen checks passed, without inference or opening the window.
Includes checkout repair while retaining the original Chat/Learn request
parameters: 12 readiness, 16 binding and 9 checkout tests passed.
RED results remain `chat-checkout-readiness/run-fxO0zg` and `run-Y6tBQt`.
The bundle includes sources and patches available at rebuild time, including
the q36 `4653d679…` tranche, but does not update already installed engines or
enable 27B in the app. Earlier copies from 10:05
(`qwen-app-rebuild.lcS8Ym`, `4144f205…`) and 10:51
(`qwen-app-rebuild.k9jeW8`, `1e38f152…`) are also retained. The user app was
not opened or restarted; no model was loaded or stopped. This rebuild does
not qualify new inference or include experimental changes left in ignored
test checkouts.

The downloader now pins the HF revision, size and SHA-256; it resumes private
downloads, has a single writer and publishes without overwriting user files.
The **25,299,061,664-byte** Q6_K_XL was downloaded and verified, in addition to
the already verified F16 projector. The native CLI `--install-engine q36`
downloads pin `d67687ed…`, applies the patch, rebuilds and verifies the
installation before publication. Model-free checks: downloader **21/21**,
installer **12/12**. The new real installation `engine-acceptance/run-49XS30`
passes download, build and binary startup; this is not mistaken for a model answer.

The first real inference `engine-acceptance/run-AFZhdJ` fails **11/12**
checks with corrupted text; only invalid-request rejection passes.
The catalog also reports the wrong name. CPU/Metal diagnosis in
`qwen27-numerics.5si6Od` reproduces nonfinite CPU data and divergent
trajectories; kernels on individual Q4/Q5/Q6 rows pass.

Two causes reproduced and fixed in the `.patch`: CPU FFN reused the input
representation after a weight-format change; three Metal operations used
35B dimensions for 27B as well. Initial regressions retain **30/75** CPU
composition errors and **21** Metal errors involving layout, overflow and
buffer integrity. After the fix, they pass without changing the oracles:
`q36-metal-runtime/run-jMFlvY`, **21 phases**, including 75 CPU ASan/UBSan
cases, real HTTP serialization and the F16 projector. Numerical replay
`qwen27-numerics.5si6Od/parity-after.log` passes three prompts/nine CPU/Metal
decode steps and twelve checks on real quantized rows. This is not an
independent architectural reference or the P6 campaign of at least 100 cases.

The answer repeat `engine-acceptance/run-aJmoWY` passes **11/12**:
the Python answer remains wrong, `10` instead of `16`. Replays cold and after
other requests (`run-yOjMQq`, 11/13) yield the same error. Diagnosis
`q36-request-parity/run-wtdYbQ` runs the original HTTP parser, then CPU and Metal:
same tokens and numerical agreement within the original limits, but **both
answer incorrectly**. The test remains FAIL; agreement is not declared quality.

For the 27B candidate, the [q36 Metal patch](../patch/q36-metal-runtime/README.md)
fixes MRoPE linking and implements projector matmul/attention in Metal.
The upstream helper's name was misleading: the shared runtime already included
Metal; spans were not prohibited by definition. The first full-model test
(`q36-vision-session/run-QQLVls`) retains a grader false negative: the prompt
allows a space after the comma. Correction with **28** regressions, separate
regrading receipt `q36-vision-session-regrade/run-mfAjdw` and new inference
`q36-vision-session/run-tLBw0g`, **8/8 PASS**. All cases and the original FAIL
remain: requirements for color, order, added explanations, invalid UTF-8,
nonfinite values and incomplete generations were not relaxed.

### Cancellation before startup — core fix, September 8

An already cancelled request reset checkpoints and cache before checking
cancellation. Reproduced with the real model in all four text/image
combinations (`q36-vision-session/run-Sf3DkD`), plus 20 failed assertions
across 24 deterministic scenarios (`q36-cancel-admission/run-eixygn`).
The check now precedes reset and acceptance of an already cached prompt,
in a versioned `runtime.patch` change, without altering computation.

New network installation in `qwen27-cancellation.jDoZoT/fresh install/q36`,
with pin `d67687ed…` rechecked and patch `61843ae6…`. Gate
`q36-metal-runtime/run-o5XhJV` passes **22 phases**, including 24 admission
scenarios with ASan/UBSan. Real replay `q36-vision-session/run-gfJtza` preserves
tokens, position, visual state and all logits in the **four cancellations**;
the **8/8 answers** remain correct. That tranche did not replace the user's `.app`.

This fix covers requests cancelled **before** work. The following HTTP tranche
extends the image path with a private session; lifecycle, four modes and full
application cancellation still need implementation at this point.
That gate neither enables 27B nor promises complete rollback.

### HTTP images and connections — September 8, before the 10:05 rebuild

The q36 server now receives PNG/JPEG as real bytes in OpenAI Chat, preserves
text/image order and calls native decoders/projectors/spans. It prepares
a private session for images and for returning from vision to text, without
duplicating weights. Errors and stale requests do not replace the previous
session; text-only caches are not reused for pixels.

The first retained parser gate (`q36-http-vision/run-ys7psO`) had four errors
out of five: images lost or incompatible inputs accepted. The subsequent
real-model HTTP run `q36-http-vision-live/run-rqYyfG` passes 13/13 targeted checks.
Extending connection checks exposed a separate defect: macOS reports hangup
even when the client has finished sending but is still waiting for the response.
The candidate interpreted this as cancellation.

RED results retained: `q36-http-vision/run-Y4vEw1` and `run-WJYuHa`, 44/45;
`q36-http-vision-live/run-rCNL7p`, **14/16** on the real model. The tester now
also detects early worker exit, without waiting for a barrier that will never
be reached. The error remains reproduced over real TCP, not only local sockets.
The `.patch` distinguishes error/reset from closure of only the sending half.

New network installation `qwen27-http-halfclose.aNqNx7/q36`, still
`d67687ed…`; patch **5904134e…**, server **750771ac…**. Complete gate
`q36-metal-runtime/run-ySicfJ`: **23 phases PASS**, including 45 native HTTP
checks with ASan/UBSan and nine ownership scenarios with a simulated worker.
Real replay `q36-http-vision-live/run-wRCPws`: **16/16 PASS**, identical inputs
and oracle: colors, two-image order, decoder failure, return to text, JSON and
SSE, including the previously failing connections. Both replay servers have
terminated; no user process stopped or new weights downloaded.

Limits still open at this point: Stop by request ID and DStudio wiring, generic
text preservation during interrupted prefill, admission-pressure qualification,
persistent cache and all 27B modes. FIN alone does not prove the client has
stopped reading. The single-session image server does not enable images for
Anthropic/Responses or batches: those combinations are rejected. The small
color checks do not replace 100 questions, 30 PDFs and 20 held-out images,
or testing of the `.app` or other backends.

The previous gate `q36-metal-runtime/run-ZOk4i9` passes 17 phases: patch/restore,
drift/partial/symlink, real build, operators against independent calculations
and two RGB images with the **real F16 projector** against the native scalar
encoder. Only that component (927.6 MB) was downloaded in that tranche, with
revision/hash verified and license recorded. Failed trigonometry and patch
application attempts remain in the original receipts.

Next requirements at this point: correct and qualified real inference, app
catalog/lifecycle, connection of native image transport to DStudio modes,
session/cancellation, tools and four modes, then numerical/answer quality and
the real app. Qwen27B is not yet selectable; checks on a few colors do not
establish general visual quality or CUDA/Vulkan parity.
The P0–P11 plan remains open.

### Native Stop for the 27B candidate — September 8, after the 10:05 rebuild

The engine now recognizes a unique attempt ID before receiving the entire
request. Stop can interrupt an upload or remove a turn from the queue without
waiting for the running turn; cancellation does not affect other IDs.
There are still 16 slots for heavy requests and four bounded control threads.
The receipt distinguishes “cancellation requested” from “request finished”:
an absent ID is not presented as successful cancellation.

Another regression allowed a turn ending in error to still expose a complete
tool call. Failed text now remains in the response but does not become an
executable call. RED results retained: `q36-http-control/run-6fs9Dp`
(0/3), `run-zrVSbM` (header error during implementation) and `run-4ZFZSg`
(8/9, tool after error). Final gate `run-Boknx2` passes 9/9 scenarios, 103 assertions.

Network installation into an empty directory: `qwen27-http-control.KX03QB/q36`,
still at pin `d67687ed…`, patch **586c4f5b…**, server **9358a1d5…**. Complete Metal
gate `q36-metal-runtime/run-eb8vLH`: **24 phases PASS**, including 47 HTTP/parser
and private-publication checks, cancellation controls, build, patch and projector.

With real 27B weights, the new targeted corpus retains the RED **19/21**
`q36-http-vision-live/run-VltcsY` and passes **21/21** in `run-g7fUZ8` after the fix:
same requests, settings and verified weights; only new attempt IDs and the
server revision change. Cancellation during preparation of eight images
returns an interruption error without completing generation, and the next
text question is answered correctly. Both tester servers terminated normally.
No new weights downloaded, user engine stopped, push or further change to
the delivered app.

Status checks during four real preparations responded in 2.1–3.6 ms in this
run; this is not a throughput benchmark or a p99. The optional profiling probe
records mutex wait/hold times separately and layout with 1/8/16 active fixtures,
without inference. Timer resolution does not allow zero ticks to be interpreted
as zero cost.

**Next required work at this point:** generally transactional text prefill,
Stop connected to the DStudio lifecycle and handling of late responses; then
catalog, local Agent/Cowork/Learn adapter and vision/PDF across modes.
q36 snapshots in memory contain only tokens and reconstruct prefill:
do not use them as evidence of KV/GDN copying or byte-identical rollback.
Broad quality, independent numerical checks, pressure and other backends remain open.
27B is not yet selectable, and this progress does not close the plan.

### Native text preparation and cache restoration — September 8, after the 12:02 rebuild

The app delivered in `qwen-app-rebuild.cacLYD` remains unchanged. New patch
`4653d679…` was installed from the network only in test directory
`qwen27-payload-prepare.S05oAQ/q36`, at pin `d67687ed…` rechecked against the remote.
Server `16ac1e4c…`; no further weights downloaded, user engine stopped or push.

Native text preparation preserves KV/GDN/logits by copying active state
without changing precision, context or prefill boundaries. The new payload
restore loads into a private session: truncated cache or cancellation does
not destroy the previous one. Reads check Stop between blocks of at most
64 KiB and after the final byte; allocation/configuration errors are returned
without replacement. Old token-only snapshots still reconstruct prefill:
they are not presented as a complete KV copy.

Retained and new checks:

- Direct-restore baseline `q36-payload-prepare/run-AFtq5Q`: 10,585 failed
  assertions in the corpus's first revision. No receipt rewritten.
- Current gate `q36-metal-runtime/run-7P1jrx`: **28 phases PASS**, patch
  apply/repeat/restore/drift, real Metal build, operators and F16 projector.
- CPU payload ASan/UBSan `run-Tx5GOH`: **9,745 scenarios / 48,504 assertions PASS**;
  text `q36-text-prepare-unit/run-gfdu33`: **1,926 scenarios / 4,014 assertions PASS**.
  These are initialized states, not model answers or MTP numerical parity.
- Real model, extended corpus: baseline `q36-text-prepare/run-ZEWZsd`
  **2/13**, new preparation `run-MYoJb3` **13/13**. After each of the thirteen
  cases, including cancellations, four decodes preserve the same complete
  state and finite logits as the native reference. The payload FILEs are
  in memory: no SSD speed benchmark is inferred.
- Real image HTTP on the new installation: `run-8QWeCd`, **21/21**;
  this is not equivalent to testing generic text HTTP prefill.

**Not yet done at this point:** generic HTTP cache loading does not yet consume
the new private API. It must be migrated together with complete prefill, without
losing sampled BPE prefixes, cold/continued checkpoints or tool replay and
without I/O under cache/tool locks. DStudio lifecycle Stop, catalog and 27B
modes follow. The 11/12 language FAIL, broad quality, desktop checks and other
backends remain open; the P0–P11 plan is not complete.

### Tool recovery in the HTTP worker — September 8, after the 12:47 rebuild

The `.app` delivered in `qwen-app-rebuild.RHX0X1` remains unchanged, as do
the user's installed engines. New native patch `4c43f699…` is tested in a
separate network installation: `qwen27-http-replay.kNhpDS/q36`, pin
`d67687ed…`, server `543cb290…`. It does not enable 27B in the selector.

The HTTP client no longer consults the worker's tool cache. Recovery occurs
in the session owner, using the same parser for the received API format
and the same captured parameters. Context is checked against the resolved
prompt, not a preliminary reconstruction that may contain different tokens.
In the single-session path, cache/tool I/O and tracing no longer hold those
shared locks; hot structures do not grow. The batched path retains
synchronization debt and does not receive the same qualification.

- HTTP/control ASan/UBSan: baseline **9/16** (`run-9nv6Ad`), candidate
  **16/16** (`run-YersA0`). Real sockets/parsers with simulated workers/tokenizers,
  not sixteen model answers. The intermediate RED for tracing under a lock
  is retained (`run-dia8n7`, 15/16).
- Complete gate `q36-metal-runtime/run-rrgf3z`: **28 phases PASS**, including
  Metal build, real operators/projector and patch lifecycle. Installer fixtures
  **12/12**, upstream checker `run-rfM0gF` **48/48**, not release admission.
- Real 27B model: first OpenAI extension **24/24** (`run-j4TKTA`), then
  **28/28** (`run-TeqqR4`). The model generates a `read_file` call, and the test
  reads real files and changes the supplied result. All three API formats
  return the exact code, including capitalization; the trace confirms tool
  recovery from RAM. All 21 previous image, error, SSE and cancellation cases
  remain. Logs are private and bounded, not benchmarks.

These are native server tests, **not tests of the DStudio Agent/Cowork loop**.
Private preparation of the entire HTTP prefill/cache, cold/continued checkpoints,
cancellation and disk tool-scan limits, application lifecycle and 27B modes
remain. The full plan was still active and incomplete at this historical point,
including the 11/12 language FAIL and desktop/other-backend qualification.

### Private HTTP text and cache — September 8, verification after the 14:01 rebuild

The just-delivered copy (`qwen-app-rebuild.diofB9`, executable `ca5b916f…`)
is not modified or restarted. The 27B candidate remains separate from the app:
network installation `qwen27-http-transaction.mSaZzr/q36`, patch `c392ca1a…`,
pin `d67687ed…`, server `c70cc99f…`. No update to user engines.

A failed or cancelled text request now preserves the previous session and
its published checkpoints. The worker privately prepares cache and the full
prompt, then checks identity, context and cancellation before replacing the
session. Token/BPE prefixes and precision remain native, without hidden prefix
recomputation to create caches. Temporary files have count/byte limits and
are removed on failure; an exhausted budget means less cache, not less
context or a different answer. Failed rename does not report a successful save.
The cache does not promise resilience to power loss: it is not an authoritative
journal and preserves upstream's lack of fsync.

- Complete gate `run-32JrVf`: **29 phases PASS**, real patch lifecycle and Metal build.
  Text preparation **2,070** cases, payload **9,757** with sanitizers;
  writes checked at most every 64 KiB and recoverable token reservation.
- HTTP transactions with a simulated worker: old server **3/24** (`run-xrAbiU`),
  candidate **24/24** (`run-u8wJ2F`). Intermediate **23/24** (`run-BOrIUG`)
  retains the disk-budget bug: a single tool block in RAM can be written
  multiple times, and the limit must count every serialized copy.
- Real 27B/Metal: **13/13** (`q36-text-prepare/run-ZPQJ3L`) after native
  changes; byte-identical state/finite logits and four decodes after every case.
- HTTP/cache: **34/34** (`run-0Zm67V`), including all 28 previous checks
  and Stop after a real private checkpoint. Names, sizes and SHA-256 of
  already published files remain identical; control within 1 s and Stop within 15 s.
  Initial **32/33** (`run-lNVzga`) is not deleted: the last test required
  a RAM hit impossible with that history, which omits empty thinking.
  A new turn without Stop demonstrates the same native choice; after Stop,
  all eight frontier/cache fields and the exact answer must match.
- The previous engine, with the identical final harness, passes **31/34**
  (`run-Yu1RjC`): an actually submitted Stop takes 34.65 s and leaves eleven
  checkpoints instead of the previous five. In the candidate, Stop takes 1.24 s,
  and the five files remain identical. These are individual diagnostic checks,
  not a benchmark. Initial comparison receipts remain: `run-yFScLN` had not
  submitted Stop because it awaited a private phase absent from the old build.

These are runtime regressions, not a speed benchmark or general quality.
The next integration must connect q36 to host selection, lifecycle and Stop,
reusing DStudio's loop and tools through local transport, not `q36-agent`.
The private tool-ID probe passes only **2/6** on both the clean upstream pin
and the candidate: modified names and arguments can be replaced by the cached
block. It executes no tools; it demonstrates a history-rendering defect,
still open at the end of that tranche; the subsequent fix is below.
Call sequences, disk scans and batched paths also remain to be qualified.
At this point, 27B is not yet in the selector; the 11/12 language FAIL,
Learn/Cowork/Agent, vision/PDF, desktop, other backends and P0–P11 acceptance remain open.

### Tool-ID fix — September 8, after transaction verification

The cache can no longer change the received file, tool or arguments merely
because it recognizes an ID. Call types, count and order are also checked;
JSON object field order may change without losing the original text.
Preparation occurs outside the mutex, and a prepared result is not applied
if the mapping has changed in the meantime.

- Reproducible patch `6b7f295b…`, q36 base `d67687ed…`.
  Separate network installation `qwen27-tool-identity-final.tsfrhX/q36`;
  server `61014765…`. The previously delivered `.app` `ca5b916f…` remains unchanged.
- **93/93 regressions PASS** (`q36-tool-replay-identity/run-UzuU0g`) with
  sanitizers, compared with the previous **22/93** (`run-7gypfj`), on the same
  corpus. Disk maps actually written/reread, modified arguments, groups,
  limits, overlapping preparations and replaced/evicted mappings. These
  93 checks execute neither models nor tools.
- **30 phases PASS** in the complete gate (`q36-metal-runtime/run-IKF6tM`),
  with patch lifecycle, Metal build, operators/projector and native/HTTP suites.
- **34/34 PASS with real 27B** (`q36-http-vision-live/run-aLM8rI`): images,
  tool results in all three API formats, checkpoints and cancellation. This is
  a development replay, not general quality, numerical equivalence or desktop Agent.
- Layout and native cache reader measured, with instrumentation only in the probe.
  The ID entry grows by 8 bytes; increasing the configured limit does not
  allocate every entry. Private profile, not decoding figures or a public benchmark.

Next items at this point: recoverable parser/cache allocations, a disk format
with group positions, cancellable scans and batched writers outside locks.
Old single-call v1 maps are supported; for groups without positional identity,
received content is preserved without claiming exact recovery.
q36 host lifecycle/Stop, a local DStudio loop adapter, Learn and PDF follow.
27B remains **unavailable for selection in the app**; the 11/12 language FAIL
and the rest of P0–P11 are not closed. Models, settings and user app preserved;
no push or restart during this tranche.

### Tool groups on disk — September 8, subsequent verification

Disk map v2 now preserves sampled text, every ID and each call's position
together. It can be recovered even after clearing RAM; a disk ID cannot replace
a current mapping. Truncated files or files with duplicate IDs are fully
validated before import. Updating an existing file prepares a private copy
and preserves the original on failure, cancellation or encountering data
that has changed in the meantime.

- Patch `2ea07d80…`, still on q36 `d67687ed…`, installed from the network in
  `qwen27-tool-map-final.kTOaoN/q36`; server `586bf7c1…`. No new weights.
- **84/84 native checks PASS** (`q36-tool-map/run-6CnyhY`), with ASan/UBSan:
  real round trips, all 247 fixture truncation points, limits,
  failed allocations, concurrent/stale publications and blocked writes.
  The initial common corpus had
  **19 failures out of 36** on the previous revision; receipts retained.
- **31 phases PASS** in the complete gate (`q36-metal-runtime/run-zREUQa`),
  including **93/93** semantic regressions (`run-LIBRjR`), real build, patches and GPU.
- **34/34 PASS with real 27B** (`q36-http-vision-live/run-cfxg9H`): same
  weights, ctx 8,192, F16 KV, prefill 128, four threads, greedy, thinking Off,
  no expert streaming, 4 GiB disk cache. Stop takes 1.39 s in this single check,
  with five previous checkpoints byte-identical. Test process terminated.
  This is not general quality or an Agent workflow inside DStudio.
- Tool-cache preparation/insertion/serialization occurs outside `tool_mu`;
  publication and ID copies are bounded. Index tables require a fixed 256 KiB
  when the cache is initialized; entries and text remain proportional to
  retained data. Failed admission does not preemptively delete old entries.
- Private before/after profile: time under `tool_mu` no longer grows with
  text, but total preparation time does. No promise of faster decoding.
  The budget test reads the format actually written and preserves the error
  at one byte below the required size; 24/24 both before and after, with the
  old oracle failure on RAM size retained.

The batched disk-catalog path (`kv_mu` and the outer `inference_mu` mutex),
distinct from `tool_mu`, still needs fixing, along with full scans and
parser allocations.
Lifecycle/Stop and native transport for the DStudio Agent/Cowork loop,
Chat/Learn/PDF and all other plan acceptance criteria follow. At this point,
27B remains **unavailable for selection in the app**, with the previous 11/12
language FAIL open. Both delivered `.app` copies retain hash `ca5b916f…`;
no rebuild, restart, push or settings change in this tranche.

### GPU serialization and batched blocking — September 8, still in progress

The blocking is now reproduced by a permanent test: while one session saves
cache, the outer mutex prevents another from decoding. This is not a context
capacity problem or a new model error.

- Implemented in the `.patch`: the native API for yielding the GPU between
  reads of at most 64 KiB, before waiting on disk. The session remains immutable;
  cancellation and failed reads always release already acquired access.
  Checkpoint format, precision and bytes do not change. No full KV duplicate
  in RAM; the temporary descriptor grows by only 8 bytes.
- **82/82 PASS** on real Metal buffers (`q36-payload-schedule/run-TihkbA`),
  without loading weights: bytes against a separate oracle, formats/precisions,
  limits/cancellation and GPU operation while output is blocked.
  The last check uses a scheduler fixture, **not the server**.
- **Complete gate FAIL, 32/33 phases**, `q36-metal-runtime/run-MvD4ha`.
  New mandatory acceptance `q36-cache-owner/run-XMMYx1` fails because the
  server does not yet use this separation. Other checks, including
  patch/build, operators and tool regressions, retain their PASS results.
- Patch at this point `20632cf636cea31642e4e5e2159eb81bba820b8bb41cb5ba62a9d67c20ece4ca`,
  still on `d67687ed…`; no new model installation or LLM inference
  in this tranche. The previous real 34/34 replay remains associated with
  `2ea07d80…`; it is not attributed to the new hash.

The next step at that time was server catalog and scheduling work, including
restore and prefill checkpoints, then concurrency verification with the real
model. Removing the mutex is insufficient: Metal/Vulkan share a command context.
No Vulkan/CUDA qualification is inferred. The delivered `.app` remains
`ca5b916f…`, not rebuilt or restarted, and 27B remains unavailable for selection.
The full plan remains open; at that historical point, this checkpoint was neither
a requested pause nor P3 closure.

### Private cache restoration — September 8, after the failed gate

Engine blocking during save/restore fixed: the server yields the GPU between
bounded transfers and holds no shared locks while reading or writing files.
Restore prepares a separate session; corruption, cancellation or stale results
preserve the previous one. Prefill checkpoints keep exact frontiers.
No change to context, precision or KV format.

- Patch `8079006f…`, still on `d67687ed…`, exported in full.
- **33/33 PASS**: `q36-metal-runtime/run-A7Xzt1`, including the previously
  failing acceptance. **138/138** on real Metal buffers (`run-oydDe3`), without
  weights; **7/7** on real scheduler/files with simulated numerics (`run-4yf4iO`).
- The same four read checks fail on previous patch
  `af87743f…` (`q36-cache-owner/run-hrSJgq`). The old 32/33 gate
  (`q36-metal-runtime/run-V6Efpq`) remains retained as a failure.
- New network installation `qwen27-cache-restore.84nAwX/q36`, without model
  downloads; server `2820c6e2…`, matching the clean build.
  Delivered app unchanged `ca5b916f…`, no restart or push.
- Real 27B checks are separate from fixtures and retain their own outcomes.
  Atomic handling of all batched prefill, parser/scans, profiling and
  multibackend qualification remain open. The Vulkan allocator still contains
  driver work under a lock, identified in the source and awaiting a fix.

Details/commands in ignored receipt
`qwen27-cache-restore.84nAwX/CHECKPOINT.md`. At this point, 27B is not yet in
the selector, the 11/12 language result remains FAIL and P0–P11 is not complete.

Subsequent verification: initial real test `q36-batched-cache-live/run-h86Z5P`
remains **FAIL 8/10** (seven exact answers), with a tester threshold incompatible
with its own prompts and loss of the final checkpoint in the engine. The latter
defect is reproduced by the new shutdown case on patch `8079006f` (**7/8**).
Persistence now passes to the sole shutdown owner after joining workers/clients;
it does not use the already stopped scheduler or alter Stop for active jobs.

- Patch for that verification **`960b1505…`**, same upstream base; new installation
  `qwen27-cache-shutdown.dgTuVl/q36`, server **`3f3acf1a…`**.
- Native gate **33/33** (`run-uOcLI0`), Metal buffers **138/138** (`run-9e6Sy7`),
  scheduler/files with simulated numerics **8/8** (`run-QTxTht`).
- Real 27B **11/11** (`q36-batched-cache-live/run-5YYWki`): seven exact answers,
  disk cache actually restored after restart, final save verified and six
  previous files intact except for hit/last-use counters. Both test processes
  exited with code 0; user app unchanged.
- The two concurrent requests did not produce a two-element decode batch.
  A restore slowed by concurrent prefill (19.749 seconds) still needs
  profiling/fairness work. These are not measurements of superiority,
  held-out quality or proof of the four modes.

The operational checkpoint for that tranche is
`qwen27-cache-shutdown.dgTuVl/CHECKPOINT.md` in ignored artifacts.

### Batched prefill and Stop — September 8, subsequent verification

Private preparation now includes the entire batched prompt, KV restore/copy
and temporary caches. The previous session remains with its owner until
revalidated publication. Native GPU copies bounded to 64 KiB, without host/disk
snapshots for cloning and without changing format, precision or context.

- Patch **`1677e0f6…`**, same base; new installation
  `qwen27-batched-text.2Avqau/q36`, server **`fa508a5c…`**.
- **34/34** native gate (`run-sYymEs`), **186/186** Metal buffers,
  **24/24** single HTTP and **24/24** batched with simulated numerics, **8/8**
  scheduler/files. Old batched 4/24 retained, not replaced.
- **13/13** scheduled APIs with the real model (`q36-text-prepare/run-6XiThB`):
  byte-identical state/logits and four subsequent steps per case, including
  token-only payloads. Single-lease fixture, not a concurrent server.
- **15/15** real HTTP (`q36-batched-cache-live/run-nBAiqZ`): Stop during
  prefill, cache intact, previous 1,905-token frontier preserved and answer/
  cache decision matching the control without Stop. The same check fails
  **2/15** on the previous `960b1505` (`run-jCwuDn`): after Stop, it completes
  and publishes the cancelled prompt's 3,913 tokens.
- First candidate **12/13 FAIL** (`run-36aNCy`) retained: the tester required
  RAM, but Qwen normalizes thinking markers and selects disk even without Stop.
  Added control and restoration of the same frontier, tested on both versions
  without relaxing preservation, answer or HTTP-status requirements.
- All processes in these checks exited with code 0. User app
  `ca5b916f…` unchanged; no restart, push or new weights.

Historical checkpoint for this tranche:
`qwen27-batched-text.2Avqau/CHECKPOINT.md` in ignored artifacts. The next work
at that time was multisession numerical qualification and integrating 27B into
the DStudio lifecycle/modes. Parser/scans, fairness, backends, the 11/12 language
FAIL, broad quality and all other P0–P11 criteria remain open.

### Eight sessions — memory defect reproduced, September 8

The subsequent numerical check with real 27B (`q36-session-batch/run-yrtczD`)
fails both KV modes: the last four rows are corrupted in the batch of eight,
logit error reaches 9.62949 and one token choice differs. Earlier passing
HTTP checks did not cover this computation.

The core reuses QKV memory from subsequent sessions, not yet consumed, for Q/K.
Patch `aa26ffa9…` completes all convolutions first, then the deltas;
no session reduction, new buffer or relaxed threshold. The new Metal test
without model weights reproduces 24/96 failing cases on the previous version
(`run-6liaiS`) and passes 96/96, with 9,216 byte-identity assertions, on the fix
(`run-YwJ3PC`). Both 35B/27B structures, capacities 8/16 and fused/unfused/mixed
convolution paths are exercised with synthetic weights.

New isolated engine `qwen27-recurrent-batch.AbJrSq/q36`, server `c31774ec…`:
runtime gate **35/35 PASS** (`run-HLyNYz`) and real upstream test **PASS in
both KV modes** (`run-KstvbC`). All 30 rows at 1/2/4/8 satisfy the 0.25 limit:
maximum 0.00828552 F16, 0.214759 Q8/Q4, no differing argmax.
This is not bitwise numerical equivalence or general quality. HTTP follow-up
on the new binary **15/15 PASS** (`run-jkvwOI`): cache/Stop, previous frontier
and subsequent answer preserved. Both servers exit with code 0.
Operational checkpoint at this point: `qwen27-recurrent-batch.AbJrSq/CHECKPOINT.md`
in ignored artifacts. App unchanged; P3 and the rest of the plan remain open.

## Agent connection and Stop — September 8, work in progress

The transport prerequisite for Qwen27B now preserves structured calls without
converting them into DSML text: IDs and arguments remain exact, and an incomplete
result does not become an executable tool. Unicode, errors and end of stream
are verified by **60/60** HTTP/pipe tests, including ASan/UBSan. The model is
simulated: this is not a new measurement of answer quality.

Three Stop issues fixed: infinite waiting without further tokens, cancellation
inherited by the next turn and already queued bytes contaminating the new
prompt. **36/36** checks on the real reader and HTTP/Task Graph/watchdog inputs
pass, including ASan/UBSan. Tests on compiled runtimes use real local tools
and require a new turn in the same process. Failed tests and the corrected
grader for the Design line terminator are retained.
Complete native build of main/Laguna/Qwen3.8 **PASS**, receipt
`agent-native-build/run-pSEI6b`: real Agent/Cowork/Design, tools and Stop/resume
with simulated responses. This does not qualify a model or other backends.
Final repeat **27/27 PASS** across the nine binaries:
`runtime-model-interrupt/run-1U0YAr`, without restarting processes between Stop and the new turn.

Agent manifest **94**; changes to the first-party component are recorded
separately without changing historical migration hashes. Subsequent HTTP-worker
work is documented below; structured dispatch, transcript and a separately
resident server remain.
**At this point, Qwen27B is not yet selectable in the app.** The 11/12 language
baseline and other plan requirements do not become PASS because of these tests.

Operational checkpoint at this point: `model-rpc-sanitized.H78CmB/CHECKPOINT.md`
in ignored artifacts. Checkpoint `qwen27-recurrent-batch.AbJrSq` remains the
source of immutable engine and weight identities. App not rebuilt/restarted,
no push; this continuation of the plan is not a release.

### Late responses and cancellable connection — subsequent verification

Another real defect reproduced: after reusing the exact same descriptor,
**139 bytes of the old response** reached the new runtime, including the
completion signal. The worker now communicates only over private pipes.
The host checks identity and turn before forwarding data; Stop invalidates
delivery before interrupting the runtime. The regression receives **zero old
bytes** and also verifies process termination.

The transport admits one worker and one subsequent request while the previous
worker shuts down. It has a body limit, bounded delivery staging, monotonic
deadlines, nonblocking writes and asynchronous reaping. Credentials are captured
at admission; HTTPS uses curl without a shell, with temporary files already
unlinked from the filesystem before sensitive data is written. Tests also
close the real connection when its owning host dies.

Targeted outcomes, including ASan/UBSan: **61/61** on direct transport, **63/63**
on the host HTTP path, **63/63** on HTTPS and **6/6** lifecycle scenarios.
The **36/36** Stop tests now include a real pending HTTP connection and verify
that the worker is terminated. Models still simulated: no new quality score,
speed benchmark or qualification of other backends.

Task Graph (**2,555 checks** and HTTP gate), steering and window-component
compilation PASS. The `.app` was not linked or replaced. Large incoming
envelope handling on the control loop, desktop verification, Windows and
the profiling required by the plan remain to be completed, in addition to
27B integration and the other requirements already listed.

Operational receipt: `model-rpc-lifecycle.x1Vvem/CHECKPOINT.md` in ignored
artifacts. Initial failed checks and grader failures are retained;
no push, download or app restart in this tranche.

### Large incoming requests — preparation outside the host control path

Two more reproduced defects fixed: a `model_request` nested in event data
was executed as a command; a single read consumed the entire 512 KiB fixture
before returning control. RED receipts are retained in
`model-rpc-input/run-vJXv26`.

The host now recognizes only the native writer's canonical header, preserves
identity across fragments and transfers the body without reconstructing or
decoding it on the control loop. The worker validates Unicode, JSON and envelope
closure before contacting the model. Host staging 16 KiB, unread suffix 8 KiB,
private decoded body up to 16 MiB; stdout and stderr each yield control after
at most 64 KiB per pass. This is not a measurement of inference acceleration.

**16/16 ingress tests**, including ASan/UBSan (`model-rpc-input/run-BB5glZ`):
the peer compares a large native-client message byte for byte within its JSON
fields; Stop works with the worker deliberately blocked. Also covered:
a header started before Stop, invalid/truncated data, limits, no network
request for rejected input and terminal-response deadline on a full pipe.
The previous 63/63 HTTP, 63/63 HTTPS and 36/36 Stop checks were repeated
through the new ingress path, still with a simulated model. These are not
new Qwen quality results.

Complete normal repeat **16/16** in `model-rpc-input/run-fAgXR0`;
Task Graph **2,556** checks, preflight **28/28** and spawn **16/16** PASS.
Isolated native builds `agent-native-build/run-0pjwW5`: Agent/Cowork/Design
rebuilt on main, Laguna and Qwen3.8, with real tools and Stop/resume in the
same process. Responses are simulated; they do not qualify models or CUDA/ROCm GPUs.

Latest extension: **18/18**, normal `model-rpc-input/run-c5ToRd` and ASan/UBSan
`run-3L6ah7`. RED `run-swHLm7` (16/18) reproduced loss of the original error
when the worker rejected a body before sending finished.
The host now interrupts the upload but still reads the already produced
receipt; it does not replace it with a generic pipe error. The test uses a
real stopped/released worker and observes its exit without preempting owner reaping.
Also repeated after this fix: 61/61 direct, 63/63 HTTP, 63/63 HTTPS, 36/36
Stop and 6/6 lifecycle, normal and with sanitizers. Window host object rebuilt;
`.app` not linked or replaced.

The owner record grows from 24,776 to 41,192 bytes for ingress staging;
there is still one worker and at most one pending request. The owner retains
no copy of the large envelope. Other display events are capped at 4 MiB with
an explicit error, but hashing/publication of the full record still needs to
be moved or made incremental. Windows verification, the Windows Stop-control
allocation error and the P10 profile also remain.
Structured dispatch, indivisible tool groups in history and connecting the
separately owned q36 server to the DStudio loop follow.

At this point, 27B remains unavailable for selection and the 11/12 language FAIL remains open.
Installed app unchanged, no model started or downloaded, no push.
Operational checkpoint: `model-rpc-input.xVQVRv/CHECKPOINT.md` in ignored artifacts.

## Historical stopping point — September 7

The sections below preserve that September 7 checkpoint, including its pins,
commands and next steps. They are not the current installation matrix; use the
latest progress above and [current WIP status](WORK_IN_PROGRESS.md) for that.

**Qwen3.6/3.8 consolidation verified on September 7, 2026; pause requested.**
The instruction at that point was to stop here: other chapters must not start
automatically. This closes the tranche for the two already integrated models,
not full qualification of the family or plan.
This tranche defines the scope of the Qwen update requested for GitHub,
together with the README and shared loading/build dependencies.
Publication does not resume other plan chapters; the user's .app was
neither replaced nor restarted.

| Checkpoint | Status | Result / limit |
| --- | --- | --- |
| Q-01 — tools and startup | Verified on targeted paths | Chat and experimental Agent/Cowork; native tools, files created and reread, correct engine. This is not general quality. |
| Q-02 — new session | Verified in targeted replays | Agent and Cowork pass on both real models: native progress, cancellation with context preserved, full reset and reread. |
| Q-03 — disk checkpoints | Distinct capability | Qwen3.6 does not serialize complete recurrent state: checkpoints disabled, app history preserved. Qwen3.8 retains its own native format. |
| Q-04 — desktop window | To complete | HTTP and simulated UI do not replace testing the real .app in the foreground. |
| Q-05 — general quality | To complete | Baseline Qwen3.6 11/12, Qwen3.8 12/12. At least 100 common cases per model and numerical references remain. |
| Q-06 — other modes and new 27B | To implement/qualify | Learn/thinking, Design, vision/PDF and Qwen27B do not become supported as a result of this tranche. |

## Changes to preserve

- [Native patches](../patch/ds4-agent-jsonl/README.md), manifest **91**:
  each fork retains its tokenizer, kernels and tool format.
- Reset prepares at most one candidate KV session with the same configured
  context and shared weights, not a second model copy. The old context remains
  valid until publication. Errors returned by the API and cancellation
  must not destroy it.
- A requested save must succeed before reset. If it succeeds and reset is
  cancelled, that save remains. A failed save does not assign a new identity
  to the session.
- Prompt-cache reuse only when compatible, no speculative writes.
  Preparation and release of old buffers outside the mutex.
  No automatic context reduction.
- The UI waits for the reset outcome before connecting the engine to the new
  conversation. A native error receipt is not success. Requests that become
  stale during a view change are not sent.
- Legacy main/Laguna reset and TTY CLI remain separate changes; their variants
  were not changed, and no qualification is inferred.

## Identities

| Component | Revision |
| --- | --- |
| Qwen3.6, vagrillo/ds4 | 60fca11f0c8b16ca50c757324dddd717ba043098 |
| Qwen3.8, ivanfioravanti/ds4-metal | 66b0e3fc3bf0f548db1ec0c0dd19f4e43567a7f8 |
| DStudio adapters | patch/ds4-agent-jsonl/manifest, version 91 |

Source, patch and derived-file hashes: [bases.json](../patch/ds4-agent-jsonl/bases.json).
An archive checkout does not inherit the parent directory's Git identity.
Do not update forks or weights during a replay without recording a new base.

Latest replays at this historical point: Mac M2 Max with 96 GB, Metal,
**16,384-token** context, thinking disabled and native sampling settings.
Qwen3.6 uses resident 31.8 GB Q6_K_XL; Qwen3.8 uses resident 73.4 GB Q4K/MXFP4
plus 32.0 GB Q4_1 PLE on SSD. Expert streaming disabled for both. No implied
128k testing: configured capacity and processed prompt amount are distinct.
Complete file and binary identities are in private replay receipts.

## Tests to repeat

Commands from the project root; replace engine paths with the exact already
built checkouts. These do not load weights:

    make test-engine-setup-unit test-launch-preflight test-agent-spawn
    make test-qwen-session-reset QWEN35_AGENT_TREE=/path/to/ds4-qwen35 QWEN38_AGENT_TREE=/path/to/ds4-qwen38
    make test-qwen35-agent QWEN35_AGENT_TREE=/path/to/ds4-qwen35 QWEN35_AGENT_FLAGS=--sanitize
    make test-qwen38-agent QWEN38_AGENT_TREE=/path/to/ds4-qwen38 QWEN38_AGENT_FLAGS=--sanitize
    DSTUDIO_AGENT_QWEN35_DIR=/path/to/ds4-qwen35 DSTUDIO_AGENT_QWEN38_DIR=/path/to/ds4-qwen38 make test-agent-patch-migration
    node tests/unit/agent_session_capability_test.mjs
    node tests/unit/frontend_behavior_test.mjs
    node tests/unit/qwen38_tool_oracle_test.mjs
    node tests/browser/ui_agent_design_playwright_test.mjs
    DSTUDIO_TEST_BROWSER=webkit node tests/browser/ui_agent_design_playwright_test.mjs

The reset test runs native handlers and threads with simulated inference and
a deterministic barrier: cancellation, error, success, failed allocation, late
cancellation, duplicates; Qwen3.8 includes failed saves and image references.
ASan/UBSan cover Agent/helpers, not already compiled core objects.

## Available receipts

Paths relative to `tests/.artifacts/`, ignored by Git. Initial failed checks
are retained, not replaced by retries.

| Check | Receipt | Outcome / scope |
| --- | --- | --- |
| Original Qwen3.6 reset | `agent-session-reset/run-g340ve` | 3/3 expected red cases: reproduces the defect |
| Original Qwen3.8 reset | `agent-session-reset/run-NKTNJv` | 3/3 expected red cases: reproduces the defect |
| Qwen3.6 reset, patch 91 | `agent-session-reset/run-mHCmsD` | 6/6 PASS, simulated inference and native threads |
| Qwen3.8 reset, patch 91 | `agent-session-reset/run-wZAYRH` | 7/7 PASS, simulated inference and native threads |
| Patch application | `agent-patch-migration/run-gk25s5` | 5/5 PASS, including repeat application, restoration, drift and unrelated changes |
| Qwen3.6 parser and tools | `qwen35-agent/run-uWi4Ah` | PASS, ASan/UBSan on adapters, real filesystem |
| Qwen3.8 parser and tools | `qwen38-agent/run-B3Hnd8` | PASS, ASan/UBSan on adapters, real filesystem |
| Repeated Qwen3.6 setup, patch 91 | `qwen35-http-dqrmY1` | PASS, real CLI and HTTP, no weights or inference |
| First Qwen3.6 reset replay | `qwen35-host-live/run-KaB607` | FAIL retained: the test did not reassemble text across progress events |
| Second Qwen3.6 reset replay | `qwen35-host-live/run-l76E5r` | FAIL retained: the test included the internal receipt hidden by the UI |
| Qwen3.6 replay with corrected decoder | `qwen35-host-live/run-rTxWZs` | 2/2 PASS: Agent and Cowork, cancellation with exact recall, completed reset and real reading |
| First Qwen3.8 reset replay | `qwen38-host-live/run-uAb5iW` | FAIL retained: 4,358-token prompt, all in one block; reset succeeded but no observable intermediate progress |
| Second Qwen3.8 reset replay | `qwen38-host-live/run-QQtql2` | FAIL retained: cancellation and code correct, but the test included the native autosave line in the answer |
| Qwen3.8 replay with corrected fixture and decoder | `qwen38-host-live/run-pebGA0` | 2/2 PASS: Agent and Cowork, partial progress, cancellation with exact recall, full reset and real reading |

In both failed replays, the cancellation receipt was correct and the visible
text contained exactly the original code. The corrected oracle verified both
receipts without modifying them; it is now used for both Qwen models.
Regressions exclude question echoes, reassemble fragmented events and reject
incorrect codes or extra text.
This does not resolve the separate counting failure `run-MJEBA6`.

The pinned Qwen3.8 fork uses native 8,192-token prefill blocks and calls the
progress callback after each block. The first fixture contained only
4,358 tokens: it could not qualify cancellation between blocks. The subsequent
replay uses more inert text only in the test workspace, without changing chunk,
context, engine or deadline. The shared grader now requires `0 < done < total`;
all four resets in the already retained Qwen3.6 replay also satisfy this
stricter condition. New regressions reject final-only progress.

In the second Qwen3.8 replay, reset is cancelled after 8,192 of 9,958 tokens,
and the answer recalls the exact code. However, the initial grader included
the message `saved session … (… tokens)`: the UI classifies it as a system
item. The shared decoder now excludes that exact terminal form; a regression
also executes the real `splitUserTurns`/`segmentAgent` functions and verifies
answer/system separation for correct and incorrect codes.
The failed receipt is retained and checked without rewriting its outcome.

Results of this reset campaign: **six script attempts**, four initial failures
due to the test/fixture defects described above and two complete successful
final replays, each with Agent and Cowork. This is not a model quality rate.
The final decoder was reapplied to already retained Qwen3.6 answers without
rewriting them: semantic checks continue to pass.

Other targeted checks: preflight **28/28**, pipe/process startup **16/16**,
UI session queue **34/34**, frontend regressions and tool oracle PASS.
Chromium and WebKit browsers PASS with a simulated engine, including the failed
reset receipt in Agent and Cowork. These do not test the real `.app` window.

## Replays with real models

Explicit heavy verification, **one model at a time**:

    make tests/.build/dstudio-server-test
    node tests/live/qwen38_host_smoke.mjs /path/to/ds4-qwen35 /path/to/qwen36.gguf --qwen35 --reset-lifecycle
    node tests/live/qwen38_host_smoke.mjs /path/to/ds4-qwen38 /path/to/qwen38.gguf /path/to/ple.gguf --reset-lifecycle

Requires weights already present in the checkout's shared store. Verifies
tools/files, cancellation during reset, recall of a code present only in
the previous conversation, completed reset and a new read.
Uses an isolated profile/workspace and terminates only its own processes.

Detailed receipts in tests/.artifacts/ are local and ignored by Git.
These replays are not speed benchmarks, held-out quality or desktop checks.
Reset fixtures deliberately differ to exercise the two native granularities:
Qwen3.6 updates per token, Qwen3.8 per block. On the latter, the counter may
not advance for the duration of a block; the test neither qualifies interruption
inside a GPU kernel nor updates invented percentages.
The old --controls check and its initial counting failure remain distinct:
--reset-lifecycle does not replace them.

Qwen3.6: in the final replay, both cancelled resets preserve context;
the other two complete and allow reading the previous file. Full-reset waits
were 314 s for Agent and 553 s for Cowork: measurements from this single
development check, not benchmarks or a performance comparison. Reset remains
expensive, but controls remain responsive. Test hosts and engines were closed
and verified absent; the user's `.app` remained intact.

Qwen3.8: both modes observe one block completed while work remains,
cancel reset and recall the previous code without tools. The second reset
completes and allows a new read. Native autosave produces its receipts;
this does not replace a complete disk-checkpoint restoration matrix.
Hosts and engines from the final replay were verified absent after shutdown.
No test model is left running.

Targeted gates were rerun at completion: setup/preflight/spawn/oracles
PASS, runner syntax and `git diff --check` PASS. Chromium/WebKit tests and
native sanitizer checks remain the targeted checks listed above; no new
complete `check-fast`, complete performance profile or `.app` release
qualification was claimed.

## GitHub package verification

On September 7, only the content selected for the commit was reconstructed
in an isolated worktree: changes from other chapters left in the working
copy cannot make these checks pass. The published main pin remains
**f4d03f6**; the main/GLM update, Goals, PDF restyling and Design results are
outside this historical push. Included are the shared dependencies needed
to install and launch Qwen runtimes, including the common protocol adaptation
in the Design consumer, not its integration with Qwen.

| Check repeated on the package | Outcome and scope |
| --- | --- |
| Host, setup, preflight and spawn | Native compilation PASS; preflight 28/28, spawn 16/16 and UI sessions 34/34 |
| Qwen reset and tools | 6/6 Qwen3.6 and 7/7 Qwen3.8; parser/tools PASS with ASan/UBSan on adapters and simulated inference |
| Patches and private builds | 39 applicator checks, 5 Agent bases and 9 web/server bases PASS; 8 Agent build scenarios and 17 Design PASS with a simulated compiler |
| Shared main/Laguna native builds | 23 scenarios PASS: compilation, tools, renderer and Design consumer; no weights loaded |
| Startup and controls | 11 HTTP scenarios PASS; 5 Chromium and 5 WebKit PASS, plus Agent/Cowork regressions; simulated engines |
| Catalog, PLE and metrics | Qwen3.6 catalog and Qwen3.8 PLE patch lifecycle PASS; real JSON/SSE serializers and patch lifecycle on three main/Laguna sources PASS |
| Backend routing | 16/16 PASS with simulated compilers/linkers; does not qualify real CUDA, ROCm or Vulkan |

In addition to the commands above, the following were run:

    make test-unified-patch test-agent-build test-design-build-freshness
    make test-launch-control test-ui-launch test-steering
    make test-agent-native-build AGENT_MAIN_TREE=/path/to/main-f4d03f6 AGENT_LAGUNA_TREE=/path/to/laguna
    make test-runtime-patch-migration
    node tests/integration/backend_link_test.mjs /path/to/main /path/to/laguna /path/to/qwen38 /path/to/qwen35
    make test-qwen35-catalog QWEN35_DIR=/path/to/qwen35
    make test-qwen38-inspect QWEN38_DIR=/path/to/qwen38
    make test-server-metrics-patch test-main-decode-metrics METRICS_MAIN_DIR=/path/to/main-git-history LAGUNA_DIR=/path/to/laguna
    node tests/unit/quality_baseline_test.mjs

Migrations require the exact sources declared in their respective harnesses;
the metrics check also requires main Git object `f4d03f6`.
Receipts from this verification are local under
`tests/.artifacts/qwen-publish.MZN3J1/tree/tests/.artifacts/`.
Initial failed attempts are also retained: incomplete source fixtures,
an archive lacking the Git history required by the metrics test and a Design
consumer omitted from the first commit selection. After supplying the required
fixtures and including that shared adaptation, affected gates were repeated
in full without weakening assertions.

Acceptance runners include both structured Qwen executables and the new pin
at first launch. Publication verification did not repeat downloads, real
inference or `.app` startup: real replays remain those documented above.
No new speed benchmark or quality score is claimed.

## After the pause

1. Q-04: real .app, menus, model switching, Stop, new conversation and resume.
   Preserve the previous desktop Chat check as the baseline; repeat affected
   paths on the new isolated build without attributing the full historical
   matrix to the new patch. Local reference: P7 of `PLAN.MD`.
2. Q-05: common corpus of 100 questions per model, numerical checks and
   investigation of counting that ended early. A successful retry establishes
   neither the cause nor the fix.
   Freeze cases/oracles before runs and keep errors and timeouts in the
   denominator. Distribution and criteria remain in P6 of the local plan.
3. Q-06: Learn/thinking, Design, vision, new Qwen27B and installer/backends.
   CUDA/Vulkan/ROCm require separate checks on appropriate hardware.
   Candidates and concrete Metal/CUDA gaps remain in P3 of the local plan;
   no new weights or engine were downloaded to start this phase early.
4. Other local plan chapters: other engines, PDF/vision, nine design systems,
   Agent comparisons, profiling, final build and publication of benchmarks
   with Matplotlib.

Do not mark P3/P6/P7 or the entire plan complete merely because the current
tranche passes. Before a push, review the worktree and private data,
with the required authorization.
