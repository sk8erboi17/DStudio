# Engine and DeepSeek V4.1 — remaining qualification

Updated October 1, 2026. The wider macOS campaign is incomplete and paused.
DeepSeek V4.1 Q2/Q4 and GLM 5.3 are qualified last in a separate dedicated
session. This document lists remaining work; the dated source/build/install
history and original failures are retained in
[the archived update checkpoint](history/engine-update-through-2026-10-01.md).

## Remaining cross-engine work

1. Complete applicable upstream-delta/equivalence reviews and exact qualifying
   receipts for the nine macOS targets in [engine-upstream.json](engine-upstream.json).
   Main's active recorded pin is 0aaea5a; the old update revisions remain
   historical, not the identity of the final build.
2. Complete Agent/Cowork dependency signatures, coordinated crash-safe runtime
   publication and verified legacy-source recovery. Retain source/backup identity
   and unrelated checkout changes throughout failure and recovery.
3. Extend current install/upgrade/fault acceptance across the full engine/mode
   matrix. Fresh bundled offline builds and a real q36 cache-preserving upgrade
   already exist; they are not missing implementations or permission to overwrite
   a user's installed engines.
4. Complete q36's current numerical/long-context, Learn/Tutor, PDF/vision,
   multi-session and native-desktop qualification through
   [the active Qwen checkpoint](QWEN_CHECKPOINT.md).
5. Bind all final source/patch/compiler/binary/weight/component/settings
   identities, then complete final admission and reviewed publication.

## Remaining V4.1 and GLM work

| Selection | Work still required |
| --- | --- |
| V4.1 Q2 | Revalidate and address the retained strict-format failure on the final stack; complete 100-case, Chat/Agent/Learn/Cowork, Design, desktop, installation/recovery and native memory/Engram/SSD qualification. |
| V4.1 Q4 | Independent current-stack numerical, answer, mode, memory/Engram/SSD, installation/recovery and desktop qualification. Q2 does not establish Q4 results. |
| GLM 5.3 | Matching 100 continuations and long-context numerics, complete common-answer/product matrix, compatible native-vision components and 30-PDF/20-image checks, installation/recovery, Design and desktop. |

V4.1 Q2's retained small runs on bd66c40 and 0aaea5a each have **13/14**
conforming answers. The arithmetic value 56 is correct but unwanted prose
violates the exact output requirement. This remains FAIL; do not loosen the
grader or report those runs as complete qualification.

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
