# Qwen Next speculative snapshots: allocation failure is not readiness

Base: MIT-licensed `ivanfioravanti/ds4-metal`, branch `qwen3.8-flash-next`,
`ff4f0ff4fdff70d6b7c3941ef437b91dde960e14`.
[`snapshot-allocation.patch`](snapshot-allocation.patch) fixes both the new
pre-verify snapshot and the lazy depth-3 snapshot. The smaller
[`depth3-allocation.patch`](depth3-allocation.patch) applies to the older
`2dda88ed7bc596087f5282a6020d7409ca713ff3` source before pre-verify snapshots
were added. Source notices remain intact.

Upstream used the PLE snapshot pointer as the ready flag, but assigned it before
allocating all recurrent-state/history buffers. An allocation failure left a
partial set; a later attempt returned success solely because that pointer was
non-null. The depth-3 caller also uses the pointer to choose the deep path.

Each graph remains owned by its inference worker. The fix prepares the bounded
set and publishes its PLE readiness pointer last. On failure it retires every
candidate buffer and leaves all candidate pointers null, preserving the live
state and original snapshot. No extra snapshot, cache, worker or public API is
introduced. The existing reset/replay fallback and successful-copy arithmetic
remain unchanged. Per-set limits still follow the native model's layer and
recurrent-state dimensions; allocation failure is explicit and retryable.

The installer and native Agent/Cowork builder apply inspection → empty-candidate
preparation → snapshot allocation before compiling. Restore in reverse order.
The script selects the complete set required by the source ABI, then performs
exact forward/reverse checks. A partially fixed newer source cannot pass as the
older one-hunk adaptation. Earlier sources without either lazy helper are
unchanged; this does not extend their supported Agent/core ABI.

```sh
DS4_DIR=/path/to/qwen38 sh scripts/apply-ds4-qwen38-snapshot.sh check
make test-qwen38-snapshot-patch QWEN38_AGENT_TREE=/path/to/current/qwen38
```

The test compiles the actual native core helpers with a deterministic simulated
allocator, without copying their implementation or loading a model. Unpatched
upstream fails at the second allocation with two outstanding buffers. The fixed
helpers pass ten failpoints, successful retry, repeat reuse, exact live-state
preservation and zero outstanding allocations, with ASan/UBSan. Lifecycle tests
exercise actual application, repeat, restore, unrelated edits, partial/drifted
source, symlinks and the wrong engine ABI. The initial lifecycle run's drift
fixture changed a line outside the patch hunk; its failed receipt is retained
and the fixture now changes the actual adapted allocation. Neither that test
nor its allocator establishes real-model quality or speculative speedup.
