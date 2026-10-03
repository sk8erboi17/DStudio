# mlx-lm: stream Qwen tool calls while they are generated

Base: `mlx-lm` 0.32.0 ([ml-explore/mlx-lm](https://github.com/ml-explore/mlx-lm) at
`a9bd8af5c02118882af735cef60705d2efce9fd0`), `mlx_lm/server.py` from the bundled
wheel in [`src/engines/mlx`](../../src/engines/mlx/) after
[`single-model.patch`](../mlx-lm-single-model/README.md) and
[`reasoning-content.patch`](../mlx-lm-reasoning-content/README.md). Apply order:
those two, then `tool-streaming.patch`, which also creates
`mlx_lm/dstudio_tool_stream.py`. [`scripts/install-mlx.py`](../../scripts/install-mlx.py)
applies all three with `git apply --check` first and records their SHA-256.

Upstream holds a whole tool call until the model has finished writing it, then
parses it and sends it in one piece. A file written by the model therefore
appeared only at the end in DStudio's transcript and Open IDE
(`tests/.artifacts/streaming-live/run-eaO4iF`: every MLX path delivered its
file preview in one or two blocks, while the llama.cpp paths streamed).

With `DSTUDIO_MLX_TOOL_STREAM=1` (set by DStudio for its MLX server) and the
Qwen3-Coder tool format (`tool_parsers/qwen3_coder.py`, used by Qwen3.6), the
call is converted while it is generated into OpenAI `tool_calls` argument
fragments. Their concatenation is exactly `json.dumps(arguments,
ensure_ascii=False)` of the upstream parser for the same text: one leading and
one trailing newline are not part of a value, `null` in any case is null, and
parameters whose schema type is not a string are converted at their end by the
upstream converter. Where upstream would keep the last of a repeated parameter
or drop an unparsable call, the streamed arguments are left incomplete, so the
client rejects the call instead of running something different. Other tool
formats, non-streaming requests and an unset variable keep the upstream path.

`make test-mlx-install-unit` checks the conversion against the wheel's own
parser on random calls and every split (`tests/unit/mlx_tool_stream_test.py`)
and the patch's apply/repeat/reverse/drift lifecycle.
