# DStudio Task Graph V1

Task Graph is common Agent Runtime infrastructure, not a separate DStudio mode.
The shipped V1 core provides a bounded DAG model, strict policy validation, an
event-sourced persistent store, optimistic-concurrency HTTP controls and a
cooperative synthetic executor. The synthetic executor validates scheduling,
leases and crash recovery deterministically without invoking a model, a shell,
the network or external tools.

## Guarantees

- The host owns every state transition; model prose can never complete a node.
- A transition is appended and `fsync`ed before its new state is visible.
- `events.jsonl` is authoritative and `state.json` is a replace-atomically
  materialized view. Cold load replays the journal and repairs a stale view.
- Unknown schemas, duplicate JSON keys, cycles, escaping output paths,
  non-idempotent automatic retries and unapproved external effects are rejected.
- Completed attempts are immutable. Requests and results are written beneath
  `attempts/<nodeId>/` before completion is exposed.
- V1 permits one LLM node globally and one workspace/external writer globally;
  bounded read-only synthetic host work may run concurrently.
- Start, pause, resume, cancel, approve, retry and skip require both the expected
  graph revision and last event sequence. Stale callers receive `409 Conflict`.
- A valid graph whose real executor is not registered remains an inspectable
  proposal. Start returns `422` without changing its revision, event sequence or
  `ready` state.

## Persistent layout

Workspace graphs live at:

```text
<workspace>/.dstudio/task-graphs/<graphId>/
  graph.json       immutable validated definition
  state.json       rebuildable materialized state
  events.jsonl     authoritative append-only transitions
  artifacts.json  bounded provenance registry (empty in the synthetic rollout)
  attempts/        immutable request/result envelopes
  lock             advisory single-writer lock
```

When no workspace is attached, the same layout lives under DStudio's writable
data directory. No graph data is written into the application bundle.

## Local API

The localhost-only API accepts `X-Requested-With: ds4web` on mutations:

```text
POST /api/task-graph/validate
POST /api/task-graph/create
GET  /api/task-graph?graphId=...&workspace=...
GET  /api/task-graph/events?graphId=...&workspace=...&since=...
GET  /api/task-graphs?workspace=...
POST /api/task-graph/{approve,start,pause,resume,cancel}
POST /api/task-graph/node/{approve,retry,skip,cancel}
```

Runtime responses report `executionAvailable`. Validation is deliberately
separate from execution: Plan and future Agent/GSA/RSA compilers can persist a
safe proposal before their executor is enabled.

## Verification

```sh
make test-task-graph-unit
make test-task-graph-http
make test-task-graph-bench-validate
```

These gates cover parse/validation, transitions, leases, retry, approval,
pause/resume/cancel, journal replay, stale snapshots, duplicate event keys,
append/rename failpoints, API preconditions and lightweight timing loops. The
ten real-model A/B scenarios under `bench/` are deliberately marked
`prepare-only`; `check-fast` validates them but never starts a model. Their
heavy runner remains guarded by `RUN_HEAVY=1` and must not be used as a release
claim until the corresponding real adapters and reproducible hardware controls
are available.

## Rollout boundary

This merge completes phases 1–3 of the architecture plan: DAG core, durable
store, recovery, HTTP surface and synthetic scheduling. Ordinary simple Agent
turns remain direct, Plan remains planning-only, and existing GSA/RSA pipelines
retain their native structured phase contracts. Real Plan/Agent/GSA/RSA,
hardware/media and cross-mode executors stay behind their later benchmark gates
instead of being silently simulated by the synthetic runtime.
