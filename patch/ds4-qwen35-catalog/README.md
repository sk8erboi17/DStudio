# Native Qwen3.6 model discovery

Base: [`vagrillo/ds4` at `60fca11f0c8b16ca50c757324dddd717ba043098`](https://github.com/vagrillo/ds4/tree/60fca11f0c8b16ca50c757324dddd717ba043098),
MIT, with its original notices retained.

Patch SHA-256: `2854793806e9207a658bf240d113838bf17b8d28a8e34961724d9cc3566f6ad0`.

The native engine already chooses Qwen's tokenizer/template and identifies the
family in `server_model_id_from_engine()`. Its `/v1/models` list nevertheless
falls through to the DeepSeek aliases. This patch makes discovery publish the
loaded Qwen identity, using that existing native function. It does not change
inference, tool parsing, sampling, weights, performance, or backward-compatible
request aliases. It is not a fix for an incorrect model answer.

Apply after extraction, before the native server build:

```sh
DS4_DIR=/path/to/ds4-qwen35 sh scripts/apply-ds4-qwen35-catalog.sh check
DS4_DIR=/path/to/ds4-qwen35 sh scripts/apply-ds4-qwen35-catalog.sh apply
make -C /path/to/ds4-qwen35 ds4-server
```

`restore` reverses only this delta. Repeat apply/restore are idempotent. The
complete patch is checked before any write; mismatched anchors, partial changes
and a symlinked source file are rejected, preserving unrelated edits. This is a
Qwen3.6-only installer adaptation, not a patch to apply to all ds4 branches.

Qualification must include the real HTTP catalog and native inference receipts;
a source diff or a metadata-fixture test alone does not qualify real weights.
