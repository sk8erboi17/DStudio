# DStudio Task Graph V1

Task Graph is common Agent Runtime infrastructure, not a separate DStudio mode.
It provides a bounded DAG, strict policy validation, an event-sourced store,
native executors, optimistic-concurrency controls and a live Agent UI.

Ordinary Agent sends use adaptive orchestration by default. Conversational
questions keep the direct native path; deterministic classification routes
workspace inspection and mutation requests through a generic correctness-first
graph. There is no user-facing on/off switch. `orchestration: "native"` exists
for the matched benchmark, while `orchestration: "task-graph"` forces the
checked route for tests and API clients.

## Native action contract

Set `policy: "agent.general.v1"`, `mode: "agent"` and
`executorMode: "native"`. Execution is closed-world: arbitrary tool JSON is
never retained or evaluated. V1 accepts only:

| Node kind | Action | Required declaration |
| --- | --- | --- |
| `agent_turn` | `agent.prompt` | bounded `text`; mutation/capabilities must agree; optional tool-backed completion contract |
| `host_tool` | `workspace.read` | `read_only`, `filesystem.read`, relative `path` |
| `host_tool` | `workspace.write` | `workspace_write`, `filesystem.write`, `path`, `text`, downstream gate |
| `host_tool` | `test.run` | argv array, `workspace_write`, `test.run`, downstream gate |
| `gate` | `workspace.assert` | `read_only`, `filesystem.read`, `path`, optional `contains` |
| `gate` | `outputs.verify` | verifies required output contracts of direct dependencies |
| `gate` | `agent.receipt.verify` | verifies one Agent dependency's tool evidence and completion marker |
| `approval` | `approval.wait` | default action; explicit user approval completes it |
| `join` | `join.all` | default action; completes after dependencies |

`test.run` uses `fork` + `execvp` with an argv array and a bounded executable
allowlist; it never invokes a shell. Its stdout/stderr stream is retained with
the immutable attempt envelopes. Windows currently rejects this one action
explicitly; the other native actions are portable.

Every dispatch reevaluates the same deterministic policy used at validation and
writes an immutable `*.policy.json` receipt bound to a digest of the immutable
graph definition. Paths are checked lexically and after `realpath`, including
the parent of a new file, so symlink traversal cannot leave the workspace.

## Agent executor and anti-loop watchdog

An Agent node acquires DStudio's single global LLM lease and writes its prompt
to the already-running structured `ds4-agent-jsonl` process. The attempt ends
at the Agent's explicit `+DWARFSTAR_WAITING` boundary, but that boundary alone
does not imply success. With `requireToolResult: true`, the host requires a
structured tool result and the declared `contains` marker afterwards. Status
frames may interleave generated token chunks, so the host removes RS+JSON event
lines before matching the textual marker. The user prompt is excluded from the
search and cannot satisfy its own contract. The bounded transcript is stored as
an immutable receipt.

The automatic graph gives read-only turns at most two attempts. A mutating turn
is also configured for two attempts, but its second attempt is legal only when
the first transcript proves that zero tool calls ran. Once any tool was called,
the scheduler will not replay a non-idempotent action automatically.

The Moven-inspired watchdog observes structured `tool_call` and `tool_result`
events only for a graph-owned turn. It interrupts the turn after four byte-
identical calls, four identical results without progress, or 128 tool calls.
Counters and the trip reason are returned by the API and persisted in the
result receipt. Ordinary interactive Agent turns are not observed by it.

## Checkpoint and honest undo

Every native attempt writes a checkpoint receipt before its action. A
`workspace.write` snapshots the target bytes (or records that it did not
exist), fsyncs them, and records before/expected-after FNV-1a fingerprints.
`POST /api/task-graph/node/undo` is allowed only while the graph is paused or
terminal. It first proves the target still equals the expected post-action
state byte-for-byte, then atomically restores the snapshot and verifies the
result. A successful receipt says `fullyReversed: true` within the explicit
scope `declared target bytes and existence`; unrelated filesystem metadata is
not claimed as checkpointed.

Agent turns and `test.run` may cause nested filesystem effects that the host did
not observe file-by-file. Their receipts therefore say `reversible: false`;
undo returns `applied: false`, `fullyReversed: false` and
`manualReviewRequired: true`. This limitation is deliberate: evidence is not
misrepresented as rollback.

## Durability and scheduling guarantees

- The host owns every state transition.
- A transition is appended and fsynced before its new state is exposed.
- `events.jsonl` is authoritative; `state.json` is an atomically replaced view.
- Unknown schemas/actions/capabilities, duplicate JSON keys, cycles, escaping
  paths, invalid retries and unapproved external effects are rejected.
- Attempts and policy/checkpoint/result/undo envelopes are immutable.
- One LLM node and one workspace writer run globally at a time. Bounded host
  reads may run concurrently.
- Pause drains running actions cooperatively and freezes ready nodes; resume
  reenqueues them. Cancel sends SIGTERM to a `test.run` process group or SIGINT
  to the graph-owned Agent turn.
- A native running attempt found after a cold restart has no reusable process
  lease and is recorded as interrupted/failed rather than falsely shown alive.
- Mutations require expected graph revision and event sequence; stale callers
  receive `409 Conflict`.

## Persistent layout

```text
<workspace>/.dstudio/task-graphs/<graphId>/
  graph.json       immutable validated definition
  state.json       rebuildable materialized state
  events.jsonl     authoritative append-only transitions
  artifacts.json  bounded provenance registry
  attempts/<node>/ immutable request, policy, checkpoint, result,
                    transcript/test stream and undo receipts
  lock             advisory single-writer lock
```

## Local API and live graph

```text
POST /api/task-graph/validate
POST /api/task-graph/create
GET  /api/task-graph?graphId=...&workspace=...
GET  /api/task-graph/events?graphId=...&workspace=...&since=...
GET  /api/task-graphs?workspace=...
POST /api/task-graph/{approve,start,pause,resume,cancel}
POST /api/task-graph/node/{approve,retry,skip,cancel,undo}
```

The Agent header's **Graph** button opens the live DAG. It groups nodes by
dependency depth, shows incoming edges, action/state/watchdog/undo receipts,
tails the durable journal every 750 ms and exposes the valid controls for the
current state.

## Verification

```sh
make test-task-graph-unit
make test-task-graph-http
make test-task-graph-bench-validate

# Explicit heavyweight test: starts a real local Agent with forced SSD streaming
make test-task-graph-real

# 50 unique tasks across ten families, Native Agent / checked DStudio, SSD off
DSTUDIO_RELIABILITY_CASES=50 make test-task-graph-reliability-real

# The same 50 fixtures through Pi / OpenCode on the same local model, SSD off
DSTUDIO_RELIABILITY_CASES=50 make test-task-graph-cli-competitors-real

# Publication data and Matplotlib figures
DSTUDIO_TASK_GRAPH_BENCH_RUNS=3 make test-task-graph-real
python3 extension/task-graph/bench/plot-results.py
node extension/task-graph/bench/publish-reliability.mjs \
  tests/.artifacts/task-graph-reliability-real/result.json \
  extension/task-graph/bench/results/2026-09-04-m2-max-diverse-reliability-no-ssd.json
node extension/task-graph/bench/publish-cli-comparison.mjs \
  tests/.artifacts/task-graph-cli-competitors-real/result.json \
  extension/task-graph/bench/results/2026-09-04-m2-max-diverse-reliability-no-ssd.json \
  extension/task-graph/bench/results/2026-09-04-m2-max-diverse-agent-comparison-no-ssd.json
python3 extension/task-graph/bench/plot-cli-comparison.py
```

The lightweight gates cover parser/policy decisions, native reads and writes,
real argv process execution, gates, approval, watchdog thresholds, checkpoint
rollback, pause/resume/cancel, replay/failpoints, API preconditions and the live
UI contract. The heavy runner requires `RUN_HEAVY=1`, asserts
`ssdStreamingEffective: true`, and can repeat a real eight-node chain containing
`ds4-agent-jsonl`, gates, explicit approval, host write, argv process and join.
It proves the model's expected answer occurs after its structured tool result,
then verifies policy/checkpoint/result, approval, transcript and process-stream
receipts. Its working artifacts live under
`tests/.artifacts/task-graph-ssd-real/` and are gitignored.

The measured public snapshot, including per-run values, hardware, configuration
and methodological limitations, is stored in
[`bench/results/2026-09-04-m2-max-native-ssd.json`](bench/results/2026-09-04-m2-max-native-ssd.json).
The diverse 50-task publication, including all 100 Native/checked DStudio
outcomes and the ten-family coverage declaration, is stored in
[`bench/results/2026-09-04-m2-max-diverse-reliability-no-ssd.json`](bench/results/2026-09-04-m2-max-diverse-reliability-no-ssd.json).
The four-agent result is stored in
[`bench/results/2026-09-04-m2-max-diverse-agent-comparison-no-ssd.json`](bench/results/2026-09-04-m2-max-diverse-agent-comparison-no-ssd.json).
The main README uses its two Matplotlib figures; the earlier SSD run remains a
runtime snapshot.
