# Qwen Flash Next on the bundled main engine

Qwen3.8-Flash-Next uses DStudio's bundled ds4 main. It has no separate engine
installation. The current revision and installation procedure are maintained
in [bundled engines](BUNDLED_ENGINES.md); source/qualification changes are tracked
in [engine admission](ENGINE_UPSTREAM_ALIGNMENT.md).

Qwen3.6 and Qwen3.8-27B use llama.cpp, with a separate MLX path for Qwen3.6.
Their adapters and results do not qualify Qwen Next.

## Select the supported single-file weights

Choose Qwen3.8-Flash-Next Q2 or Q4 in Settings → Models. These checkpoints use
single GGUFs with native BF16 n-gram data read from SSD. N-gram disk reads and
expert SSD streaming are different mechanisms; configured context also needs
working memory. File size is not a resident-memory or throughput guarantee.

The pinned publisher repository is
[`antirez/qwen3.8-flash-next-gguf`](https://huggingface.co/antirez/qwen3.8-flash-next-gguf/tree/d600fe1a43d2e1cdcadb85144ce3142f66f9eefe),
revision `d600fe1a43d2e1cdcadb85144ce3142f66f9eefe`. The
[download adaptation](../patch/ds4-visible-downloads/README.md) pins that
revision and preserves size/SHA-256 checks.

| File | Exact bytes | SHA-256 |
| --- | ---: | --- |
| `Qwen3.8-Flash-Next-Q2.gguf` | 147207127040 | `b1b93fa69aca5f187b0fb813aca8f3ec1beb5cf8cf0bd38cf041b93e0b6ccac9` |
| `Qwen3.8-Flash-Next-Q4.gguf` | 177280286720 | `680944460a8cbe93ba8b6d7b6107213ffb7e22320bd913000e563ca0a0f25a8a` |

From the repository root, explicitly download the selected large file:

```sh
./download-model.sh qwen38-q2
# Or choose the larger Q4:
./download-model.sh qwen38-q4k
```

The `qwen38-q4k` command name remains, but its target is the single-file Q4
checkpoint above. This path requires the Hugging Face CLI, uses one worker
and retains native verification. It is independent from the V4.1 Q2 HTTP
resume helper. Model files remain in `ds4/gguf/`.

## Older installations and files

The old base-plus-PLE checkpoint is unsupported. DStudio does not convert,
rename or delete those bytes. It provides no special upgrade or recovery path
for an old Qwen Next folder, branch, base file or sidecar; unknown files and
folders receive the ordinary discovery/drift rules. An installed engine at
another revision must be reinstalled from the bundled sources, following
[the current installation instructions](BUNDLED_ENGINES.md). Preserve local
weights and work before replacing an installation.

## Runtime and verification scope

Native adapters and their supported bases are recorded in [the patch index](../patch/README.md).
Agent/Cowork, Chat PLD and the browser helper keep separate versioned recipes;
a merged source file does not enable an unsupported model capability.

The retained Q4 corpus and long-context results belong to main `0aaea5a`.
They do not qualify a newer main pin, Q2, Design or vision. Exact scores,
failures and open model requirements live in [the Qwen checkpoint](QWEN_CHECKPOINT.md)
and [PLAN.MD](../PLAN.MD). Installation/build fixtures are separate from
real-model answer, Learn/PDF, desktop and numerical acceptance.

The superseded integration narrative, original runtime comparisons and retained
failures are preserved in [the dated migration snapshot](history/qwen-next-migration-through-2026-11-04.md).
Use the [test index](../tests/README.md) for current commands and scope; this
documentation change runs no engine or model and closes no acceptance gate.
