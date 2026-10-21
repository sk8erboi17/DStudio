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

`scripts/apply-ds4-v41-vision-pairing.sh` accepts `check`, `apply`, `build`
(apply alias) or `restore`, with `DS4_DIR` set. Already applied (reverse check)
exits 0; applicable applies; drift or a partial patch fails with no file
changed. If `ds4.c` no longer contains the hard-coded revision (the PR was
merged upstream, or the checkout has no V4.1 vision encoder) the script reports
that and exits 0. It is not platform-gated and runs wherever the other managed
runtime patches run, after `apply-ds4-vision-streaming.sh`.

Removal condition: delete this set, the script and its call sites once the
pinned ds4 contains PR #1225 (the no-op guard makes that safe in the meantime).

The patch changes `ds4.c` only, so every ds4 binary that links the engine core
(`ds4-server`, `ds4-server-pld`, `ds4-agent-jsonl`, `ds4-cowork`, `ds4-design`)
must be rebuilt; the existing mtime/source-signature freshness checks do that,
and the Chat server readiness check treats a `ds4-server` older than a patched
`ds4.c` as stale.
