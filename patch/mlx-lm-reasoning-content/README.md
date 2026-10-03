# mlx-lm: reasoning in `reasoning_content`

Base: `mlx-lm` 0.32.0 ([ml-explore/mlx-lm](https://github.com/ml-explore/mlx-lm) at
`a9bd8af5c02118882af735cef60705d2efce9fd0`), `mlx_lm/server.py` from the bundled
wheel in [`src/engines/mlx`](../../src/engines/mlx/) **after**
[`single-model.patch`](../mlx-lm-single-model/README.md). Apply order:
`mlx-lm-single-model/single-model.patch`, then `reasoning-content.patch`.
[`scripts/install-mlx.py`](../../scripts/install-mlx.py) applies both with
`git apply --check` first and records their SHA-256 in the receipt.

Upstream, the MLX server returns a thinking model's reasoning in the
`reasoning` field of each chat delta/message. Every DStudio client (Chat, the
model RPC used by Agent, Cowork, Design and the pi/OpenCode bridge) reads
`reasoning_content`, as llama.cpp and DeepSeek send it. Without this patch the
reasoning of Qwen3.6 on MLX was silently dropped (`run-JzTNjb`, retained).

With `DSTUDIO_MLX_REASONING_CONTENT=1` (set by DStudio for its MLX server), the
same text is sent as `reasoning_content`. Nothing else changes: content, tool
calls and the reasoning text itself are untouched. Unset, behavior is exactly
upstream.
