# Cancellable Qwen3.8 reset preparation

Base: [ivanfioravanti/ds4-metal at b85a617](https://github.com/ivanfioravanti/ds4-metal/commit/b85a6174da6d0ea3139b48194a2ca108097657b1),
branch `qwen3.8-flash-next`. MIT upstream notices remain applicable.
The [current variant](prepare-current.patch) rebases the same bounded candidate
preparation onto `2dda88ed7bc596087f5282a6020d7409ca713ff3` and applies unchanged
to the current `ff4f0ff4fdff70d6b7c3941ef437b91dde960e14`. It retains upstream's
new valid-checkpoint vision identity check. The installer selects a complete
exact-context variant; it never overlays both. New-revision behavioral and
real-weight qualification is recorded separately from the older results below.
This patch is under qualification; it is not a claim of model quality,
speedup, other-backend parity or completion of the Qwen plan.
Patch lifecycle also passes on the exact b4c3550, 0bb323a, 66b0e3f and 82d0314
core sources. These are source-application results, not numerical runs on
every revision. The older bd9cfbc installation is rejected unchanged and needs
the separately verified engine upgrade; it is not silently modified.

The real Cowork reset replay `qwen38-host-live/run-8zpOrR` did not become idle
within the existing 15-second cancellation deadline. Native Qwen sync polls
only between whole prefill chunks; submitting all layers of an 8,192-token
chunk can delay Stop beyond that deadline.

`ds4_session_prepare_empty` is explicitly for an empty, unpublished local
Qwen3.8 GPU session. It preserves chunk dimensions, context, kernels and
arithmetic order, but drains one GPU layer at a time when cancellation is
registered. Host embedding/PLE staging also polls between bounded row groups.
Partial recurrent state belongs only to that candidate; cancellation invalidates
it. The caller retains the previous live session and must revalidate before
publishing a successful candidate. No extra weights or snapshot buffers are
allocated. The control record is call-local, not persistent session state.

Normal `ds4_session_sync` keeps its existing valid-prefix cancellation contract.
This patch does not claim to solve mid-chunk cancellation of an already-live
session. Nonempty, distributed, tensor-parallel and other-model candidates are
rejected without changing them. Display-only `prefill_layer` events count
completed layers and must not be interpreted as durable token checkpoints.

Apply this native core/header patch before building the matching Agent/Cowork
adapter. It is separate from metadata-only PLE inspection and vision mapping.
The complete variants are [prepare-empty.patch](prepare-empty.patch) and
[prepare-current.patch](prepare-current.patch). The separate
[snapshot-allocation correction](../ds4-qwen38-snapshot/README.md) follows it;
that fix does not change this candidate API or its inference arithmetic.

    DS4_DIR=/path/to/ds4-qwen38 sh scripts/apply-ds4-qwen38-prepare.sh check
    DS4_DIR=/path/to/ds4-qwen38 sh scripts/apply-ds4-qwen38-prepare.sh apply
    DS4_DIR=/path/to/ds4-qwen38 sh scripts/apply-ds4-qwen38-prepare.sh restore

Apply/restore are idempotent. Git checks the complete multi-file patch before
changing files; partial patches and drift fail without replacing contributor
changes. A parent repository is not accepted as source provenance.

## Verification

    make test-qwen38-prepare-patch QWEN38_AGENT_TREE=/path/to/exact/source
    make test-qwen38-prepare-live QWEN38_AGENT_TREE=/path/to/built/candidate QWEN38_MODEL=/path/to/model.gguf QWEN38_PLE=/path/to/ple.gguf

The first gate tests apply/repeat/read-only check/restore, unrelated edits,
each partial-file state, drift in either file, symlinks and wrong ABI. It writes
only private fixture copies. The second explicitly loads actual weights on
Metal; it never downloads or stops an unrelated process.

The first completed native run, `qwen38-prepare-live/run-8t4x4R`, passes eight
checks on M2 Max 96 GiB with b85a617, resident Q4K/MXFP4 weights, native SSD PLE,
expert streaming off and context 16,384. It rejects a nonempty candidate without
changing its serialized state, cancels before staging and after GPU layers 1/4,
rejects invalid tokens, and preserves the previous live snapshot byte for byte.
An 8,193-token prefill and eight subsequent decode steps have bit-identical
logits and serialized state versus the normal sync path in the same build.
That is a bounded differential regression, not equivalence to an independent
inference implementation or a general quality score.

The run took 87.8 seconds including model loading and all checks. Single-sample
prefill times were 21.50 seconds normal and 22.41 seconds candidate preparation;
no speedup is claimed. Cancellation is injected at deterministic completed-layer
boundaries here. End-to-end Stop latency from another thread/HTTP client is a
separate real Agent/Cowork replay, retaining its original 15-second deadline.
The initial harness failure `run-Okzbuo` (wrong shader provenance path, before
model launch) remains recorded separately.
