# Tests: what each result actually proves

Correctness before performance. No test is accepted merely because a function
name, comment, prompt phrase or CSS declaration occurs in application source.

| Directory | Executes | Does not prove |
| --- | --- | --- |
| `unit/` | Production functions with controlled inputs and checked outputs | A model answered correctly |
| `browser/` | Real browser interactions, usually with simulated engine responses | Real model inference or real downloads |
| `integration/` | Tools, files, subprocesses, HTTP, build lifecycle | Model quality unless real weights are explicitly loaded |
| `live/` | Explicit network, hardware and/or real-model runs | All models, platforms or workloads are correct |
| `support/`, `fixtures/` | Shared harnesses and controlled input data | Independent test results |

## Clean installation and real inference

```sh
make test-setup-live                  # Real GitHub downloads + builds: main, Laguna, Qwen
make test-inference-live              # Real resident Metal: installed DeepSeek + Laguna
make test-inference-live ENGINES=qwen  # Requires downloaded Qwen base + PLE
make test-engine-acceptance           # Fresh builds AND real inference for all three
make test-qwen-chat-live              # Actual DStudio launch + Chat HTTP proxy, real Qwen
make benchmark-qwen-decode            # Native generation tok/s, three exact-output checks
```

The setup gate calls DStudio's production headless installer, using the same
archive installer and runtime builders as app setup. It starts with no engine
directory, downloads pinned source archives over HTTPS, builds the executables,
executes their help command, and checks that optional engines share the model
store. It does **not** simulate a browser onboarding click. Existing user
checkouts, models, preferences and running processes are not replaced or stopped.

The inference gate starts a real `ds4-server`, waits for its live model catalog,
and checks arithmetic, structured extraction, ordering, Unicode, multi-turn
recall, longer-context lookup, code reasoning, malformed-request recovery and
actual SSE completion. Expected answers are independently checked, not supplied
by a model judge. Missing weights, a failed build, truncation and wrong answers
fail the run. No nonempty-answer-only pass criteria.
The tool check requires a real model-generated function call and correct use of
a controlled tool result; it does not claim autonomous execution of an Agent.

The Qwen Chat gate uses an isolated DStudio data directory, invokes the actual
launch API, rejects reuse of an unrelated engine, and sends the same checked
tasks through DStudio's Chat proxy. It does not simulate a browser click.

Each unique run retains requests, responses, failures, exact install receipts,
binary SHA-256, model path/size/mtime, load time and response time under
`tests/.artifacts/engine-acceptance/`. No model content is committed. Timings
describe this run, not a universal speed benchmark. The acceptance checks are
not full-logit comparisons against BF16/CPU, and do not establish general model
quality, tool-use quality, CUDA parity or exhaustive context-boundary correctness.

Qwen currently has **Chat/native inference** integration. Its different tool
syntax is not yet adapted to DStudio Agent/Cowork/Design, so those modes reject
it explicitly. Its PLE file always stays SSD-backed by architecture; this is
distinct from optional SSD expert streaming.

## Local regression suite

`make check-fast` runs local functional/browser/integration tests without a
large language model. `make test-cowork`, `make test-frontend-unit`,
`make test-pdf-evidence` and `make test-pld` select narrower suites. Stateful test
doubles remain useful for failure/recovery coverage but are labeled as such.
`make test-video-open-weight` is separate: it compiles and runs a small real
Metal attention-equivalence probe and requires the installed H3 checkout.

The old source-pattern contract files were removed. Their useful parser, LAN,
Markdown and browser checks were retained as behavioral tests. Build-failure
injection tests cover cleanup and source preservation, not compiler correctness;
real first-run builds provide that separate evidence.

See the [real-run report](../docs/ENGINE_ACCEPTANCE.md) for actual failures as well
as successes. Qwen native generation throughput is reported separately from
DStudio Chat latency and from the small cross-engine acceptance battery.
