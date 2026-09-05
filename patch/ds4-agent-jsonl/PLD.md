# Shared prompt lookup — Agent/Cowork patch 81, Chat patch 1

Managed Chat, Agent and Cowork can look for code/text continuations already
present in their committed context. That includes PDF/document excerpts after
retrieval has inserted them in the prompt, not the entire document on disk.
There is no additional model, download or external index.
This is an original C implementation inspired by
[Prompt Lookup Decoding](https://github.com/apoorvumang/prompt-lookup-decoding)
and [mlx-serve](https://github.com/ddalcu/mlx-serve).

## What is enabled

- Default / `DS4UI_PLD=strict`: reference observation mode. Generation
  still uses the existing ds4 path, including DSpark/MTP if already requested.
  Lookup hits are recorded in `--trace`;
  **this mode does not accelerate generation** or commit speculative state.
- `DS4UI_PLD=batch`: explicitly experimental batched verification, only
  for greedy (`--temp 0`, or Chat request `temperature: 0`), text-only DeepSeek
  on the modern Metal backend.
  It has **not been qualified with real model weights**. Batch and ordinary
  reductions can produce different floating-point results; byte-identical
  long outputs are NOT promised in this mode.
- `DS4UI_PLD=off`: bypass lookup for baseline comparisons. Unknown values
  stay strict; they never turn on the experimental mode.

Set the variable on the process launching DStudio or a managed runtime. It is
read at each new request/tool round; it does not change UI sampling settings.
Per-surface overrides take precedence over the shared value:

| Surface | Override |
| --- | --- |
| Agent | `DS4UI_AGENT_PLD` (existing setting remains supported) |
| Cowork | `DS4UI_COWORK_PLD` |
| Chat / local server APIs | `DS4UI_CHAT_PLD` |

An unknown or empty override selects strict even if the shared value is batch.
An Agent override does not leak into Cowork or Chat.
Existing DSpark/MTP takes precedence. Sampled requests, quality mode, vision,
and remote providers retain their existing generation paths. CPU/CUDA and older
Laguna have no accelerated verifier; they never claim a batch was executed.
The older Laguna Agent source is preserved by its patch variant.
Chat additionally bypasses lookup for multi-slot/batched scheduling and
`ignore_eos`. Thinking defaults are respected: a greedy tool envelope does not
make an otherwise sampled request eligible. Already-running external servers
are reused as-is; DStudio does not retrofit PLD into a process it does not own.
Design and the ordinary upstream CLI are not integrated in this patch.

Patch 81 adds isolated benchmark support, not a change to PLD arithmetic:
`DS4UI_SESSION_CACHE_DIR` redirects saved Agent/Cowork sessions, and
`DS4UI_BENCHMARK_EPOCH` freezes only the model-visible session date/time when
`RUN_HEAVY=1` is also set. Invalid/unset overrides retain the real clock.
This prevents changing timestamps from confounding otherwise matched inputs.

## Implementation and state contract

`pld.h` indexes exact three-token matches in a fixed 64 KiB table (4096 buckets,
four candidates per bucket). Hash collisions are checked against real token
IDs. The index advances only over committed history, is reset at every tool
round (or Chat request/recovery), and rebuilds after a truncation. There is no
shared index across conversations. At most four candidate tokens are
proposed, bounded by remaining output budget and stop tokens. Three rejected
attempts cause a deterministic 16-step cooldown, followed by another probe.

`pld_agent.inc` replaces one anchored decode loop, retaining the upstream
parser, streaming renderer, tool dispatch, cancellation and edit-upto logic.
No proposed tool call is executed before its verified text reaches the parser.
Each error, tool boundary, sampling-mode transition and cancellation releases
the transaction; a shortened block restores state before replaying the consumed
prefix. Cowork uses this same loop, including its normal tool validation.

Chat's anchored hooks retain the original OpenAI/Anthropic/Responses streaming
and non-streaming parser. They read the live session tokens, including hidden
continuations, instead of reconstructing them from visible text. Verification
and restore run under the server inference mutex. Unconsumed verified tokens
are removed by snapshot/replay at a tool boundary, disconnect or shutdown.
Stop strings can truncate part of a token, so the existing cache invalidation
is preserved even after replay; write errors and cancellation also invalidate
an active PLD transaction's session. Every block frees its snapshot. Existing
serial/MTP state handling is retained when there is no PLD transaction.

`pld_core.c` compiles a shared managed-runtime translation unit including upstream `ds4.c`
and appending the verifier adapter. The normal `ds4.o` is neither changed nor
overwritten. The existing tiny-suffix Metal verifier runs the same target
weights, without a draft model. A full session snapshot includes raw-ring
rows, compressed attention, indexer state, token counters and logits. Snapshot
admission is capped at 128 MiB; larger sessions decline batching. Verifier
logits are allocated lazily. Memory/copy/replay costs must be included in
future timing; this conservative first implementation may be slower.

A full accepted block can retain verifier state. A rejected suffix restores
the snapshot and rechecks the accepted prefix against ordinary greedy logits
before replay. A verifier failure is reported as an error, not disguised as a
lookup miss. A failed restore invalidates the session instead of continuing
with potentially corrupted state.

The managed Agent build restores `ds4_agent.c` after both success and failure.
Chat patches an in-memory copy into `ds4_server_pld.c`, builds `ds4-server-pld`,
then removes the temporary source/object. It never rewrites `ds4_server.c`,
`ds4_server.o` or the native `ds4-server` executable. The launcher selects the
derived server after its ordinary runtime preparation; older server ABIs use
the native executable. Patch mtime/version and upstream source/header freshness
invalidate stale builds. Chat also checks the native binary and Makefile.
Unsupported source drift fails compilation or anchor checks explicitly.

## Verification without a model

`make test-pld` (`test-agent-pld` remains available for the C/anchor checks) runs
the production lookup and transaction code against a deterministic stateful
engine double, plus the actual Agent/Cowork loop and Chat eval/cleanup hooks
with parser/stream doubles. It tests full/partial rejection, raw-ring wrap,
every retained prefix, forced edits, tool boundaries, cancellation, rendering
errors, allocation/verification/restore failures, EOS and output limits,
per-surface settings, stop-string invalidation and bypass modes. A throwaway
checkout with a fake compiler tests the real launcher build path: idempotence,
paths with spaces, source preservation, failed builds, anchor drift and older
ABIs. These are
**not real inference or speed benchmarks**. The patch contracts are also
checked in memory against local main/Laguna checkouts when available.

Compile the real managed binaries without loading weights:

```sh
./dstudio --build-jsonl ./ds4
./dstudio --build-server-pld ./ds4
```

Before promoting batching: compare off/strict/batch on identical weights and
requests, including long outputs, tool arguments, EOS, context limits,
interruptions, cache reuse, SSD on/off and M1–M4. Require nonzero actual batches
(not just lookup hits), independent correctness checks, full output/state
comparisons, and end-to-end time including snapshot and replay overhead. Do
not publish mlx-serve's or another model's speedup as a ds4 result.

The [real-engine suite and measured results](../../extension/prompt-lookup/bench/README.md)
now cover 78 attempts on one M2 Max with Minecraft running and SSD streaming
off. Chat benefited in that shared-host run; Agent was roughly unchanged
overall, and Cowork's existing final-newline failures remained. This does not
replace the broader promotion checks above. Batch mode remains opt-in.
