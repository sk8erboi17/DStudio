# DeepSeek Vision-Exp: Metal SSD mapping recovery

Current pinned main: `f4d03f6cf9f11c1e7b630bcb160853acfba7c52a`.
The original validation below used `b0a147a7fba6d1a104d047d5a140e9bb4bfc13cd`;
the complete patch also applies/restores on current main.

PDF pages and images could fail with `DeepSeek V4 vision inference failed` after
SSD streaming replaced the language model's mapped tensor spans. The shared
Metal view registry lost the encoder views while the engine's `vision_map_ready`
flag remained true. The visual router could also fail during text-only prefill
because its bias tensor lives in the separate encoder GGUF.

The reversible patch:

- Revalidates encoder mapping for each image on Metal. Already-covered ranges
  reuse the existing buffers; other backends retain their existing behavior.
- Wraps the small visual-router bias in the existing checked, cached exact-range
  buffer path, independently of the language-layer view registry.

No routing math, quantization, expert selection rules, weights or SSD preferences
are changed. There is no text-only fallback that pretends the image was read.
Setup and Chat/Agent/Cowork/Design builders apply the patch before building.
It is reversed before upstream updates and reapplied afterwards. Qwen remains
on its separate native runtime.

`scripts/apply-ds4-vision-streaming.sh` accepts `check`, `apply`, `build` (apply
alias), or `restore`, with `DS4_DIR` set. It checks both hunks before writing and
rejects drift or partially patched source without modifying it.

Run `make test-vision-streaming-live` for the real encoder/routing before/after
regression. See [test scope and limitations](../../tests/README.md#vision-encoder-with-ssd-streaming-real-metal).
An existing engine process is not hot-patched: the fix needs a rebuilt engine
on its next launch. The test itself never restarts DStudio or its model.
