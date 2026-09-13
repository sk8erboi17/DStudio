# q36 native test compilation on macOS

Base: [Ninnix/q36 at `8ce8924fde5797ece13df16d87246cbe4fffbea6`](https://github.com/Ninnix/q36/tree/8ce8924fde5797ece13df16d87246cbe4fffbea6).

The upstream Agent test calls macOS `setxattr` and `getxattr` without their
header. Clang rejects the test compilation before its atomic-file assertions
can run. [xattr-header.patch](xattr-header.patch) includes the platform header
in that test only. It does not alter production code, assertions or numerical
behavior and is not a model-quality fix.

[prelude-scenario.patch](prelude-scenario.patch) makes the per-call empty-reasoning
test exercise a historical assistant turn with `preserve_thinking=false`.
The original default preserves reasoning for every assistant turn, so its
negative assertions conflict with the actual GGUF templates when DStudio's
template correction is present. Adding the next user turn and choosing the
explicit profile preserves all three call-ID and prelude assertions. The same
corrected scenario passes pristine `8ce8924` and the rebased candidate; their
earlier failed receipts remain. The candidate runtime patch already contains
this scenario plus its real-schema decoder signature, so this standalone patch
is only for the pristine upstream comparison.

Apply to the isolated review checkout before building its native tests:

```sh
git -C /path/to/q36 apply --check /path/to/DStudio/patch/q36-upstream-tests/xattr-header.patch
git -C /path/to/q36 apply /path/to/DStudio/patch/q36-upstream-tests/xattr-header.patch
```

Reversal uses the same patch with `git apply --reverse`; the complete runtime
rebase remains separate. This test-only patch is not applied to users' currently
pinned installations. Attribution and terms remain those of
[q36's MIT license](../q36-metal-runtime/LICENSE).
