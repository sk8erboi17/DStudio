# opencode: DStudio workspace confinement

Base: [anomalyco/opencode](https://github.com/anomalyco/opencode) at
`907b3bc518fa48e90e8ec24dd327d13eee71c36c`, the snapshot in
[`src/harness/opencode`](../../src/harness/opencode/). Apply order:
`directory-confinement.patch`. `scripts/install-harness.py` applies it with
`git apply --check` first and records its SHA-256 in the receipt; a changed
patch makes the installation not current, so it is rebuilt.

Upstream `containsPath` treats every path in the enclosing git worktree as
inside the project, and compares paths without resolving symlinks. A DStudio
workspace is a directory, often inside a larger repository, so upstream
`external_directory: deny` still let the read tool open files beside the
workspace. This was reproduced by the live harness gate: the first opencode
run (`tests/.artifacts/harness-live/run-qIhfpz`) returned a file from the
workspace's parent directory.

With `DSTUDIO_CONTAIN_DIRECTORY=1` (set by the DStudio bridge) the boundary is
the session directory alone and both sides are real paths: the nearest
existing ancestor is resolved, so a symlink inside the workspace cannot lead
outside it. The same check guards opencode's shell path scan, so a shell
command naming an outside path asks for `external_directory`, which DStudio's
configuration denies. Unset, behavior is exactly upstream.
