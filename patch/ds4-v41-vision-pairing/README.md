# DeepSeek V4.1 vision sidecar pairing by source revision

Source: antirez/ds4 pull request #1225 by nazeshinjite (head
`ef7894bf3c2e03ae828c1a7ef0d553ed5a61d7ef`), `ds4.c` hunks only. The
gguf-tools and test files of that PR are not needed at runtime.

Stock ds4 hard-codes one V4.1 checkpoint revision
(`df42c109f1defefcbfcedbe7d905718a12266e40`) in `deepseek4_vision_weights_bind`,
so the vision sidecar of any other V4.1 checkpoint (for example
DeepSeek-V4.1-Flash-1017) is rejected with "DeepSeek vision sidecar does not
match the language checkpoint". The patch drops that constant for V4.1 and, in
`ds4_engine_open_internal`, requires the language and vision GGUFs to carry the
same `general.source.revision`. Vision-Exp keeps its fixed revision check.
Stock V4.1 files still pair with their own sidecar; mixed checkpoints are still
refused.

DStudio uses it for the 1017 checkpoint: antirez's official
`DeepSeek-V4.1-Flash-1017-IQ2_XXS-Q2_K-imatrix.gguf` (target `ds41f-q2`) and the
community `DeepSeek-V4.1-Flash-1017-Vision.gguf` (target `ds41f-1017-vision`)
both carry source revision `1bae0e1088993b9b82de08f59de5be5a34e42170`. Upstream
ds4 `5379c1c` downloads that Q2 but still binds vision to `df42c109`.

`scripts/apply-ds4-v41-vision-pairing.sh` accepts `check`, `apply`, `build`
(apply alias) or `restore`, with `DS4_DIR` set. Already applied (reverse check)
exits 0; applicable applies; drift or a partial patch fails with no file
changed. When neither direction applies, the script skips (exit 0) only if
`deepseek4_vision_weights_bind` no longer hard-codes any V4.1 revision (upstream
pairs another way, or the checkout has no V4.1 vision encoder). A bind that
still pins a V4.1 revision this patch does not know, for example upstream
switching the constant to the 1017 checkpoint, is drift and fails: skipping it
would silently refuse every other sidecar. It is not platform-gated and runs
wherever the other managed runtime patches run, after
`apply-ds4-vision-streaming.sh`.

Removal condition: delete this set, the script and its call sites once the
pinned ds4 contains PR #1225. A verbatim merge is reported as already applied.

`make test-v41-vision-pairing` exercises apply, repeat, restore, drift, a
re-pinned upstream, an edited patch and the not-needed cases on copies of the
pinned `ds4.c`. `make test-v41-vision-pairing-live` (network for headers only)
builds the real `ds4` CLI from the pinned engine with the production runtime
patch stack, without and with this patch, and runs `ds4 --inspect --vision` on
sparse files carrying the published headers of the original and 1017 Q2 and
sidecars. No weights are downloaded or read; image inference is not run. The
pinned engine accepts the 1017 Q2 with the original sidecar and refuses its own
1017 sidecar; with the patch each Q2 opens only with its own sidecar.

The patch changes `ds4.c` only, so every ds4 binary that links the engine core
(`ds4-server`, `ds4-server-pld`, `ds4-agent-jsonl`, `ds4-cowork`, `ds4-design`)
must be rebuilt; the existing mtime/source-signature freshness checks do that,
and the Chat server readiness check treats a `ds4-server` older than a patched
`ds4.c` as stale.
