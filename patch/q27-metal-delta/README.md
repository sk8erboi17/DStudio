# q27 Metal DeltaNet on 256-thread pipelines

The original operator gate fails on this M2 Max before model loading:
`q27 Metal: unsupported DeltaNet shape`. Its 128-dimensional, 16-QK-head
recurrence is valid, but the compiled pipeline cannot dispatch the required
512-thread group. This is an upstream native capability mismatch, not a
DStudio prompt or HTTP adapter failure.

Base: [signalnine/q27 at `8cd708389f8b5a2c5a7c481237b00c8d7f570e7f`](https://github.com/signalnine/q27/tree/8cd708389f8b5a2c5a7c481237b00c8d7f570e7f).
The public Metal header Git blob is `08a85a261a45ad6dbcf3f4be0b12247c170948aa`.
Apply [columns64.patch](columns64.patch) once to that source; no other q27
adaptation precedes it. Attribution and MIT terms are retained in [LICENSE](LICENSE).

```sh
Q27_DIR=/path/to/q27 sh scripts/apply-q27-metal-delta.sh apply
make -C /path/to/q27 -j2 test-metal-backend build/q27-metal build/q27-metal-server
make test-q27-metal-delta Q27_SOURCE=/path/to/q27
```

## Computation and lifetime

The same native step/chunk kernels now dispatch two disjoint 64-column groups
per head, with 256 threads each. Each column retains the original four 32-row
partial sums and their addition order. No precision, quantization, context,
sampling or model choice changes. Recurrence reads/writes only that column's
state, so both separate source/destination and in-place updates remain valid.
The chunk retains its state in registers and publishes it at the original
chunk boundary; it does not create a second cache or a new CPU worker.

Host argument layouts remain 12 bytes (`DeltaArgs`) and 16 bytes
(`DeltaChunkArgs`). Each thread still retains 32 state values. Threadgroup
scratch falls from 3,584 to 2,304 bytes per group; there are now two groups per
head, with 512 threads total as before. These are bounded dispatch/layout
facts, not a throughput improvement claim.

Dispatch geometry is part of the shader ABI. Both host and runtime shader use
`13-dstudio-delta64`; either mixed old/new pairing fails before GPU execution.
The existing Makefile includes the shader dependency and rebuilds consumers.
The application script checks forward/reverse applicability atomically,
rejects partial/drifted/linked inputs and preserves unrelated edits.

## Evidence and limits

The regression runs the original native Metal suite without changing its
assertions, plus 24 independent cases: 1/3/48 value heads, 1/3/17/96 tokens,
separate and in-place state. It checks every state/output element against
double-precision scalar matrix algebra with the unchanged upstream `2e-3`
scaled absolute tolerance, every guard, immutable inputs and exact equality
with token-serial GPU execution. Initial failures are retained. Timings in
receipts describe operator calls, not generated model tokens.

This fixes the reproduced primitive failure. It does **not** qualify complete
q27 language-model output, its custom q4s weight conversion, CUDA equivalence,
other Apple hardware, or DStudio's pending q27 installer/application adapter.
