# DStudio contributor instructions

Correctness before performance. Cowork is general purpose, not finance-specific.

## Tests must exercise behavior

- Do not add tests that read application source and assert the presence of names,
  comments, wording, CSS declarations, implementation order, or regular-expression
  matches. These are not behavioral or frontend/backend contract tests.
- Execute the production function, binary, HTTP endpoint, browser interaction, or
  installer. Assert observable results, errors, state transitions and data integrity.
- Loading inline JavaScript to execute its functions is allowed. Source extraction
  is harness plumbing, not evidence that the feature works. Keep assertions on
  resulting behavior, and prefer normal module imports when available.
- Test protocol compatibility using actual produced/consumed messages. Parsing
  text out of a source file is not a substitute for exercising the protocol.
- Preserve useful behavioral coverage when removing mixed source-inspection tests.
- Browser tests with simulated engine responses are useful UI tests, but must be
  labeled as simulated; they do not validate model quality or inference.
- Real installation tests start with an empty task-owned directory, download the
  pinned upstream sources over the network, build them, and verify the installed
  runtime. Never overwrite a user's existing checkout or models for a test.
- Real inference tests launch an actual engine with real weights, send held-out
  tasks with independently checked expected answers, and retain requests, answers,
  engine/model identity, timings and failures. A nonempty answer or exit code zero
  is not an inference correctness test. A few correct answers do not establish
  numerical equivalence to a trusted reference implementation.
- Missing dependencies, weights, downloads, timeouts and unavailable hardware must
  be reported as failed/blocked/not run, never silently counted as passing.
- Heavy model runs are explicit, sequential and resource-bounded. Do not stop
  unrelated user processes. Report memory/SSD mode and never compare speed before
  correctness checks pass. Stop only processes started by the current test.

## Repository hygiene

- Keep source in `src/`, UI in `web/`, features in `extension/`, engine patches in
  `patch/`, scripts in `scripts/`, and documentation in `docs/`.
- Group tests by what they actually run: `tests/unit/`, `tests/browser/`,
  `tests/integration/`, `tests/live/`; shared helpers go in `tests/support/` and
  input data in `tests/fixtures/`. Generated evidence belongs in ignored
  `tests/.artifacts/`, not among test sources.
- Preserve established engine/model paths and user settings unless a tested
  migration is part of the request. Never move, duplicate or delete model weights
  just to tidy directories. Managed engine sources and build products are ignored.
- Preserve unrelated dirty changes. Update callers, build rules and documentation
  when moving files. No commit, push or model download beyond the user's scope.
