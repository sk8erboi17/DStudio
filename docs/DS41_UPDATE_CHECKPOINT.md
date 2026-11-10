# Engine and DeepSeek V4.1 — remaining qualification

Updated November 10, 2026. The wider macOS campaign is incomplete and paused.
On November 10 the owner returned DeepSeek V4.1 Q2/Q4 to the maintainer's
execution plan, with expert SSD streaming only
([conditions](../PLAN.MD#v41-ssd)): results on the maintainer's M2 Max (96 GB)
qualify that memory mode only, 1017 Q2 is not run yet, and Q4 stays BLOCKED
until its weights are downloaded. GLM 5.3 is still not in the maintainer's
plan: it remains BLOCKED and open for a contributor with suitable hardware
([contributor hardware](../PLAN.MD#contributors)). This document lists remaining work; the dated source/build/install
history and original failures are retained in
[the archived update checkpoint](history/engine-update-through-2026-10-01.md).

## Remaining cross-engine work

1. Complete applicable upstream-delta/equivalence reviews and exact qualifying
   receipts for the nine macOS targets in [engine-upstream.json](engine-upstream.json).
   Main's active recorded pin is 890898c (0aaea5a until November 3, 2026); the old update revisions remain
   historical, not the identity of the final build.
2. Complete Agent/Cowork dependency signatures, coordinated crash-safe runtime
   publication and verified legacy-source recovery. Retain source/backup identity
   and unrelated checkout changes throughout failure and recovery.
3. Extend current install/upgrade/fault acceptance across the full engine/mode
   matrix. Fresh bundled offline builds exist (main, Laguna, llama.cpp); the real
   q36 cache-preserving upgrade predates q36's retirement on October 3. Neither
   is permission to overwrite a user's installed engines.
4. Complete the llama.cpp Qwen3.6/27B numerical/long-context, Learn/Tutor,
   PDF/vision, multi-session and native-desktop qualification through
   [the active Qwen checkpoint](QWEN_CHECKPOINT.md).
5. Bind all final source/patch/compiler/binary/weight/component/settings
   identities, then complete final admission and reviewed publication.

## Remaining V4.1 and GLM work

| Selection | Work still required |
| --- | --- |
| V4.1 Flash 1017 Q2 (`ds41f-q2`) | Maintainer's plan, expert SSD streaming only; not run. Complete its own current-stack 100-case, Chat/Agent/Learn/Cowork, Design, desktop, native vision, installation/recovery and memory/Engram/SSD qualification. The original Q2's retained format failure does not transfer to this checkpoint. |
| V4.1 Q4 | Maintainer's plan, expert SSD streaming only; BLOCKED until its 518.6 GB of weights are downloaded (not authorized, and larger than the current free space). Independent current-stack numerical, answer, mode, memory/Engram/SSD, installation/recovery and desktop qualification. Q2 does not establish Q4 results. |
| GLM 5.3 | Matching 100 continuations and long-context numerics, complete common-answer/product matrix, compatible native-vision components and 30-PDF/20-image checks, installation/recovery, Design and desktop. |

The original V4.1 Q2 (`ds41f-q2-original`), not the 1017 checkpoint, has
retained small runs on `bd66c40` and `0aaea5a`, each with **13/14**
conforming answers. The arithmetic value 56 is correct but unwanted prose
violates the exact output requirement. This remains FAIL; do not loosen the
grader or report those runs as complete qualification. Revalidate that defect
only against the original checkpoint when working on its own acceptance;
the 1017 checkpoint needs independent quality results.

On November 4 the pinned Q2/1017 vision downloader moved to HTTP range resume
with a digest-bound existing partial, exclusive ownership, bounded connection
retries and exact size/SHA-256 verification. Fourteen small-payload HTTP cases
pass. One real 1017 Q2 transfer resumed an existing partial and completed at
365,713,686,528 bytes with the pinned SHA-256. This proves that transfer's
integrity, not inference, native vision, Engram behavior or full product
qualification. The [change note](changes/2026-11-04.md) records the scope;
the qualification rows above remain open.

The real Learn development runs of November 4–10 used 1017 Q2 with expert SSD
streaming reported effective; their retained failures are listed in
[the plan](../PLAN.MD#p3) and the dated [change notes](changes/2026-11-10.md).
They are development checks and do not qualify the selection. V4.1 campaign
runs on the maintainer's Mac use expert SSD streaming On and record the
effective mode; a result there never qualifies resident weights or streaming
Off.

Distinguish the native disk-backed Engram table, SSD expert streaming, resident
weights and disk KV. Record effective memory mode and cache/prefill budgets.
Prove admission on the actual Mac rather than increasing wired-memory limits,
hiding allocation failures or silently lowering context/precision.
Other platforms are outside this campaign, not inferred numerical successes.

## Evidence and execution

- [Current remaining plan](../PLAN.MD) and [short WIP](WORK_IN_PROGRESS.md).
- [Engine admission method and missing evidence](ENGINE_UPSTREAM_ALIGNMENT.md).
- [Bundled sources, pins and offline setup](BUNDLED_ENGINES.md).
- [Historical update receipts and original failures](history/engine-update-through-2026-10-01.md).
- [Test entry points and prerequisites](../tests/README.md).

Earlier successful builds, model-byte verification, small real SSD runs,
q36 tool/cache replays and Desktop reports are preserved as completed evidence
at their exact recorded scope. They do not authorize a rerun or convert
missing final-release gates into PASS. Keep private raw evidence ignored.
