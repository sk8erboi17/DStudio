# mlx-lm: one owned model per server

Base: `mlx-lm` 0.32.0 ([ml-explore/mlx-lm](https://github.com/ml-explore/mlx-lm) at
`a9bd8af5c02118882af735cef60705d2efce9fd0`), `mlx_lm/server.py` as installed from
the bundled wheel in [`src/engines/mlx`](../../src/engines/mlx/). Apply order:
`single-model.patch`. [`scripts/install-mlx.py`](../../scripts/install-mlx.py)
applies it to the installed package with `git apply --check` first and records
its SHA-256 in the receipt.

Upstream, every request's `model` field selects the model to serve: a request
naming another id, path or Hugging Face repository makes the server load a
second model or download one. Inside DStudio the server must own exactly the
model DStudio admitted. Upstream `/v1/models` also lists the Hugging Face cache
and answers before the model has finished loading.

With `DSTUDIO_MLX_SINGLE_MODEL=1` (set by DStudio for its MLX server):

- every request uses the model the server was started with; no other model is
  loaded or downloaded;
- `/v1/models` answers 503 until that model is loaded, then lists only its
  resolved path, which DStudio's readiness check compares with the admitted one.

Unset, behavior is exactly upstream.
