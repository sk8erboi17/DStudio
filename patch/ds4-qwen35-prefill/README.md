# Qwen3.6 bounded Metal prefill

[`prefill-73434c4.patch`](prefill-73434c4.patch) processes up to 64 prompt
tokens per chunk, with one vocabulary projection at the chunk's final token.
The original fork processes one token and projects the vocabulary at every
prompt position. Dense projections and routed/shared experts now accept rows;
recurrent GDN rows execute in token order within one workgroup per head.
RoPE retains the original uniform-position dispatch and arithmetic. Decode
continues through the existing single-token entry points.

## Base and installation

Upstream: [vagrillo/ds4, `qwen35moe-support` at
`73434c4bb9d8bb18425a2577edada69d25d44c47`](https://github.com/vagrillo/ds4/tree/73434c4bb9d8bb18425a2577edada69d25d44c47).
Apply the [catalog patch](../ds4-qwen35-catalog/README.md), then the
[Q6_K MoE correction](../ds4-qwen35-q6k-moe/README.md), then this patch.
Agent/Cowork adapters remain separate derived sources. Upstream MIT notices
remain in the checkout; this introduces no dependency or model download.

```sh
DS4_DIR=/path/to/ds4-qwen35 sh scripts/apply-ds4-qwen35-prefill.sh apply
make -j2 -C /path/to/ds4-qwen35 ds4 ds4-server ds4-agent
make test-qwen35-prefill QWEN35_DIR=/path/to/ds4-qwen35
```

The script supports `check`, repeated `apply`, and `restore`. It rejects
partial/drifted patches, incompatible public headers and linked targets before
changing any file. Restore in reverse patch order. Rebuild after application
or restoration. Installation and launch preparation apply this overlay;
server freshness follows the actual Make graph, including headers and shaders.
Preparation/builds occur in the existing worker, outside the HTTP control loop.

## Ownership and limits

The synchronous inference owner prepares private logits, GDN/conv state and
expert counters. Replacement histories prepare their own F16 KV buffers;
extensions write only beyond the committed KV frontier. Publication follows
completed GPU work and a cancellation check. Completed chunks retain their
checkpoint; cancellation/failure cannot erase the earlier committed prefix.
Old allocations retire after publication. No new worker, queue or cache is
introduced, and no public model/session structure grows. The private candidate
is 216 bytes on arm64.

Chunks are at most 64 tokens and honor smaller configured chunk sizes. Private
scratch, including copied recurrent state and host logits, is capped at
128 MiB; the KV pair is capped at 4 GiB. A fresh/replacement history temporarily
needs both its candidate KV pair and the prior session's pair. Unsupported
capacity or allocation failure is explicit; context and precision are not
silently reduced. Attention submissions cover at most 8,388,608 key/query/head
pairs; other preparation submissions stop at layer boundaries. Cancellation
is checked between layers and attention tiles. These are work bounds, not a
guarantee about complete-model latency or total model memory.

## Behavioral evidence

`make test-qwen35-prefill` builds original and patched native cores in private
source copies. Real Metal sessions use synthetic mixed Q6_K/Q8_0 and all-Q6_K
weights with recurrent, attention and routed/shared-expert layers. The original
decode path is the differential oracle. All ten combinations of 1/17/64/65/130
tokens and the two quantization layouts match **byte for byte** for logits,
recurrent state and committed F16 KV (`qwen35-prefill/run-JFqmqH`). A separate
65,599-position synthetic F16 KV fixture compares 64 attention queries with the
original single-query kernel byte for byte; deterministic command counters
verify subdivision when the 8,388,608-pair limit is crossed. This is operator
coverage, not a 65k-token model request.

The gate also executes interrupted first chunks, interrupted extensions and
replacements, resumption, all 25 candidate GPU-allocation failures, leak checks,
patch apply/repeat/restore, unrelated edits and rejection of partial/drifted or
linked sources. Capacity fault injection also verifies that scratch/KV quota
rejection precedes any GPU allocation, including sizes that would underflow
unsigned subtraction. The unmodified fork fails the batch-admission check.
Original failed development receipts remain beside the passing run.

This qualifies the tested Metal preparation behavior with synthetic weights.
It does not establish full-model logit equivalence, answer quality, a throughput
improvement, the corpus's 900-second deadline, or CUDA/Vulkan behavior. The
operator has reserved the complete quality rerun; it has not been launched.
