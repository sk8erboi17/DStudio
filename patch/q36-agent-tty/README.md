# q36 interactive terminal lifetime

Candidate adaptation for [Ninnix/q36 at
`d02b6a20a7662300003c859e186ceb5bec7aa849`](https://github.com/Ninnix/q36/commit/d02b6a20a7662300003c859e186ceb5bec7aa849).
This is an upstream CLI Agent fix, **not a fix for Qwen's long-context Metal
failure or an Agent-quality benchmark**. DStudio's desktop Agent uses its own
tool loop and resident-engine adapter, not this terminal UI. The installer
candidate now pins `8362010` and uses the later `monitor` + `monitor-owner`
stack described below, after the runtime `next-review` patch. The original
`pinned` selector remains for historical lifecycle tests. Fresh installation,
existing-install migration and full model qualification are separate gates.

The upstream update adds private terminals for interactive shell jobs. On
macOS, closing the last slave descriptor immediately hangs up that terminal
before a child can open `/dev/tty`. The job owner now holds one close-on-exec
slave descriptor until the child is reaped or its job is removed. Command stdin
still receives EOF and the retained descriptor is not inherited across exec.
Cancellation and error cleanup close it too. No model, GPU buffer, worker,
queue or inference setting changes.

On the tested arm64 build the extra descriptor occupies existing padding:
`agent_bash_job` remains 1,128 bytes and `agent_worker` remains 2,680 bytes.
The OS resource increase is one descriptor per live interactive job, owned and
closed with that job, not a descriptor retained for historical jobs.

The same patch corrects two defects in the upstream test reader: inspect
terminal restoration through the master, which remains valid after macOS
revokes the session's slave, and stop reading at EOF. An empty EOF stays
readable and previously spun millions of times until each scenario deadline.
The expected password, cancellation, output-isolation and restoration checks
remain unchanged. Both baseline and candidate use the identical corrected
oracle; the baseline still reproduces `NO_TERMINAL`.

## Reproduce

Apply the [Metal runtime patch](../q36-metal-runtime/README.md) first, then this
independent [runtime.patch](runtime.patch). Restore in reverse order. The
application script never downloads sources, builds, runs sudo or starts a model.

```sh
Q36_DIR=/path/to/reviewed/q36 sh scripts/apply-q36-agent-tty.sh check
Q36_DIR=/path/to/reviewed/q36 sh scripts/apply-q36-agent-tty.sh apply
make -C /path/to/reviewed/q36 -j2 q36_agent_test_metal
Q36_SOURCE=/path/to/reviewed/q36 make test-q36-agent-tty
Q36_DIR=/path/to/reviewed/q36 sh scripts/apply-q36-agent-tty.sh restore
```

Run from DStudio. Tests copy the source into a new ignored directory, preserve
the original checkout and retain every failed receipt. Coverage includes the
native Agent unit tests, all seven password scenarios using fictional secrets,
actual terminal EOF, independent terminal-mode change detection, 32 normal/
cancelled job lifetimes, descriptor counts, layout reporting, apply/repeat/
restore, partial application, drift and linked-source rejection. No actual
credentials, elevated command or LLM weights are used. Linux terminal behavior
and Vulkan/CUDA are not qualified by this macOS gate.

## New monitor-based upstream candidate

The separate [monitor.patch](monitor.patch) adapts the same descriptor lifetime
to upstream `8362010a301b3360296e435703f58ffc230a024a`. That revision retains the
new background shell monitor from `8ce8924`; the older patch does not apply to
either monitor-based revision. It is not a conflict introduced solely by the
latest exit-save commit. Keep `runtime.patch` for the older pinned ABI.

The monitor exclusively closes its retained slave after the job stops and
outside the job mutex; the owner joins before cleanup. Failed thread creation
closes it through the original owner cleanup path. A completed historical job
does not retain the descriptor. The newer worker is 2,736 bytes; the job grows
from 1,200 to 1,208 bytes on the tested arm64 build.

The first candidate reproduced another observable issue: the monitor could
reap a timed-out command before the password UI returned, which displayed a
cancellation instead of timeout. The patch preserves explicit Ctrl+C/Esc/Stop
and reports deadline expiry distinctly. The unchanged seven password scenarios
now pass; no credentials or real sudo are used.

```sh
Q36_DIR=/path/to/reviewed/q36 sh scripts/apply-q36-metal-runtime.sh apply next-review
Q36_DIR=/path/to/reviewed/q36 sh scripts/apply-q36-agent-tty.sh apply monitor
Q36_SOURCE=/path/to/reviewed/q36 make test-q36-agent-tty Q36_AGENT_TTY_FLAGS=--next-review
Q36_DIR=/path/to/reviewed/q36 sh scripts/apply-q36-agent-tty.sh restore monitor
```

The macOS upstream Agent test also needs the separately recorded
[xattr test-header patch](../q36-upstream-tests/xattr-header.patch). Final receipt
`q36-agent-tty/run-zro9_7ab` passes all 24 stages, native ownership/exit tests,
32 job lifetimes with zero leaked descriptors, and complete patch lifecycle.
It strengthens `run-2sketbhf` by checking completed jobs before history cleanup:
only the native history master remains open. The first strengthened probe
(`run-1ey_cbqi`) incorrectly referenced a field absent from the baseline;
the final shared oracle counts actual OS descriptors in both versions.
`run-f6hfyh3c` retains the first timeout-label failure. Monitor patch SHA-256:
`82b788cec48a8e49f53def1f69f2f9c5884bb7a25f4584e389a80cc54945df66`.
That isolated CLI receipt did not qualify an installer or model quality.
The upstream monitor's other output-drain/wait work under
its job mutex is addressed by the separate owner patch below; `monitor.patch`
alone does not resolve it or copy that design into DStudio's desktop runtime.

The unchanged default `pinned` path was rerun after adding the selector:
`run-hhcdnxms` passes all 24 stages and 32 normal/cancelled lifetimes, with zero
descriptor leaks. The rejected invocation `run-6e8rhs_y` used the new checkout
with the old-pin selector; provenance validation stopped it before copying or
building source. It is not counted as a passed gate.

Upstream attribution and MIT terms remain in the checkout and in the shared
[q36 license notice](../q36-metal-runtime/LICENSE).

## Responsive shell control during slow output

[monitor-owner.patch](monitor-owner.patch) is a separate, layered candidate on
the exact `8362010a301b3360296e435703f58ffc230a024a` base **after** `monitor.patch`
and the reviewed Metal runtime adaptation. It changes native shell lifecycle,
not token generation. The current installer candidate consumes this stack;
full q36 release qualification remains open. Apply order is Metal `next-review`, terminal
`monitor`, then `monitor-owner`; restore in reverse order. SHA-256:
`3b5efcc739f61e1e6be506dea9d6cdab2713a67227791e02dd1d4b5c93e4d948`.

The monitor is the sole output writer. It performs read/write/counting and
process observation outside the job mutex, then publishes only saved-byte
counts and bounded status changes. Password failures use a single deduplicated
notice slot; the first admitted reason wins, and the monitor writes it once.
The control owner reads at most 16 KiB of terminal data per pass, leaving the
remaining PTY bytes for a later pass. No new worker, output queue or cache is
introduced. On this arm64 build the job grows **1,208 → 1,216 bytes**; the worker
remains **2,736 bytes**. Descriptors retain their existing owners and lifetime.

Stop can signal the owned process while its output write is blocked. The
monitor observes exit using `waitid(..., WNOWAIT)` and consumes the status only
after admitted signals finish: retaining the unreaped leader protects its
PID/PGID while signals execute outside the mutex. At most the control owner
and that job's monitor hold signal leases. This uses the
[POSIX wait-status distinction](https://pubs.opengroup.org/onlinepubs/9799919799/functions/V2_chap02.html),
with actual retained-child and final-reap behavior tested on macOS. It is not
Linux/Vulkan/CUDA qualification. EOF/error descriptors are excluded from poll
while retirement waits, preventing a ready-at-EOF busy loop.

A stuck filesystem syscall can still delay its own monitor's output completion
and join; the patch does not claim to make disk I/O preemptible. Status and
process cancellation remain available, and no completed output is claimed
before the write/close path finishes. Partial writes followed by ENOSPC retain
the real saved prefix and report incomplete output. Failed thread creation
kills/reaps only that newly created child and closes its descriptors.

```sh
Q36_DIR=/path/to/reviewed/q36 sh scripts/apply-q36-agent-tty.sh apply monitor-owner
make test-q36-monitor-control Q36_SOURCE=/path/to/reviewed/q36 \
  Q36_MONITOR_OBJECTS=/path/to/matching/built-copy Q36_MONITOR_FLAGS=--owner
Q36_SOURCE=/path/to/reviewed/q36 make test-q36-agent-tty Q36_AGENT_TTY_FLAGS=--monitor-owner
Q36_DIR=/path/to/reviewed/q36 sh scripts/apply-q36-agent-tty.sh restore monitor-owner
```

For the monitor-control runner, supply the reviewed **terminal-only** source:
`--owner` applies the new delta to an isolated copy. It never modifies/rebuilds
the supplied checkout. `run-g38GQE` passes **7 native cases and 14 patch-lifecycle
checks** under ASan/UBSan: blocked output and status, independent jobs, Stop
during output, signal/exit races, actual short writes plus injected ENOSPC,
failed monitor creation, and duplicate terminal cancellation/timeout handoff.
All patch hunks are individually tested as partial installs; apply/repeat/
restore, prerequisite rejection, drift, source links and unrelated edits are
checked through the real application script. The helper objects are not
sanitizer-instrumented; the included native Agent and probe are.

The same seven cases and fourteen lifecycle checks also pass with
ThreadSanitizer in `run-PnMjJT`, with captured inputs unchanged. Select it with
`Q36_MONITOR_FLAGS='--owner --tsan'`; it is a separate build, not simultaneous
use of incompatible sanitizers. This remains model-free native concurrency
evidence, not numerical/inference or another backend's qualification.

The same final C oracle on upstream `run-QWH68o` and terminal-only
`run-puGjgb` fails four of the five common cases; the thread-creation failure
cleanup already passes. The two new notice-handoff cases are additional owner
tests, not included in that baseline denominator. Earlier red receipts remain.
Full native Agent/password/terminal rerun `run-gd2ap6_q` passes **28 stages**,
including 32 normal/cancelled lifetimes with no descriptor leaks and unchanged
reviewed checkout. Receipt SHA-256:
`39d1de2c0a0666c60d3d5061000bb5b660ae081b6cdbbd3ea0e3d76c45b753fb`.

Probe-only clocks record output preparation including the injected barrier,
control latency, mutex wait/hold and iteration counts. These are fault-injection
observations, not a model-speed benchmark or p99 estimate. This instrumentation
caught an initial owner candidate spinning on EOF (`run-fPmMoX`, 223,756 lock
visits in the held-signal case); the final case has 19 and an explicit bounded
visit regression. No profiling clocks or counters enter production. The initial
missing test directory (`run-bPNSNP`) and ambient-Git fixture mistake
(`run-ThgZLA`) also remain recorded; neither is reclassified as a production bug.
