# Qwen3.6 fused MoE kernels: correct Q6_K nibble order

Base: [`vagrillo/ds4` branch `qwen35moe-support` at `73434c4bb9d8bb18425a2577edada69d25d44c47`](https://github.com/vagrillo/ds4/tree/73434c4bb9d8bb18425a2577edada69d25d44c47),
the current tip on September 29, 2026. MIT; upstream notices are retained.

[`moe-q6k-nibble.patch`](moe-q6k-nibble.patch) changes three lines of
`metal/qwen35.metal`, in `kernel_qwen35_moe_gate_up` (gate and up) and
`kernel_qwen35_moe_down`. ggml's Q6_K layout stores quarters 0/1 of each
128-value half in low nibbles and quarters 2/3 in high nibbles. The fork's dense
Q6_K kernel and its CPU reference use `(quarter >> 1) * 4`; the fused MoE
kernels used `(quarter & 1) * 4`, so the low four bits of half the Q6_K expert
weights were read from the wrong nibble. The two high bits were correct.

The installed `Qwen3.6-35B-A3B-UD-Q6_K_XL.gguf` has Q6_K routed gate/up
tensors in 39 of 40 layers (down and shared-expert tensors are Q8_0), so every
decode token used the incorrect path. Q8_0 paths are unaffected.

## Application

The fork compiles its Metal shaders from source when an engine starts, so no
native rebuild is required. New installations apply the patch after the model
catalog patch. Existing installations receive it in the launch-preparation
worker before any Qwen3.6 mode starts. A drifted or partially corrected shader
fails closed with an explicit error and no file change.

```sh
DS4_DIR=/path/to/ds4-qwen35 sh scripts/apply-ds4-qwen35-q6k-moe.sh check
DS4_DIR=/path/to/ds4-qwen35 sh scripts/apply-ds4-qwen35-q6k-moe.sh apply
DS4_DIR=/path/to/ds4-qwen35 sh scripts/apply-ds4-qwen35-q6k-moe.sh restore
```

## Verification

`make test-qwen35-q6k-moe QWEN35_DIR=ds4-qwen35` builds the fork's core objects
in a private copy and runs the production kernels on synthetic Q6_K/Q8_0 blocks
against an independent scalar oracle written from ggml's block layout:

- The oracle first agrees with the fork's dense Q6_K kernel (max relative error
  about 2e-6), so a MoE mismatch cannot be an oracle defect.
- Unpatched (RED, retained): 2,785–3,119 of 4,608 gate/up outputs and 18,379 of
  18,432 Q6_K down outputs disagree; all Q8_0 cases agree.
- Patched (GREEN): every case agrees within 1e-3 relative (observed ≤ 4.1e-4).
- Repeat apply, byte-exact restore, unrelated edits, partial/drifted/linked and
  wrong-ABI sources, and the real `--prepare-launch` worker on an existing
  install are exercised.

This is kernel arithmetic, not model quality. Real Qwen3.6 before/after answer
quality is measured separately with the common corpus and recorded in
[the Qwen checkpoint](../../docs/QWEN_CHECKPOINT.md).
