# Bounded Metal error diagnostics for q36

This diagnostic-only candidate helps identify the command that failed during
the long-context 27B replay. It **does not fix that failure** and is not enabled
in the managed installer or the recorded common-100 benchmark.

Apply [runtime.patch](runtime.patch) after the complete
[q36 Metal adaptation](../q36-metal-runtime/README.md), SHA-256
`75764a9fcca0af2e60d937266b9bb02f0b4be394623b6a8509a74f30bf3dd0df`,
on `Ninnix/q36` base `d67687ed15ad9f52b755a9b5fdfc0214ea937555`
or reviewed candidate `d02b6a20a7662300003c859e186ceb5bec7aa849`.
That upstream delta changes no Metal/core source. The
[terminal patch](../q36-agent-tty/README.md) touches different files.
Restore this diagnostic patch before restoring the main Metal adaptation.

```sh
Q36_DIR=/path/to/reviewed/q36 sh scripts/apply-q36-metal-diagnostics.sh apply
make -C /path/to/reviewed/q36 -j2 metal
Q36_SOURCE=/path/to/reviewed/q36 make test-q36-metal-diagnostics
Q36_METAL_ERROR_DETAILS=1 /path/to/reviewed/q36/q36-server --help
Q36_DIR=/path/to/reviewed/q36 sh scripts/apply-q36-metal-diagnostics.sh restore
```

The `--help` example loads no model. Pass the environment variable to a
separately recorded, resource-bounded diagnostic inference run when needed.
The script applies/reapplies/checks/restores the complete patch and rejects
partial/drifted sources without modifying them. Rebuild after applying or
restoring it; do not use a binary from a different patch state.

Only the exact value `Q36_METAL_ERROR_DETAILS=1` enables Apple's
[encoder execution-status reporting](https://developer.apple.com/documentation/metal/mtlcommandbufferdescriptor/erroroptions).
It retains strong command-resource references and leaves kernels, query
partitioning, arithmetic, precision, context and inference requests unchanged.
Two labels distinguish preceding attention inputs from the attention tile,
including token position, query count and heads. The driver can report unknown,
completed, affected, pending or faulted encoders; **affected is not proof of
causation**. Missing details remain explicitly missing.

The inference owner maintains one flag and counter. Driver allocation,
submission/waits and diagnostics stay outside the shared publication mutex.
There is no new task, queue, cache or tensor field. At most four error reports
per GPU initialization contain at most 64 encoder rows, with labels capped at
128 bytes and phase/domain capped at 160/128 bytes. There is no success/per-token
log; disabled mode uses the original command constructor and does not allocate
the diagnostic descriptor or labels. Apple's tracking may add overhead while
enabled, so diagnostic runs are not speed comparisons.

The native gate checks actual command options and retained references with
diagnostics unset, on, off and invalid, plus 64 byte-exact GPU addition results.
Five **simulated** error receipts verify the four-report/64-row bounds, all
five unmodified status values, missing driver information, no hidden retry and
unlocked submission/wait callbacks. Simulated errors do not establish that a
real driver will identify the failing kernel. Complete numerical parity,
the native correction and other-backend qualification remain open.

The separately retained 9 September real-model replay did identify one
`Faulted` encoder: `q36_attention_f16_parallel`, command label
`attention-tile pos=27196 queries=12 heads=24`, with `ImpactingInteractivity`.
The HTTP request failed before its unchanged deadline; the owned engine was
reaped and source/model identities were preserved. This localizes the command,
not the driver's internal cause, and does not qualify a fix or alter the
original common-100 score. See the [Qwen checkpoint](../../docs/QWEN_CHECKPOINT.md).

The [retained-request diagnostic](../../tests/live/q36_retained_request_diagnostic.mjs)
provides a separate one-case investigation with pinned inputs and the original
deadline. Its preflight removes/applies the complete stack only in a private
copy: checking the base patch in isolation while this overlay is present can
incorrectly reject valid source context. Added shaders are part of the snapshot
even though they are not tracked in the upstream Git tree. See the
[test instructions](../../tests/README.md) for model-free admission checks and
the explicit live invocation. Failed preflights are retained, not inference runs.

Upstream attribution and MIT terms remain in the checkout and the shared
[license notice](../q36-metal-runtime/LICENSE).
