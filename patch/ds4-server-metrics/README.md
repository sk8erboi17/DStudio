# Native server usage metrics

`usage-metrics.patch` exposes native decode timing in the OpenAI-compatible
usage object. It preserves the engine's token and cache accounting; the UI does
not estimate token speed from text length. The hook is used by main and Laguna;
the two Qwen native servers use their own setup paths.

## Sources and order

| Upstream | Verified base |
| --- | --- |
| [antirez/ds4](https://github.com/antirez/ds4) main | `c0a6119f363ef82125877142f13fb3fe491cba14` |
| Identical server source at the new main pin | `f62ca29a308724cde5bc99134ede19104b2a3260` |
| Previous managed main | `f4d03f6cf9f11c1e7b630bcb160853acfba7c52a` |
| [antirez/ds4](https://github.com/antirez/ds4), Laguna branch | `448d5695d1c86401a4e9447c440feb983b73e6de` |

Setup applies visible-downloads, media-memory, **server-metrics**, GLM runtime,
M2 and vision-streaming adaptations in that order; restoration reverses it.
The September 7 compatibility correction only removes obsolete trailing patch
context. The resulting C code stays byte-identical: upstream's newer
`recovery_completion` bookkeeping is retained, not overwritten.

`scripts/apply-ds4-server-metrics.sh` accepts `apply`, `check` and `restore`.
It preflights the complete delta in either direction and uses `git apply`
without reject/fuzz mode. Partial or drifted patches fail without source
mutation; one marker is not evidence of successful installation. It rejects a
symlink source and does not inherit a surrounding repository's Git index.
Do not run competing builds/patch operations in the same checkout.

These fields describe the final native decode pass using its sampled-token
counter and elapsed span. They are not prefill speed or end-to-end latency.
When native non-streaming tool recovery makes another attempt, total usage can
also include earlier attempts; do not divide that total by the final-pass time
or present the rate as a whole-request measurement. This compatibility change
does not qualify numerical inference or change that existing timing boundary.

## Behavioral verification

```sh
make test-server-metrics-patch test-native-patch-roundtrip test-main-decode-metrics
```

The first test copies current main and Laguna sources and reads the exact old
main source from local Git objects. It compiles and runs the real JSON/SSE
serializers before/after the patch: 66 controlled-counter executions across
the three bases, including missing metrics, cache bounds, usage opt-out and
`[DONE]`. It also tests repeat apply/check/restore, preserved unrelated edits,
partial application, drift, wrong source/action and symlink rejection.
`METRICS_MAIN_DIR` and `LAGUNA_DIR` select explicit source locations. Missing
sources or old Git objects fail the test; they are not skipped passes.

The second test reverses and reapplies six native adaptations on a private copy
of a managed main checkout (`NATIVE_PATCH_DIR` selects it). The M2 hook chooses
its production build-hunk variant. Exact file hashes must round-trip. This is
not the complete Agent, server-PLD or web patch stack.

All evidence is retained under ignored `tests/.artifacts/`. Counter fixtures
test serialization, not model inference or throughput; no weights are loaded.
