# Qwen27B parallel F16 attention

## Current installed overlay — 1305843

[`online-1305843.patch`](online-1305843.patch) replaces the long-context F16
attention path with parallel key tiles and FP32 online softmax. F16 K/V, the
requested context, causal frontiers, sinks and final gating are preserved.
Short F16 attention (through 1,024 keys) and quantized attention retain their
existing paths. Reduction reassociation has an explicit tested error bound;
this overlay does not claim byte-identical floating-point output.

Upstream: [Ninnix/q36 at
`1305843c735380f912619548b121cba8601f2f85`](https://github.com/Ninnix/q36/tree/1305843c735380f912619548b121cba8601f2f85).
Apply, in order:

1. `q36-metal-runtime/runtime-1305843.patch`.
2. `q36-agent-tty/monitor.patch`.
3. `q36-agent-tty/monitor-owner.patch`.
4. `q36-metal-runtime/cache-usage.patch`.
5. This online attention patch.

The managed installer applies this stack, builds it privately and records its
ordered patch identities, source and binary hashes. Repeat installation verifies
the same identities without rebuilding. Diagnostic builds may add the existing
Metal diagnostics overlay last; the retained-request runner now admits this
current stack as well as its historical base. Restore in reverse order.

```sh
Q36_DIR=/path/to/current/q36 sh scripts/apply-q36-f16-attention.sh apply online
make -j2 -C /path/to/current/q36 metal
make test-q36-f16-online Q36_SOURCE=/path/to/current/q36
```

Each workgroup visits at most 512 keys. Query tiles limit a submitted attention
command to 8,388,608 key/query/head pairs. Partial FP32 maxima, denominators and
value accumulators use the existing request-owned score scratch; no new tensor,
worker or cache is allocated. The 24-query-head/4-KV-head, 256-dimension path
reuses K/V across six heads. Actual pipeline metadata bounds static threadgroup
storage at 18,464 bytes (generic path: 2,080 bytes). The private argument block
is 28 bytes; public tensor/session types do not grow. Insufficient scratch or
unsupported work capacity fails explicitly, without reducing context/precision.
GPU encoding, waits and retirement stay outside the publication mutex. A failed
encoder discards only unsubmitted private work; submitted effects are not replayed.

The Apple M2 Max gate passes all 18 input cases through 50,869 KV positions
(`q36-attention-work/run-1bo6RL`, 708,420 checks, zero failures). Every output
is compared with the unchanged original GPU shader. Selected first/last query
and head outputs also use an independent FP64 scalar attention oracle. The
bound is `abs(candidate-reference)/max(1,abs(reference)) <= 1e-3`; the observed
maximum is 4.0676e-5 against the original GPU shader and 4.2691e-7 against FP64
samples. Fixtures cover ordinary/extreme/uniform inputs, sinks, non-square GQA,
partial lanes, tile boundaries, output guards, undersized views, overflow and
both failed encoders, followed by successful recovery.

The 18 lifecycle cases (`q36-f16-attention-patch/run-Bs2H5r`) execute apply,
repeat apply, restore, partial/drift/link rejection, unrelated-change preservation,
hostile Git environments and build invalidation. A real empty-root network
installation of the exact pin and Metal compilation pass; repeat installation
reports no download or model load. Installer fixture tests pass 43/43.

**Full-model long-context qualification remains open.** No new corpus or Learn
inference has been started for this overlay. The original requests, 900-second
deadlines and failed receipts remain unchanged. Operator checks cannot establish
complete-model numerical parity, answer quality, end-to-end speed or other-backend
behavior. The operator reserved the quality suite rerun.

## Archived exact-order candidate — d02b6a20

This candidate addresses the Metal command that failed while Qwen27B read a
long prompt. It splits that command into bounded pieces without shortening
the prompt, changing KV precision or reducing the requested context. **It is
not yet promoted into the managed installer or the installed desktop app.**
Operator tests pass; complete-model long-context qualification remains open.
The first actual-model replay with this candidate reached the original
900-second deadline before producing an answer. It did not repeat the earlier
Metal error during that run, but this is **still a failed request**, not a
qualified fix. The failure receipt is preserved in the Qwen checkpoint.

### Source and application order

Reviewed source: `Ninnix/q36`, revision
`d02b6a20a7662300003c859e186ceb5bec7aa849`. Apply these explicit patches in order:

1. [Metal runtime](../q36-metal-runtime/README.md), SHA-256
   `75764a9fcca0af2e60d937266b9bb02f0b4be394623b6a8509a74f30bf3dd0df`.
2. [Native terminal](../q36-agent-tty/README.md), SHA-256
   `a45090e364018d5b684881bf163dff0594b71708a79bf7ccd4be3e530583cce7`.
3. [Optional diagnostics](../q36-metal-diagnostics/README.md), SHA-256
   `83c792f8f214f94a260da0e3f6f97208dc10a9d1be846339be77fe8bc11dc206`.
4. This [F16 patch](runtime.patch), SHA-256
   `893f7f07b5b6f6e5fe2d4e8fbd1f6851a8fcec068e95193b3e8a096e98990364`.

Restore overlays in reverse order. The last patch changes only `q36_metal.m`
and `metal/attention.metal`. The application script performs no build, download
or process restart. Rebuild after apply or restore, including shader changes.

```sh
Q36_DIR=/path/to/reviewed/q36 sh scripts/apply-q36-f16-attention.sh apply
make -C /path/to/reviewed/q36 -j2 metal
make test-q36-f16-attention Q36_SOURCE=/path/to/reviewed/q36
Q36_DIR=/path/to/reviewed/q36 sh scripts/apply-q36-f16-attention.sh check
```

The lifecycle test uses its own source copy. It exercises repeated application,
restoration, every proper combination of the three patch hunks, incompatible
sources, linked targets and hostile ambient Git settings. Unrelated changes in
the same files and a separate file survive. A Make query checks that either
changed input invalidates the Metal object; this dependency check is not a
complete fresh-install or rebuilt-binary qualification.

### Arithmetic, ownership and bounds

The original F16 shader remains the short-context path and the independent GPU
comparison oracle. Quantized attention is unchanged. Longer F16 calls use two
ordered passes: scores/maximum, then weights/denominator/value accumulation.
Each submitted command covers at most 1,024 key positions and 8,192 query/head
pairs. Causality, sink initialization, per-lane FMA order, left-to-right FP32
sums and final gating retain the original arithmetic order.

The current revision keeps each lane's query elements in registers, stages
at most 1,024 weights in 4 KiB of threadgroup memory and prepares eight
independent value reads before their ordered FMA chain. The scalar tail retains
the exact causal frontier. Inactive value lanes join the shared-memory barrier
before leaving. This is bounded per-dispatch scratch, not a persistent cache;
there is no new worker, host allocation or change to the command count.

The inference owner keeps the inputs and private output alive throughout the
call. A per-call allocation holds two FP32 values per query/head, at most
64 KiB. It is not a cache and has no lifetime beyond the call. Existing score
scratch and private output are reused; this limit does not describe total KV,
model or driver memory. The private GPU argument block is 36 bytes; no public
tensor, model, session or transport structure grows.

Driver allocation, submission, waits and release stay outside the shared
publication mutex. Failure stops the operation without replay. An unsubmitted
half-command is discarded; an incomplete private output is not an authoritative
session. The existing owner-side validation still decides whether a fully
prepared result may be published. There is no new worker, queue or mode flag.

### Evidence and remaining qualification

The model-free Apple M2 Max gate checks 18 input cases with exact GPU comparison
for every query, including 16/2 and 24/4 head layouts, the 1,024-position and
query-tile boundaries, the recorded failure position and over 50,000 positions.
It includes uniform and extreme values, sinks, output guards, undersized views,
overflow, allocation failure, command creation failure and failure at each of
eight encoder-creation stages. A subsequent explicit operation must still
produce the original complete result. Allocations and waits are observed
outside the shared mutex; temporary tensor accounting returns to its baseline.
Additional cases exercise dimensions 1, 33, 64 and 128, partial groups and
different integral head ratios. Actual pipeline metadata verifies the 4 KiB
static threadgroup limit, separately from the 64 KiB temporary tensor limit.

Five alternating before/after runs compare this revision to the first bounded
candidate (`f4ff02bb…`), using all eighteen checks in each invocation. On the
synthetic 50,741-position/128-query/24-head case, median operator wall time was
423.343 ms before (range 413.639–446.609) and 301.241 ms after
(281.188–309.269). GPU time was 351.618 versus 232.675 ms. These are **real
Metal operators with synthetic inputs**, not LLM inference or chat speed.
Every query still matched the original GPU kernel byte for byte. The failed
900-second complete-model receipt remains failed; this microbenchmark cannot
replace it. Five repetitions do not establish tail-latency percentiles.

These tests use actual Metal operators, but do **not** establish complete-model
numerical parity, answer quality, faster inference or CUDA/Vulkan equivalence.
Native owner/cache/cancellation tests separately use simulated numerical
sessions. Keep those results separate from the actual-model retained-request
replay and the unchanged original common-100 denominator.

For a new retained-request run, add `--f16-attention` to the
[diagnostic runner](../../tests/live/q36_retained_request_diagnostic.mjs).
It explicitly records and round-trips all four patches in a private copy.
The request, weights, settings and original deadline are unchanged. See the
[test instructions](../../tests/README.md) and
[current Qwen checkpoint](../../docs/QWEN_CHECKPOINT.md).

Upstream copyright and MIT terms remain in the checkout and the full
[license notice](../q36-metal-runtime/LICENSE).
