# Agent Notes

`q36.c` is a Qwen3.6-35B-A3B specific inference engine. It is not a generic
GGUF runner. The goal is a small, readable, high-performance C codebase.

## Goals

- Keep the production path as whole-model Vulkan graph inference.
- Keep model loading mmap-backed; do not eagerly copy the full GGUF.
- Keep the CPU backend CPU-only and use it only as reference/debug code.
- Preserve correctness before speed. Do not keep a faster path with unexplained
  attention, KV cache, or logits drift.
- Make long local agent sessions practical through live KV reuse and disk KV
  checkpoints.

## Quality Rules

- Comment important inference code where the model mechanics, cache lifetime,
  memory policy, or API orchestration are not obvious from the local code.
- Prefer comments beside the implementation over separate design documents.
- Keep comments instructive and compact: explain why a shape, ordering, cache
  boundary, or memory choice exists.
- Keep public APIs narrow. CLI/server code should not know tensor internals.
- Do not add permanent semantic variants behind flags. Diagnostic switches are
  fine when they validate the one release path.
- Do not introduce C++.

## Safety

- Avoid large CPU inference runs on Linux; the CPU path has previously exposed
  kernel VM failures with very large mappings.
- Do not run multiple huge model processes concurrently. The instance lock is
  intentional.
- Prefer short Vulkan smoke tests for build verification.

## Layout

- `q36.c`: model loading, tokenizer, CPU reference code, Vulkan graph scheduling,
  sessions, disk-cache payload serialization.
- `q36_cli.c`: command line, linenoise REPL, interactive transcript handling.
- `q36_server.c`: OpenAI/Anthropic compatible HTTP API, worker queue, streaming,
  tool-call mapping, disk KV cache policy.
- `q36_vulkan.c`: Vulkan runtime and kernel wrappers.
- `vulkan/*.comp`: compute kernels.
- `tests/`: unit and live integration tests.
- `misc/`: ignored notes, experiments, and old planning material.

## Hardware Targets

- AMD BC-250 (RDNA 2, 24 CUs / 1536 shaders, 16 GB unified GDDR6) via
  Vulkan/RADV on Linux. Codename "Cyan Skillfish", cut-down PS5 APU.
- Unified memory, ~10-14 GB usable for the model after OS and KV cache.
- Weight buffers map directly from GGUF with no copy via
  VK_EXT_external_memory_host. No staging-buffer path.
- Q2 routed-expert quant only. The memory budget is too tight for Q4.

## Testing

Use `make` for build validation. Use `make test` for unit/regression tests when a
model and Vulkan are available. Use live server tests only when intentionally
testing the API surface.

## Notes
- Do not edit local `ds4/` or `llama.cpp/` checkouts. They are ignored and are
  optional references, not build dependencies.
