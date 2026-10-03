# opencode: DStudio workspace confinement

Base: [anomalyco/opencode](https://github.com/anomalyco/opencode) at
`907b3bc518fa48e90e8ec24dd327d13eee71c36c`, the snapshot in
[`src/harness/opencode`](../../src/harness/opencode/). Apply order:
`directory-confinement.patch`, `workspace-root.patch`.
`scripts/install-harness.py` applies them with `git apply --check` first and
records their SHA-256 in the receipt; a changed patch set makes the
installation not current, so it is rebuilt.

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
outside it. The same check is used by opencode's scan of shell command
arguments, but that scan does not see every path a command can write (a
redirection target such as `cat > /elsewhere/file` is not checked): shell
commands are not sandboxed. Unset, behavior is exactly upstream.

## workspace-root.patch

Upstream tells the model both the session directory ("Working directory") and
the enclosing git worktree ("Workspace root folder"). With a DStudio workspace
inside a larger repository, a real Qwen3.6 run wrote its file to the
repository root: the write tool was refused by the confinement above, and the
model then used the shell to write there (`tests/.artifacts/streaming-live/`
`run-FELWf8` and `run-gOFF8d`; the stray files were removed). With
`DSTUDIO_CONTAIN_DIRECTORY=1` the session directory is also the workspace root
the instance reports, so the model is never pointed at the enclosing
repository. The project identity used for opencode's own storage is unchanged.
