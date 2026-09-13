# q36 Metal runtime candidate

This patch repairs native computation, model identity, conversation rendering
and HTTP image handoff for the Qwen27B candidate. The explicit CLI installer,
downloader and experimental Chat/model picker are integrated. Agent/Cowork
are connected to the resident model but their real-tool qualification is
still in progress. Full language-model, session/vision, numerical-reference,
desktop and other-backend qualification remain open.

Historical `runtime.patch` base: [`Ninnix/q36` at `d67687ed15ad9f52b755a9b5fdfc0214ea937555`](https://github.com/Ninnix/q36/tree/d67687ed15ad9f52b755a9b5fdfc0214ea937555).
The GPU header blob is `27e0000128e353d82d4ba730ac64435919f48e93`.
Upstream attribution and the full MIT terms are retained in [LICENSE](LICENSE).
Historical patch SHA-256: `75764a9fcca0af2e60d937266b9bb02f0b4be394623b6a8509a74f30bf3dd0df`.
The previously failing batched cache/decode regression passes on the earlier
`aa26ffa9…` revision, including private restoration and the 35-stage native gate.
The owner-channel revision passes its own 36-stage native gate, 52 process/
protocol checks and five real-model lifecycle checks (including two exact text
answers). Prior results are not automatically attributed to changed sources.
Full multi-session inference, application lifecycle and quality qualification
remain distinct requirements; the earlier 11/12 answer baseline is still FAIL.

## Reproducible application

The installer candidate now uses [next-review.patch](next-review.patch) on
[`8362010a301b3360296e435703f58ffc230a024a`](https://github.com/Ninnix/q36/tree/8362010a301b3360296e435703f58ffc230a024a).
It then applies the [terminal monitor and owner patches](../q36-agent-tty/README.md),
followed by [cache-usage.patch](cache-usage.patch), in that order. The installation receipt records all patch/script hashes and
the patch order; preparation revalidates those inputs and the installer itself
before durable publication. Fresh network installation passes alongside main
(`engine-acceptance/run-jVF1xy`), followed by 14/14 real DStudio host/tool checks
(`q36-host-live/run-pkigpi`) with unchanged inputs and owned processes stopped.
These cover Chat, native Agent repair, Cowork spreadsheet read-back and four
tool images, not the full quality/mode/desktop matrix. The managed-install
HTTP replay `q36-http-vision-live/run-oGEVFX` also passes 46/46 image/tool/cache
cases with unchanged inputs and native exit 0. The installer preserves
existing divergent installations. Reviewed old installations now have a
separate atomic upgrade path; its current evidence and limits are in the
[upstream checkpoint](../../docs/DS41_UPDATE_CHECKPOINT.md). No model, app or
non-Metal qualification follows from a pin change.
The same patch also applies to the preceding `8ce8924` core/server revision;
that is the base of the real-model receipts below. Apply it to pristine source,
**not** on top of `runtime.patch`.
Review patch SHA-256: `5d3ccc8ad93f10965e6c93f83ee0c132d396c9b68890beb15138a502d9dcbef6`.

### Committed text-cache usage receipts

`cache-usage.patch` is a separate overlay reviewed on exact upstream
`8362010a301b3360296e435703f58ffc230a024a` with `next-review.patch` above.
The actual old-to-new inference test found that text restored from disk was
used correctly but every HTTP receipt reported zero reused tokens. In-memory
text reuse had the same defect. The overlay publishes the computed count only
after successful owner-side text-session publication. Image-conditioned
preparation retains its own count. Responses' initial `response.created`
event keeps its zero-usage placeholder; only its terminal receipt claims the
completed request's usage. No tensor, precision, KV format or hot-record layout
changes are introduced.

`make test-q36-cache-usage Q36_SOURCE=/path/to/installed/q36` copies bounded,
hash-verified engine sources into a private artifact directory. Twelve stages
exercise apply/repeat/check/restore, every partial hunk, drift and alias/ABI
rejection, preservation of unrelated edits, and real native object dependency
invalidation. It also runs the existing owner/cache regressions plus JSON/SSE
usage checks for OpenAI completion/chat, Responses and Anthropic, each cold,
disk-backed and with both in-memory prefix paths. Numerical session work is
simulated; the native generation path, HTTP serializers, files and
ASan/UBSan checks are real. This is not a language-model quality benchmark.

The unchanged final assertions reproduce **54/78 PASS, 24 FAIL** before the
overlay (`q36-http-text-prepare/run-DbNrrM`), then **78/78 PASS** in single mode
(`run-7tdelm`) and **68/68 PASS** in batched mode (`run-7e76tr`). The full patch
gate passes **12/12** (`q36-cache-usage-patch/run-4DUukX`). Earlier harness
receipts are retained: one omitted streaming usage from its request, and one
mistook the initial Responses placeholder for terminal usage. Both comparisons
use the corrected observable requirements, not removed failures.

```sh
Q36_DIR=/path/to/q36-8362010 sh scripts/apply-q36-metal-runtime.sh apply cache-usage
Q36_DIR=/path/to/q36-8362010 sh scripts/apply-q36-metal-runtime.sh restore cache-usage
```

Restore this overlay **before** restoring `next-review.patch`. The installer
applies it after the monitor/owner stack and records its exact hash and order.
Real-model cache reuse and full mode/desktop qualification are separate gates.

### Earlier runtime evidence

The server conflicts are resolved. On the prior `03dfcf3c…` review, the complete
Metal CLI/server/native test build passes and `q36-metal-runtime/run-J6CLJ5`
passes all 41 lifecycle, native
control/cache/tool and Metal operator stages on M2 Max; original failed
harness receipts remain. The subsequent `run-GZfZjK` passes all 42 stages,
including the actual pinned Qwen27B projector against the native scalar
encoder: 15,385 assertions, maximum absolute error `0.001709` and relative L2
`0.00002601`, within the unchanged bounds. It does not load the language model.
It is not selected by the installer and is not a qualified model
runtime. Its private visual-session copy, native image continuation, per-call
reasoning metadata and version-3 disk tool map now have new deterministic
regressions. The actual Qwen27B HTTP run `q36-http-vision-live/run-vf7idm`
passes 40/40 workflows, including all 28 prior scenarios and real authenticated
image/tool continuation across OpenAI, Responses and Anthropic. Changed tool
pixels change the exact answer; omitted historical pixels retain their matched
live prefix. Full quality, long-context, disk-cache and application qualification
remain open. Old receipts do not qualify this changed source. See the
[update checkpoint](../../docs/DS41_UPDATE_CHECKPOINT.md).

The subsequent disk-cache run `q36-http-vision-live/run-MO5enE` on `03dfcf3c…`
is **43/46 FAIL**.
Existing checkpoints survive Stop unchanged, but the image-to-text transition
does not stage the cold text checkpoint required by the continued-cache tests.
The trace also shows the native no-thinking canonicalizer stripping a prelude
that the preserved-reasoning template retains. Both original failures remain;
the subsequent corrections keep the original cache/continuation requirements.

The `582f57e7…` correction sends independent text after images through
the existing private text/checkpoint transaction. Only new pixels or matching
pending tool IDs select image continuation. Text token/byte matches cannot
borrow image-conditioned state; pending IDs retire only after successful
publication, and every text commit revalidates the admitted job. The native
checkpoint gate now respects preserved reasoning, including empty preludes.
The opt-in trace distinguishes image-state rejection from a token mismatch.

Its expanded HTTP/cache regression passes **35/35** with the fix
(`q36-http-text-prepare/run-UtpMgF`) versus **30/35** before (`run-NQKZq2`).
It executes native generation, cache files, parsing/rendering and publication
with simulated session work and deterministic barriers, not model answers.
The old pinned ABI retains its 24 passing applicable cases (`run-Ks9i0J`).
An intermediate fixture accidentally provided an independently valid text
checkpoint for its matching-image-token case; its failed receipt remains, and
the corrected distinct-file fixture is applied to both comparison variants.
The complete `582f57e7…` gate passes **42/42** (`q36-metal-runtime/run-lS3fD1`),
including the original scalar/projector comparison. The native renderer also
matches all 32 original GGUF template cases (`q36-chat-template/run-79jg4pky`).
Its real cache run `q36-http-vision-live/run-6jY0tA` is **45/46 FAIL**: image
transitions, exact memory-token reuse, disk restore and continuation after Stop
pass, but starting the cancelled request saves a newer prior live checkpoint
before the replacement commits. All four existing files stay byte-identical;
one additional file appears. The strict unchanged-directory assertion remains.

The current `5d3ccc8a…` correction moves that eviction save after successful
owner publication, outside shared locks and before retiring the old session.
Failure/cancellation cannot publish or evict disk files for an uncommitted
replacement. A successful replacement still saves the newer old session,
without assigning its disk frontier to the new session. Eleven new barrier
scenarios reproduce the issue in both scheduling modes. Single-session cases
go from **35/46** (`run-PZbA0t`) to **46/46** (`run-c8NFg4`); batched cases go
from **25/36** (`run-Y9Ku4N`) to **36/36** (`run-E66nSW`). Those receipts are
under `q36-http-text-prepare`, with simulated numerical work, ASan/UBSan and
actual cache files; successful retirement reloads the exact prior fixture
tokens/logits. No failure, timeout or model answer was removed or regraded.
The server/slot/progress/trace records remain 3,848/256/112/160 bytes on arm64;
no hot record grew. This final patch passes the complete **42/42** native and
actual-projector gate (`q36-metal-runtime/run-w0clga`), with final input hashes
unchanged. Native rendering also matches **32/32** original GGUF histories
(`q36-chat-template/run-gtvwb8u2`). The corresponding real-model replay
`q36-http-vision-live/run-fSs5iW` passes **46/46**, including all original image,
tool, checkpoint and Stop cases. All four committed files remain byte-identical,
and the uninterrupted/after-Stop decisions both reuse the exact 1,302-token
live prefix for the 1,326-token prompt. The engine exits 0 and all captured
inputs remain unchanged. This is an 8k-context Metal development regression,
not complete model quality, long-context, DStudio Agent/app or another backend.
The installer remains on its old pin; the historical failures above remain.

The fresh `8362010` checkout independently passes **42/42** stages in
`q36-metal-runtime/run-0Ykf7q`, including the real projector/scalar comparison
and final unchanged-input check. Receipt SHA-256:
`eb7fe695f41456419eb0bea803d16e81d28171282783aaba6e2e17faf071f6af`.
The upstream Agent exit-save and web-link changes are preserved, with the
separate [monitor terminal adaptation](../q36-agent-tty/README.md). This gate
does not load the language model or transfer the earlier 46/46 inference
receipt to a different revision. Full quality and long-context remain open.

The review patch includes the native test's schema-argument adaptation and
the [historical-prelude test scenario](../q36-upstream-tests/prelude-scenario.patch).
Do not apply that scenario a second time. The macOS Agent test header correction
remains separate and test-only.

Explicit review commands (no managed pin change or weight download):

```sh
Q36_DIR=/path/to/q36-8362010 sh scripts/apply-q36-metal-runtime.sh apply next-review
node tests/integration/q36_metal_runtime_test.mjs /path/to/q36-8362010 --next
Q36_DIR=/path/to/q36-8362010 sh scripts/apply-q36-metal-runtime.sh restore next-review
```

The default script invocation continues to use the prior pinned patch. The
review gate records the selected patch and all source hashes, rehearses its
complete lifecycle, and includes version-3 persistence and native visual-copy
checks. Running the command is not itself a passing receipt.

One complete [runtime.patch](runtime.patch) applies atomically to the pristine
base: `q36.c`, `q36.h`, `q36_metal.m`, `q36_server.c`, `metal/recurrent.metal`,
`tests/q36_test.c`, and the new `metal/vision.metal`. The upstream test caller
passes its real request schema into the updated decoder. The patch includes
the earlier experimental MRoPE-only change;
do not apply that old delta first. No released managed q36 installation exists
to migrate. Partial/older experimental applications are rejected, not guessed
or silently repaired.

```sh
Q36_DIR=/path/to/q36 sh scripts/apply-q36-metal-runtime.sh check
Q36_DIR=/path/to/q36 sh scripts/apply-q36-metal-runtime.sh apply
make -C /path/to/q36 -j2 metal
Q36_DIR=/path/to/q36 sh scripts/apply-q36-metal-runtime.sh restore
```

Run the script from DStudio. Complete apply/repeat/restore preserves unrelated
edits; partial state, wrong GPU ABI, drift, linked files and linked source
parents fail without mutation. Git discovery is isolated from surrounding
repositories and external Git configuration. The upstream Makefile's existing
`metal/*.metal` dependency includes the new shader; its runtime loader also
accepts `Q36_METAL_VISION_SOURCE` for relocation. Neither the script nor this
patch invokes the upstream Agent or downloads weights.

## Behavior and ownership

### Long F16 attention and Metal interactivity

The 27B common-100 development replay returned HTTP 500 while preparing a
50,869-token prompt. Metal reported `ImpactingInteractivity` at token 25,344;
the later finite-output check encountered failed GPU work. It was not the
previous HTTP-client cutoff, and the log alone does not establish a separate
numerical or out-of-memory failure.

An actual, model-free Metal probe reproduced the driver error at 50k context.
The F16 path now divides independent queries into submissions with at most
8,388,608 query/key pairs, or one query when that context-bounded query alone
exceeds the budget. It retains every key, the causal frontier, the original
shader and floating-point operation order. It does not lower context, precision
or the configured model prefill chunk, and does not add a switch, worker or cache.
All tensor-view capacities and 32-bit shader strides are checked before dispatch.
Existing quantized split/GQA selection is unchanged.

The existing inference owner drains preceding dependencies, submits each tile
outside the shared accounting mutex and stops at the first failure. Submitted
buffers retain their inputs; scores are scratch reused only after completion.
An interrupted/failed operation may have written part of its private output;
the session-preparation owner must discard that candidate rather than publishing
it or retrying GPU effects. No mutex covers driver waits and no hot record grows.

`make test-q36-attention-work Q36_SOURCE=/path/to/built/q36` runs both supported
head shapes, all-query byte comparisons with single-query execution, a separate
analytic uniform-attention reference, output guards, six shortened views,
overflow rejection and failed second-submission recovery. The analytic reference
allows eight FP32 epsilons for reciprocal/multiply rounding; the scheduling
comparison remains byte-exact. The original test's unrealistic bitwise comparison
with real-number arithmetic exposed a 1.49e-8 rounding difference; both baseline
and candidate use the same corrected analytic bound. The original receipts remain.

On this M2 Max shared host, a preliminary four-case probe reduced the longest
50k-context command from 473 ms to 48 ms, but total operator time rose from
495 ms to 1,085 ms. These are single-sample operator observations, **not an engine
speedup or proof of full long-context completion**. The original GPU failure and
the 31 nonconforming model answers are not erased. Full-model replay and broader
numerical/backend qualification remain open.

The actual full-model replay with this patch still fails: case 88 reports
`ImpactingInteractivity` in full-attention layer 23 at token 26,240 after
830.63 s. Case 89 subsequently hits its unchanged 900-second deadline. Thus
the query-tiling change **does not yet fix full-model long-context execution**;
the next diagnosis must distinguish preceding queued work from the attention
submission itself. The live run is kept immutable and continues its remaining
cases using recorded, bounded test-owned process restarts, without retrying a
failed case. Operator PASSs are not substituted for this failed model evidence.

### Qwen conversation format, including empty reasoning

The renderer retains an empty `<think>` block wherever the original embedded
Qwen template requires one. Omitting that block changes the model input; a
real 27B Agent trace showed the next tool round diverging from the live prefix
and repeating the full prefill. The correction applies equally to cold and
cached requests, without rewriting the generated answer or inventing cached
tokens. The KAT renderer and engine numerical paths are unchanged.

`make test-q36-chat-template` executes the native parser/renderer with
ASan/UBSan and compares its entire output with the actual Jinja templates read
from existing Qwen3.8-27B and Qwen3.6-35B GGUF metadata. Eight histories and both
explicit `preserve_thinking` values produce 32 cases: the preceding source
fails 18, while this correction passes all 32. These are thinking-off format
regressions, not 32 model answers or a claim about every thinking profile.
The earlier real Agent timeouts and the 11/12 answer-quality failure remain
recorded; template parity alone does not qualify Agent/Cowork or prove a speedup.

### Tool argument types and exact replay

Qwen parameters declared as strings retain their literal bytes, even when they
look like JSON arrays, objects, numbers, booleans, null or quoted strings. A
real Cowork trace produced correct spreadsheet data, but the preceding parser
converted the `sheets_json` string to an array; DStudio correctly rejected it.
The correction follows the tool schema, not a special case for Excel, and does
not loosen DStudio's tool validation. Explicit non-string parameters retain
their JSON types; absent or ambiguous union types keep the existing decoder.

The final decoder, incremental OpenAI SSE and RAM/disk replay use the same
request-owned string-type hints. Replay still requires exact semantic identity,
call order and owner-side generation checks. A changed incoming argument cannot
be replaced by cached text. Schema parsing and replay comparison remain outside
the cache lock; no new cache or global schema state is introduced.

On arm64, the existing property-name array now uses 16-byte descriptors instead
of 8-byte pointers. Its lifetime and geometric capacity remain those of the
request's actual schema properties; `request` stays 168 bytes and a schema order
24 bytes. An active tool stream grows from 88 to 96 bytes for a borrowed schema
pointer; the request outlives the stream. No model/session/GPU layout changes.

`make test-q36-tool-schema` exercises 22 explicit output fixtures with 1-, 7-
and 8,192-byte delivery fragments: 66 cases with ASan/UBSan. It checks actual
OpenAI, Responses and Anthropic output arguments, mixed consecutive tools,
nested schemas, literal whitespace/Unicode and real native RAM/disk-map replay
in both single and batched modes. These are deterministic protocol regressions,
not 66 LLM answers. They are also required by the full native Metal patch gate.

### Private resident-engine supervision

The optional internal `--dstudio-owner-fd N` accepts only an already-connected
Unix stream socket numbered at least 3. Standalone operation without this
option is unchanged. Supervision starts before model loading, retains one
detached control thread and no model/session pointer, and marks the socket
close-on-exec. Only the parent owns the peer endpoint; it must not leak that
endpoint into other processes.

After engine and session creation and a successful listen, the server writes
one newline-delimited JSON `ready` receipt, capped at 1,536 bytes, with schema
version 1, its PID, bound IPv4 host/port, actual context, native family/backend,
KV formats, effective expert streaming, and model/projector/MTP file identities.
Each file identity contains device, inode, size, mtime seconds/nanoseconds and
ctime seconds/nanoseconds **from the opened descriptor**, not a fresh lookup of
the requested pathname. Missing optional components have empty identities.
The startup-only core snapshot is not canonical state or a model cache.

The parent must validate the receipt against its pending launch identity and
request before publishing readiness. Logs or an unrelated listening process
are not this receipt. A full/broken channel fails startup instead of blocking
inference/control indefinitely. EOF or unexpected owner-to-engine bytes invoke
the normal SIGTERM drain; if loading/draining remains blocked, the guard exits
only its own engine after three seconds. No arbitrary external PID is signaled.
This does not undo tools, promise completion of interrupted work, or persist a
checkpoint before its real durable write. Host routing now validates and owns
this resident PID/lease; the private option alone remains insufficient evidence
of application-mode or real-model quality qualification. See the
[Qwen checkpoint](../../docs/QWEN_CHECKPOINT.md) for the separate host evidence.

### Native computation and preparation

- Dense CPU FFN gate/up projections reuse prepared activations only when their
  formats match. A mixed K-quant/Q8_0/plain pair needs a new preparation for the
  second matrix; the input bytes must not be reinterpreted as another format.
  Existing matching-format fusion remains intact; no new allocation or pool.
- Metal Q extraction, recurrent V extraction and convolution history honor
  both pinned shapes: 16/24 attention heads, 4,096/6,144 V values and
  8,192/10,240 convolution values. Oversized/overflowing and undersized requests
  fail without partially changing the destination/history. The existing engine
  owner selects the shape; buffer capacity is not model identity.
- Native model discovery reports `qwen3.8-27b` and `Qwen 3.8 27B` for the dense
  candidate, while preserving Qwen3.6 MoE and KAT identities. Correcting metadata
  alone does not repair inference.
- Text and vision synchronization reject an already-cancelled request before
  resetting session state or accepting a cached prompt. Invalid input still
  fails validation without changing state. This is the admission boundary,
  not an atomic mid-prefill rollback in the in-place core API. The single-session
  HTTP image and text paths now prepare private sessions, including batched
  text/cache continuation. App lifecycle and broad multi-session qualification remain.
- MRoPE rotates the first 64 dimensions of each 256-wide head using the
  interleaved temporal/height/width positions. The remaining dimensions are
  untouched. FP32 frequency recurrence follows the pinned Vulkan operation;
  precise trigonometry is necessary at long positions. The initial fast-trig
  run failed the original `1e-5` absolute tolerance; it was not widened.
- Position uploads use transient private tensors. The existing upload boundary
  drains the previous command before reuse; submitted command buffers retain
  their resources after the temporary owner is released.
- Projector matmul reads the exact F16 tensor from its file descriptor and
  offset on **every** invocation. A short/failed read cannot enqueue an output
  write. Activations and accumulation remain FP32; no activation downcast or
  cached result substitutes for computation.
- Projector attention retains 16 heads of width 72, noncausal all-patch
  attention and stable online softmax. Preprocessing, positional embeddings,
  layer norm, GELU and residual paths remain upstream-native.
- The vision scratch buffer belongs to the existing single inference owner.
  It is not a weight cache: no source identity can produce a cache hit. It has
  a 64 MiB cap and lives until resize or GPU cleanup. Resize prepares at most
  one candidate, allowing at most 128 MiB transient scratch; failure preserves
  the earlier buffer. Rows are limited to the encoder's 1,024 patches, widths
  to the pinned 5,120-wide merger. Aliasing output/input and undersized views
  are rejected before dispatch. No extra worker or queue is introduced.
- Command-buffer allocation occurs outside the shared accounting/publication
  mutex; a short revalidation rejects an obsolete queue and a racing loser
  cannot replace a published buffer. This does not make all upstream GPU APIs
  concurrently callable: init, dispatch and cleanup retain their single-owner
  contract. Driver work, file reads, waits and tensor retirement do not run
  under that mutex.

Despite its name, upstream `q36_engine_uses_vulkan_runtime()` already accepts
both Vulkan and Metal. The former error wording was misleading. Metal instead
lacked the MRoPE implementation (breaking the fresh link) and used CPU-only
projector matmul/attention. The patch supplies and routes those GPU operations.
Full-model image spans now pass four original pixel fixtures plus four text
recovery checks and four pre-cancelled requests on Metal. These small development
direct-core regressions alone do not establish the required held-out vision
quality or HTTP/app support. Separate HTTP evidence follows below.

## Native HTTP images and private preparation

The server accepts PNG/JPEG base64 data URLs in OpenAI Chat user content, keeps
their order among text blocks and passes actual bytes to its native decoder,
projector, tokenizer, image spans and MRoPE. Typed byte positions bind each image;
literal marker text cannot acquire someone else's image. Remote/file URLs,
unsupported content/roles, ambiguous blocks, malformed base64 and embedded NUL
are rejected. Anthropic/Responses image inputs and batched vision are still
explicitly unsupported, not silently converted to empty text. Use the new native
server option `--vision /path/to/the/matching-projector.gguf`.

Image requests and transitions from a visual session back to text prepare at
most one candidate session with the same weights and configured context. Native
encoding/synchronization and retirement run outside the publication mutex. The
single inference owner revalidates the previous session identity, shutdown and
context before swapping. Progress from the candidate cannot write a live disk
checkpoint; text-only KV keys never represent pixels. Control metadata reads
immutable context rather than a replaceable session pointer.

Request ownership bounds: at most eight images, 8 MiB encoded bytes each and
32 MiB aggregate, within the existing 64 MiB HTTP body limit. Sixteen generation
leases are admitted after bounded headers and **before** retaining/parsing the
body. Four additional header/control threads remain available at that limit;
control bodies are capped at 1 KiB, headers at 64 KiB. Header/body receive phases
each have a ten-second deadline; admitted jobs have a 900-second deadline.
Image buffers live until their client-owned job completes; temporary
embeddings/tokens/session state are freed on preparation failure. This bounds
overload rather than promising admission when all twenty connections are busy.
Compiled arm64 layout versus the pinned base: request 160 → 168 bytes, message
56 → 64, job 296 → 336, server 800 → 816; slot 216 and HTTP header record 280
remain unchanged. Image bytes are not embedded in these records; an optional
request ID has at most 65 allocated bytes including its terminator.

On macOS, `POLLHUP` also occurs after legal TCP `SHUT_WR`, when the client still
reads the answer. Cancellation now checks the actual socket error instead of
treating every hangup as an abort. A TCP reset, job deadline or shutdown still
interrupts private work. FIN alone cannot identify an abandoned response;
explicit cancellation is described below. This is not a claim of general
rollback after arbitrary generation/tool effects.

The native parser/ownership gate has 47 cases with ASan/UBSan. Eleven ownership
cases use a simulated worker and deterministic barriers, checking previous-state
integrity, responsive real metadata serialization, stale candidates, allocation
failure, shutdown, TCP reset, half-close and explicit request cancellation.
A separate actual-model HTTP run passes 21/21: original pixel counterfactuals,
two-image ordering, malformed PNG, text recovery, completed JSON/SSE responses,
TCP half-close, cancelled upload/image preparation and finished-request cleanup.
The original 44/45 model-free failure and 14/16 actual-model failure remain in
their receipts, alongside the newer 19/21 cancellation RED. No timeout or answer
oracle was relaxed to fix them.

Historical patch SHA-256: `6b7f295b5d489c255d5e2132afd2756562a9abce9f6edbf5cc68858071d406a9`.
Fresh network install and the then-complete 30-stage Metal patch gate passed on
that revision. These are development regressions, not 100-case language quality,
30-PDF/20-image qualification, numerical architecture parity or DStudio modes.

## Native request cancellation

Send a fresh, opaque `X-DStudio-Request-Id` header for **each attempt**, using
1–64 ASCII letters, digits, hyphens or underscores. Do not reuse an ID for a
retry. A duplicate live ID fails before body processing. The owner registers
the identity before receiving the rest of a generation body and removes it
before the client-owned job can be freed. The bounded live list is not a cache
or a second conversation store; no tombstone or unbounded history is retained.

`POST /v1/requests/{id}/cancel` takes an empty body. A `202` response with
`cancellation_requested: true` acknowledges the request to stop, **not** a
completed stop or undo. `404` means the ID is not currently admitted/active;
it must not be reported as a successful cancellation. This is local engine
control, not a new authentication boundary. DStudio's host must still bind a
fresh ID to its owned run and reconcile admission races before exposing Stop.

Cancellation during upload returns `499`. A queued job is removed and completed
without waiting behind another generation. The active worker observes an atomic
cancellation flag, and private vision publication revalidates it under the
owner mutex. Network replies, parsing, inference and retirement stay outside
that mutex. An interrupted turn cannot publish executable tool calls even when
the model produced a syntactically complete call; raw failed output is retained.
Previously streamed bytes cannot be retracted and never authorize an action
without a successful terminal result from the owning application loop.

The original nine native HTTP control scenarios use deterministic receive barriers,
ASan/UBSan and simulated tokenization/queue work where specified. They cover
receiving, queued and active requests, another request remaining unaffected,
duplicate IDs, malformed framing, capacity reclamation and error/tool delivery.
The old control gate failed all three initial cases; the separate complete-tool
regression failed before its fix. Both RED receipts remain available locally.
The current gate adds seven tool-replay/diagnostic ownership scenarios below,
for sixteen total; it does not relabel simulated workers as model inference.

HTTP text/cache preparation is now transactional as described
below. This does **not** implement Stop in the DStudio host adapter.
Mid-kernel vision work stops at native cooperative boundaries. Full host wiring,
stale late-response reconciliation, sustained-pressure/terminal-race qualification,
broader disk-cache qualification and the four application modes remain required work.

## Private native text preparation

`q36_session_prepare_sync` prepares a separate session while preserving its
source. On a prefix hit it copies active KV rows, recurrent state and logits
directly, retaining the original token history and prefill boundaries. It does
not re-tokenize/recompute the cached prefix, convert cache precision, stage KV
on SSD or copy weights. A replacement prompt starts from a private empty state.
The returned candidate is not authoritative: its single inference owner must
revalidate the run/session identity and cancellation before publishing it.

There is at most one candidate per owning operation, in addition to the source;
the caller retains that bound. Allocation uses the same context and native
initial-capacity policy, so this does require an additional session's memory.
The source must remain exclusively owned and immutable throughout preparation.
Changes to prefill/layout/cache settings are rejected; callbacks belong only
to this attempt and are cleared before returning. Cancellation, including in
the final progress callback, frees the private candidate without changing the
source or the output pointer. CPU/session allocation failures return errors
instead of terminating the process; there is no silent in-place fallback.

The ASan/UBSan gate covers 2,070 initialized-CPU scenarios, including allocator
failures at every allocation, cancellation boundaries and all nine K/V format
pairings. At fixed active rows, changing context capacity from 64 to 4,096
does not change counted copy bytes. These are state fixtures, not CPU forward
inference or GPU/MTP numerical qualification. A separate real 27B/Metal run
passes seven preparation cases: all source payload bytes survive; successful
replacement/extension/cache hits match direct native payloads and finite logits
byte for byte, including four subsequent decode steps each. No forward work is
performed for an exact cache hit. The direct in-place baseline and the later
configuration-revalidation failure remain recorded with unchanged assertions.

HTTP visual-to-text transitions consume this native API. Generic single-session
text preparation uses its new `q36_session_fork_for_prompt` phase before native
cache/prefill work: allocation and exact active-prefix copying without forward
inference. Token-history capacity is reserved recoverably before native prefill;
allocation failure cannot abort the process halfway through a prompt.
Connecting cancellation to DStudio's host remains necessary. The original
`q36_session_sync` is still an in-place native API; neither it nor token-only
snapshots acquire transactional semantics merely because this API exists.

## Private native payload restoration

`q36_session_prepare_load_payload` restores into one private candidate sharing
the source engine and its context/precision. The caller retains exclusive
ownership of the immutable source and must validate the cache identity, request
and cancellation before publishing the returned candidate. Allocation, file
reads, GPU writes and retirement must occur outside shared state locks.

Reads check cancellation between at most 64 KiB transfers, including a final
check after the last byte. Invalid headers/tokens, incompatible cache settings,
short reads and allocation failure leave the source and output pointer intact.
An interrupted restore returns `Q36_SESSION_SYNC_INTERRUPTED`; it cannot silently
fall back to modifying the live session. Callbacks are cleared before return.
The caller still owns the FILE and its cursor; the API neither closes nor
rewinds it. Native full payloads restore KV/recurrent state. Legacy token-only
payloads explicitly retain their native prefill replay, not a claimed KV clone.

The focused ASan/UBSan gate passes 9,757 initialized-CPU scenarios and 48,564
assertions: every truncated byte count, cancellation boundaries, all nine K/V
format pairings, corrupt headers/tokens, changed configuration, MTP policy
fields, every observed allocation failure and a multi-chunk read bound. It
checks tracked native allocations return to zero. Twelve cases additionally
exercise the actual payload writer: cancellation before/during/after the last
byte, short and failed writes, exact serialized bytes and at most 64 KiB per
transfer. GPU readback checks the same cancellation boundary; callers discard
their own incomplete temporary file. These fixtures do not qualify
forward inference, MTP numerical parity or Vulkan hardware.

The expanded real 27B/Metal probe passes **13/13** cases: seven text preparations
and six native payload cases, including a missing final byte and cancellation
at the end of a complete payload. Each case compares finite full-vocabulary
logits, all native payload bytes and four subsequent decode steps. Its retained
in-place baseline is **2/13**. The payload streams are memory-backed FILEs, not
SSD throughput measurements. The thirteen cases were rerun on the preceding
`c392ca1a…` patch, after changing native fork/reservation and payload writing.
The generic single-session HTTP cache consumer now restores privately; its
separate HTTP tests below qualify that boundary, not the DStudio host's Stop.
The delivered desktop bundle is not updated by a patch test or isolated engine
installation.

## Single-owner tool replay and real protocol continuations

The single-session HTTP worker now owns the tool-replay cache. Client threads
validate the request without reading or changing that cache. When tool IDs need
resolution, the worker reparses the captured body immediately before preparing
the session, using the corresponding OpenAI, Responses or Anthropic parser.
Only derived prompt tokens/text, image positions and replay metadata move into
the admitted request. Its captured model, sampling, output limit, stops and
reasoning settings remain unchanged. Context admission uses the resolved prompt,
because native sampled tool text can tokenize differently from canonical JSON
rendering. A pre-cancelled replay leaves the admitted prompt/cache unchanged.

In this single-worker mode, tool-map serialization, cache I/O and diagnostic
trace output no longer hold the shared tool/cache/inference/trace locks. No
server, request, slot or job field was added. Batched scheduling retains its
previous synchronization and is **not qualified by this change**; its expensive
locked paths remain architectural work, not an accepted exception. Single-session
text/cache preparation is covered below; cancellation inside a long tool-cache
scan still needs further work. This is not complete rollback or app Stop.

The ASan/UBSan HTTP control gate passes **16/16** scenarios; the same final
corpus against the preceding native server is **9/16**. Besides the original
nine controls, it exercises owner-only replay in all three parsers, captured
settings, pre-cancellation, exact-render context admission, real tool-map bytes
and native trace bytes outside their shared locks. Tokenization/worker execution
in this gate is explicitly simulated. The preceding full patch gate passed all
28 stages; text/cache transactions brought it to 29 and semantic tool identity
to the current 30 stages.

The actual-model HTTP corpus passes **28/28** on the newly installed server.
Qwen27B generates a structured `read_file` call whose arguments are validated;
the harness reads a real task-owned fixture file and sends its result back.
Each of the three HTTP formats then receives two different file results and
must return the corresponding code exactly, including case. The native trace
also proves the production generation path resolved the sampled call from RAM,
rather than merely producing a plausible answer with canonical fallback.
Diagnostics are opt-in, private and bounded by an 8 MiB observed-size watchdog
and the 600-second run deadline; these are not throughput measurements.
The original 21 image/cancellation cases remain in the denominator. The earlier
24-case OpenAI-only run is retained separately, not rewritten as three-protocol
coverage. This native transport test is **not the DStudio Agent/Cowork loop**,
held-out quality, numerical parity, disk-replay coverage or desktop integration.

## Single-session text/cache transactions

A failed or cancelled prompt now retains the previously committed session and
disk checkpoints. Native prefix selection, cache restoration, full prefill and
cold/continued checkpoint preparation run on one private candidate. Publication
revalidates cancellation, shutdown, context and session identity under the owner
mutex; inference, cache I/O, file publication and retirement stay outside it.
Exact sampled token history and the native byte/BPE suffix path are preserved.

Checkpoint files are staged privately and renamed only after successful prompt
publication. A failed rename cannot advance the stored frontier. These derived
cache files retain upstream's lack of fsync: this is atomic visibility, not a
power-loss durability guarantee or the application's authoritative journal. At most 64
pending files share the smaller of the configured disk budget and an 8 GiB
ceiling; repeated destinations are coalesced. Serialization counts repeated
tool blocks as actual disk bytes, not their deduplicated RAM size. Exhausting
this derived-cache budget omits caching, not model work or validation. Earlier
committed eviction snapshots remain valid effects; Stop is not a promise to
undo all previous work.

The model-free HTTP gate has 24 scenarios with deterministic barriers and real
cache files/socket replies: previous state/frontier retention, token and BPE
hits, disk restore, corrupt payload/count, cancellation, stale owner/context,
shutdown, allocation and write/rename failures, disabled cache, and count/byte
limits. The previous in-place server passes 3/24; the candidate passes 24/24.
An intermediate 23/24 failure exposed the repeated-tool disk-budget error and
remains recorded with its original assertions.

The real-model corpus now has an optional 34-case disk-cache run: all 28 prior
image/control/tool cases, cold checkpoint publication, disk-prefix restoration,
an uninterrupted continuation oracle, Stop during an actual private checkpoint,
and continuation after Stop. The historical single-session run passes 34/34; committed checkpoint
filenames, sizes and SHA-256 hashes survive Stop unchanged, metadata responds
within its original one-second bound, and Stop within fifteen seconds.

The initial 32/33 result is retained: its final assertion wrongly demanded a
RAM hit even though the pinned native renderer omits empty thinking blocks
from assistant history. The added **no-Stop** execution reproduces the same
changed prefix. The corrected test compares all eight native frontier/cache
decision fields against that execution and still requires the exact answer;
it neither forces stale-state reuse nor treats arbitrary fallback as a pass.
That same-harness comparison is 34/34 for its candidate and 31/34 for the
previous server. Both actually receive Stop at a native checkpoint; the latter
publishes uncommitted files and fails the original Stop deadline. An earlier
baseline that never reached the new private-checkpoint marker is retained as
an insufficient cancellation comparison, not substituted for that final run.
The latest repeat of this particular 34-case corpus belongs to patch `2ea07d80`,
not automatically the current scheduled/batched patch.

On arm64, server/job/request/slot sizes remain unchanged. The per-prefill record
grows from 104 to 112 bytes; the pending-list header is 48 bytes and each node
40 bytes, plus its bounded path strings. This is layout evidence, not a P10
latency profile or a throughput claim. This describes the text-transaction
revision; the subsequent identity records are measured below.

## Tool IDs cannot replace the requested facts

The original six-case diagnostic reproduced four failures on pristine upstream
and the text-transaction candidate: an unchanged ID could insert old names or
arguments into the prompt. Exact replay now requires the complete call list,
correct ID positions, matching names and typed arguments. Objects may reorder
their fields, including nested objects; arrays keep their order. Duplicate keys,
lossy surrogate decoding and malformed JSON cannot establish an identity.
Numbers are compared without floating-point rounding; a different numeric
spelling conservatively misses rather than claiming equivalence. Unrelated
content or reasoning cannot be prepended from a cached tool block.

Preparation pins immutable sampled text, parses/compares it and copies it outside
the shared cache mutex. Bounded owner revalidation checks the same ID generation,
block and call position before attaching it. A changed or evicted mapping rejects
stale preparation. Detached pinned blocks remain charged to the cache byte
budget and the last reader frees them outside the mutex. Cache teardown still
requires all request workers to have joined; a view never outlives its lease.

Exact recovery is limited to 128 calls per message, 256-byte IDs, 1 MiB incoming
argument bytes and sampled text, 8,192 comparison nodes and depth 64. Beyond
these optional-cache bounds, the existing native renderer keeps the complete
incoming request; calls are not dropped or replaced. Legacy v1 disk records
remain usable for single calls. They lack ID positions for multi-call groups:
ambiguous groups are not restored and are not counted as recovered IDs. The v2
format described below supplies positional identity for new group records.

The permanent ASan/UBSan suite passes **93/93**, versus **22/93** on the preceding
server using the same harness. It executes native rendering, real disk-map
write/read, changed/missing/extra fields, types, large integers, nested JSON,
call ordering and bounds. Deterministic barriers prove independent preparations
can overlap, owner work remains available, and replaced/evicted entries cannot
commit a stale result. Two upstream cache tests had endorsed changed-command
substitution; their positive disk round-trip is preserved and extended with
the required non-substitution case. Original failing receipts are retained.

The semantic-identity revision passed the **30-stage** patch/build/operator gate and
the **34/34 actual 27B HTTP/cache** corpus. These are regressions, not general
language quality, numerical equivalence or a DStudio Agent workflow. On arm64,
block size stays 48 bytes, entry grows 64 → 72, cache 72 → 80 and server
816 → 824; request/job/slot stay unchanged. Storage follows retained entries,
not the configured ID ceiling. The opt-in control-profile probe also measures
the native replay path; instrumentation is not compiled into production.

## Grouped disk maps and bounded tool-cache publication

New v2 records retain the entire sampled tool group once, with an explicit
ordinal for every ID. Single calls, consecutive groups and groups embedded in
a conversation survive a real file round-trip after their RAM cache is freed.
Incoming names, arguments and ordering still undergo the semantic validation
above. Historical disk entries cannot replace an already retained RAM identity.
The complete file is parsed and checked before admission: truncated records,
invalid ordinals and duplicate IDs across groups cannot partially import an
invalid map. Allocation/admission failure remains an optional cache miss, not
permission to drop a tool call or change its arguments.

Two cache-specific intrusive hash indexes replace allocation-heavy radix-tree
updates under `tool_mu`. They require a fixed 256 KiB of lazily allocated pointer
tables on arm64, independent of the configured ID ceiling. Payloads remain
bounded by the existing retained-entry/512 MiB budget. Chains are limited to
32 records and an insertion can retire at most 64 old entries; a larger required
eviction or full chain rejects before pruning. New nodes/text are prepared
outside the mutex, then identities are revalidated before bounded publication;
retired payloads are freed outside it. A digest narrows lookup but never proves
byte equality. Pinned, detached text remains charged until its last reader exits.

A private map is bounded to 64 MiB serialized data, 4,096 groups and 100,000 IDs,
with 1 MiB text per group and 256 bytes per ID. Temporary ID storage reserves
at most 26.4 MB plus group metadata; its pinned text is already charged to the
cache. ID copies use at most 16 records per owner visit. Text scanning, hashing,
allocation and file writes occur outside `tool_mu`; cancellation and identity
changes discard preparation. The checkpoint writer uses the same snapshot for
its byte budget, extension flag and serialization. Existing-file updates prepare
a bounded private replacement and revalidate the destination before renaming;
write/cancel/stale failures preserve the previous file and remove only their
own temporary file. This is atomic best-effort cache replacement, not a new
crash-durable user-data journal; upstream's `fflush` policy is unchanged.

The new native ASan/UBSan gate passes **84/84 cases**, including an exhaustive
247-position truncation case, real group serialization, hash/eviction bounds,
allocation failures, overlapping duplicate preparations, absent/present/absent
identity races, and deterministic blocked-write/stale-result scenarios.
The original 36-case disk corpus exposed **19 failures** in the preceding
revision. The full patch/build/operator/projector gate now passes **31 stages**.
These tests do not establish language quality or DStudio Agent integration.

Arm64 layouts change from the preceding revision: entry 72 → 88 bytes, block
48 → 96, cache 80 → 72 and server 824 → 816; request/job/slot are unchanged.
The opt-in `--tool-store` microprofile measures both real rebindings and file
writes at 1/16/256 KiB, with 128 repetitions and two configured ID ceilings.
In the recorded run, time holding `tool_mu` stopped growing with text size,
while total preparation became slower. Both results and original failures are
retained; this is not an inference speedup or a public throughput benchmark.

At that revision the outer batched disk-cache locks were still open. The
following tranche fixes their I/O ownership. Cancellable directory scans,
recoverable parser allocations, host modes, broad quality, desktop and
other-backend qualification remain open.

## Batched checkpoint scheduling and private restoration

The native server no longer holds its cache mutex or backend owner across disk
reads/writes. A bounded catalog-leader claim protects the derived index, while
the existing model scheduler lends the backend for each state transfer. A busy
catalog may omit optional caching, never a request or tool effect. No worker
queue or second state store was added; the obsolete inference mutex was removed.

`q36_session_save_payload_scheduled` is the native prerequisite for separating
that work. The caller keeps its checkpoint exclusively owned and immutable for
the entire save. A paired enter/leave callback borrows the backend command owner
only for a GPU readback, at most 64 KiB. Conversion and output occur after leave;
callbacks must not retain a shared mutex. Successful acquisition is balanced
even after a read failure or cancellation arriving during admission. Rejected
admission is not released as if ownership had been obtained. Invalid callback
pairs fail before output. The original save API uses the same writer without a
borrow callback, preserving its existing single-owner contract and wire format.

`q36_session_prepare_load_payload_scheduled` constructs a native private session
with the same weights, context and runtime configuration. Initialization and
uploads yield between transfers of at most 64 KiB. Allocation and disk reads do
not borrow the backend. The owner rejects cancellation, corruption, stale slot/
job identity or a pending decoder before publishing the pointer. Earlier state
and files survive failure; native buffers are retired outside publication locks.
Full payloads restore actual KV/recurrent values, not token-only approximations.
Legacy token-only input still runs native prefill in configured native chunks.

Continued prefill checkpoints are saved after releasing the backend at their
exact aligned frontier, not inside the GPU progress callback. Scheduled logits
readback also precedes host sampling, and checkpoint rewriting uses the existing
prefill owner. The logits materialization cost still needs real profiling; this
is not a claimed decoding speedup. The writer uses bounded stack buffers rather
than a whole-payload host copy; restore keeps one private native session per
catalog leader. Arm64 layouts: access descriptor 32 bytes, writer 40, server
824 → 760 after removing the unused mutex. The slot grew from 216 to 224
when job identity/prefill handoff were added; restoration adds no further growth.
GPU tensors, native wire bytes, precision and context are unchanged.

- **186/186 native Metal-buffer cases**, ASan/UBSan on the host probe: both
  shapes with four layers, nine K/V pairs, F16/F32 recurrent conversion, exact
  wire oracle, scheduled logits, bounded reads/writes, allocation/device/file
  failures and early/mid/late cancellation, plus scheduled native forks,
  retained hidden state and exact active-row copies across private KV growth.
  Real independent GPU operations
  proceed at blocked input/output barriers through a **scheduling fixture**;
  this is not model inference or server scheduling.
- **8/8 actual server scheduler/cache scenarios**, simulated numerical state:
  blocked write/read, exact prefill frontiers, cancelled write/read, stale
  restoration, corrupt input and final shutdown persistence. Other-slot decoding completes before the
  file barrier opens. The preceding writer-only patch still fails all four
  read scenarios under the same requirements; its failures are retained.
- **24/24 HTTP transaction cases in each of single and batched modes**,
  actual generation/cache/control code with simulated numerical sessions:
  old session/frontier/file bytes survive failed or cancelled whole prompts;
  stale candidates cannot publish. The previous batched path passes only 4/24
  of these requirements. These are not model answers.
- **34/34 complete native gate**, including patch lifecycle, clean build,
  the above regressions, native operators and actual projector reference checks.
  This replaces the earlier 32/33 failing gate, not its historical receipt.

The first actual-model run on the intermediate `8079006f` patch retained all
seven correct answers but failed its cache acceptance (8/10 overall): the
harness's cold-cache ceiling excluded its own longer prompts. It also exposed
lost shutdown persistence: the stopped scheduler refused final serialization.
Shutdown now transfers sole ownership to its final thread **after** all clients
and workers have drained/joined; normal request cancellation remains unchanged.
A regression fails on `8079006f` and passes on this patch. The live harness's
ceiling now admits the same prompts and also checks the final checkpoint file,
not just a shutdown log. No prior failure or answer requirement is removed.

The subsequent real Qwen27B/Metal run on the intermediate `960b1505` patch passes **11/11**: seven exact
answers, actual disk restore after a process restart, six earlier cache files
preserved (apart from hit/last-used fields), and the final shutdown checkpoint
independently read. Both test engines exited cleanly. Settings: resident weights,
context 4,096, prefill 128, F16 KV, two slots and no expert SSD streaming. No
two-item decode batch occurred, so this is not fused-batch numerical coverage.
One restore took 19.749 seconds under competing prefill, versus about 0.94 seconds
without that contention; fairness/queue delay remains work, not a speedup claim.

### Whole batched text preparation

The current patch extends the same private HTTP transaction to batched text.
One candidate per active slot keeps the same engine, context and native state;
the previous resident session remains unchanged through disk restore, prefix
copy and all prefill quanta. Cache files stay private until the complete prompt
passes lifecycle/job/session/cancellation and decoder-handoff revalidation.
Failed candidates and temporary files are retired outside the shared locks.
Each optional catalog operation claims the existing bounded leader; contention
may omit caching, never the actual request or an earlier committed effect.

`q36_session_fork_for_prompt_scheduled` copies native KV, recurrent state, hidden
state and logits directly on device in transfers of at most 64 KiB. There is no
host/disk snapshot, precision conversion or replay of the cached prefix.
`q36_session_sync_prefix_scheduled` reserves token/KV storage before backend
admission, then extends the candidate through the native prefill routine. Its
caller retains the existing quantum and exact cold/continued-cache frontiers.
The candidate borrows its resident slot's scheduler identity; it is not a second
registered waiter or an authoritative slot. Existing single-owner APIs remain
wrappers over the same native implementation. Server/slot layouts remain 760/224
bytes on arm64; peak session memory includes at most one extra candidate per
active preparation, not another copy of the model weights.

Tests retain the initial 4/24 batched HTTP failure and the unscheduled-fork
ownership failure on `960b1505`. The new native fork also initially returned a
generic error when admission was cancelled during creation; its regression now
requires the correct interrupted status with unchanged source/output. A test
setup initially requested capacity already reserved by the native constructor
(32,768-token ceiling); it now grows initialized eight-row storage twice and
checks the same active-copy bound and every retained byte. This correction does
not change the production allocation policy or relax the assertions.

The current scheduled native API passes the same **13 real Qwen27B/Metal**
state/logit differentials as the single-owner API: replacement, extension,
cache hits, early/mid/final cancellation, full payload restore and nonempty
legacy replay. All retained state/logits match byte for byte, including four
subsequent native decode steps per case. This is a single-owner lease fixture
for numerical verification, not concurrent server execution or answer quality.

The extended HTTP corpus on this revision passes **15/15 real-model checks**:
Stop during observable prefill returns interruption, preserves earlier cache
files and retains the exact 1,905-token resident frontier. The next answer and
native cache decision match the uninterrupted control. The same harness on
`960b1505` passes only **13/15**: it acknowledges cancellation but finishes the
3,913-token prefill, returns an error inside HTTP 200 and replaces the old state.
Both revisions' test processes exit cleanly; original failed receipts remain.

The initial 13-check candidate run remains **12/13 FAIL**. Its last assertion
incorrectly required a RAM hit: the native transcript drops empty thinking
markers, so even an uninterrupted continuation uses disk KV. The permanent
control verifies this behavior on both revisions. It does not relax the exact
resident-frontier, response, interruption or cache-file preservation checks.

Still open: bounded directory/parser work, real critical-path profiling and
full-model multi-session coverage. The Vulkan source was inspected: its allocator still
performs driver/large-memory work under its internal mutex. This is a separate
architectural defect to fix and verify on that backend, not permission to
claim Vulkan/AMD parity from Metal. CUDA is not qualified by these results.

## Cross-session recurrent scratch lifetime

The real upstream 1/2/4/8-session oracle on `1677e0f6` failed both F16/F16 and
Q8_0/Q4_0 KV phases. The last four rows of the eight-row batch had logit errors
up to 9.62949; one quantized-KV row also selected a different next token. No
batch size was removed and the upstream absolute bound remains 0.25.

At the pinned upstream base, recurrent Q and K are views of the full QKV
panel. A row-by-row convolution/delta loop therefore writes K into projections
of later sessions before their convolution consumes them. This exists in both
Metal layouts and the shared dense Vulkan path. The fix completes convolution
for every admitted row before any delta-net Q/K writes. Per-session history
ordering is unchanged; no extra activation allocation or session cap is added.

The permanent real-Metal, synthetic-weight differential executes the native
batch function with the production aliases versus independent Q/K storage.
Across 96 cases (1..8 rows, 8/16 capacity, both recurrent shapes, fused/unfused/
mixed convolution, two steps), `1677e0f6` fails 24 cases and 336 assertions.
`aa26ffa9` passes all 9,216 assertions with exactly equal output and state under
ASan/UBSan. Original failures are retained. This is a lifetime regression, not
answer-quality evaluation or runtime qualification of Vulkan/AMD.

The rebuilt, network-installed `aa26ffa9` then passes the unchanged real-model
upstream test in both KV modes: all 30 full-vocabulary comparisons across
1/2/4/8 rows, all next-token choices and the payload/invalid-input/ordered
fallback assertions. Maximum absolute error is 0.00828552 with F16/F16 KV and
0.214759 with Q8_0/Q4_0, within the original 0.25 bound (not bitwise parity).
Both native processes exit successfully. The complete patch/runtime gate is
35/35, including the real projector check. This is focused numerical evidence,
not broad model quality or application-mode acceptance.
The real HTTP cache/Stop corpus is repeated on the rebuilt server and passes
15/15, including the exact retained frontier and uninterrupted control; both
test-owned server processes exit cleanly.

## Behavioral evidence

```sh
make test-q36-metal-runtime Q36_SOURCE=/path/to/pinned/q36
make test-q36-metal-runtime Q36_SOURCE=/path/to/pinned/q36 QWEN27_PROJECTOR=/path/to/Qwen3.8-27B-mmproj-F16.gguf
make test-q36-dense-quant test-q36-catalog Q36_SOURCE=/path/to/patched/q36
make test-q36-recurrent-batch Q36_SOURCE=/path/to/patched/q36
make test-q36-session-batch-live Q36_SOURCE=/path/to/installed/q36 QWEN27_MODEL=/path/to/Qwen3.8-27B-UD-Q6_K_XL.gguf
make test-q36-tool-replay-identity Q36_SOURCE=/path/to/patched/q36
make test-q36-tool-map Q36_SOURCE=/path/to/patched/q36
make test-q36-cancel-admission Q36_SOURCE=/path/to/patched/q36
make test-q36-http-vision Q36_SOURCE=/path/to/patched/q36
make test-q36-http-control Q36_SOURCE=/path/to/patched/q36
make test-q36-http-text-prepare Q36_SOURCE=/path/to/patched/q36
make test-q36-text-prepare Q36_SOURCE=/path/to/patched/q36
make test-q36-payload-prepare Q36_SOURCE=/path/to/patched/q36
make test-q36-payload-schedule Q36_SOURCE=/path/to/built/patched/q36
make test-q36-cache-owner Q36_SOURCE=/path/to/patched/q36
make test-q36-text-prepare-live Q36_SOURCE=/path/to/installed/q36 QWEN27_MODEL=/path/to/Qwen3.8-27B-UD-Q6_K_XL.gguf
make test-q36-http-vision-live Q36_SOURCE=/path/to/installed/q36 QWEN27_MODEL=/path/to/Qwen3.8-27B-UD-Q6_K_XL.gguf QWEN27_PROJECTOR=/path/to/Qwen3.8-27B-mmproj-F16.gguf
```

These tests copy bounded source files into a new ignored directory, apply and
reverse the real patch, compile the actual Metal runtime and execute native
GPU operators. They do not reuse upstream's tracked prebuilt test binary.
They cover partial/drift/link rejection, unrelated edits, failed disk reads,
guarded views, transient-buffer lifetime, duplicate/stale command preparation,
both model layouts (including exact history bytes), and a deliberately blocked driver allocation while unrelated tensor operations
remain available. Scalar oracles use independent dot products and two-pass
softmax. No Vulkan-hardware parity is inferred from a Metal pass.

The optional projector test verifies the pinned file's size and SHA-256, then
compares two RGB encodings (32×32 and 64×32) against the native scalar encoder.
Its original limits are maximum absolute error `1e-2`, RMSE `1e-3`, relative
L2 `5e-4`, and cosine similarity at least `0.99999`. It proves only a targeted
encoder differential, not image understanding, independent architectural
correctness, language inference or the required 30-PDF/20-image quality suite.
No projector argument is recorded as NOT_RUN, never as an encoder pass.

The first real Q6_K_XL language run failed 11/12 checks with corrupted text;
only invalid-request rejection passed. CPU/Metal diagnosis then found mixed
activation-format reuse on CPU and incomplete 27B shapes in Metal. The original
failures are retained. The focused regressions reproduce 30/75 CPU composition
failures and 21 Metal layout/boundary failures before the fixes, then pass with
unchanged assertions. These tests do not replace the real-model acceptance run.

The repeated 12-case native-server run now passes 11 checks, retaining one wrong
Python answer (`10` instead of `16`). Cold/reused sessions and the native CPU and
Metal paths reproduce the same wrong answer; their numerical agreement is not
answer correctness or an independent architectural reference. The early-cancel
regression separately reproduced lost checkpoint state in all four real Metal
text/image combinations. The correction preserves tokens, position, vision state
and full-vocabulary logits in those cases without changing the eight answers.

## Explicit installation

```sh
mkdir -p /path/to/private-engine-root
./dstudio --install-engine q36 /path/to/private-engine-root
./download-model.sh qwen27-q6
```

The second command verifies sources, patches, a fresh native build and binary
startup, not model readiness. The wrapper also downloads and verifies the pinned
Q6_K_XL and F16 projector into the shared model store. Transfers resume privately;
checksum failures and existing user files cannot be promoted or overwritten.
Installation is bounded and single-leader, publishes without replacing an
existing checkout, and records source/patch/binary identity. Drift requires
explicit review; application integration and upgrade qualification remain open.

Candidate projector: `unsloth/Qwen3.8-27B-GGUF`, revision
`4ca720788d1e01f1bff70c033e0d0028fd02e502`, `mmproj-F16.gguf`,
927,607,488 bytes, SHA-256
`cbb841a9ee0636b2ec172f5bb8df2ea8dfeb01e90fe7c6126581d662a0b4e43e`.
The [pinned model card](https://huggingface.co/unsloth/Qwen3.8-27B-GGUF/blob/4ca720788d1e01f1bff70c033e0d0028fd02e502/README.md)
declares Apache-2.0. This component is not the language model.
