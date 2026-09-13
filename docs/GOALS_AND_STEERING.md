# Goals and live context

DStudio implements these controls locally. It does not import Codex's model
or claim equivalent agent quality. The interaction references are Codex's
[in-flight `turn/steer` contract](https://learn.chatgpt.com/docs/app-server)
and [persistent goals](https://learn.chatgpt.com/use-cases/follow-goals).

## What the user sees

- Keep typing while Chat, Agent, Cowork, Design, Learn or a GSA/RSA Agent phase
  is working. Stop is independent from Send.
- Native Agent/Cowork/Design append input after the current model/tool round.
  Existing tool effects are not interrupted or replayed. Even an input arriving
  at the final-answer boundary continues the same native turn.
- Chat and Tutor preserve partial output and yield text generation to include
  the additional context. Learn's roadmap pipeline reruns its verification on
  the updated result. Research preparation keeps its collected evidence; added
  context is applied before the answer, rather than changing an already-issued
  web request. Running image/video operations finish before further context is
  processed; their outputs are preserved.
- Native inputs show as pending until the inference owner acknowledges append.
  On cancellation, reload, or ambiguous delivery, retained input needs review;
  DStudio never silently submits it as a new task. At a closed/idle native turn,
  steering is rejected and the draft is retained.

`/goal <objective>` starts a journal-backed Agent goal. `/goal pause` waits for
the current turn; `/goal resume` resumes a paused or needs-input goal with
remaining budget. `/goal clear` cancels
the current goal and removes its conversation link, not its files/history.
The Goal strip shows its objective, state, turn count and controls. Details opens
the existing Task Graph view. After missing input or an interrupted attempt,
review the evidence, supply the missing context and explicitly resume. An
exhausted budget requires clearing/starting a new goal for the remaining work;
it is not silently increased or retried.

On Qwen27B, GSA/RSA requests that require Max need at least 96k context.
DStudio rejects an incompatible start or resume without changing your setting
or consuming a Goal turn. Choose a compatible context and resume the same Goal;
its earlier work and remaining budget are preserved.

## Ownership and limits

Native steering uses a host-local endpoint and an opaque per-runtime credential.
`POST /api/agent/steer` requires `expectedTurnId`, a unique `inputId`, and `text`.
The HTTP owner admits at most 16 outstanding inputs, 128 total per turn, with
16 KiB per input. Reusing an ID with identical content is idempotent; different
content, a stale turn, cancellation or a closed admission window is rejected.
No model/session/workspace override is allowed through this operation.

The inference owner pulls text between completed rounds. A closing pull seals
admission before replying if no input is pending; otherwise it returns the
pending input and the same turn continues. ACK follows transcript append, not
HTTP admission. The existing transcript carries the exact input/turn receipt
across rapid phase changes; the UI never guesses acknowledgement from matching
prose. Runtime delivery state is volatile and is never crash-replayed.
Native live context accepts text/extracted documents, not image bytes; unsupported
images and rejected attachments stay in the composer for a later turn.
Chat's persisted pending-context outbox is separately bounded to 16 messages
and 512 KiB per message; attachment processing retains its existing limits.
Raw image bytes are session-local, not promised to survive a reload.

A Goal is an `agent.goal` action under the existing native Task Graph scheduler.
The immutable graph owns the objective and turn budget; `events.jsonl` owns
progress and pause/resume. The UI stores only its graph/workspace identity.
The default is 8 turns (API `goalMaxTurns`: 1–32), 15 minutes per turn. This is
a turn budget, **not a token budget**. No token-budget enforcement is claimed.

A healthy incomplete turn may schedule a new planning turn over current state.
That is distinct from replaying a failed write/command. A crash, cancellation,
watchdog stop or explicit missing-input receipt does not auto-continue.
Completion requires structured tool evidence, a final native `bash` or
`bash_status` result with `status=done`, `timed_out=0`, `exit_status=0`, and a
following completion receipt. Command stdout cannot forge these native header
fields. The check does **not** prove that the model chose a sufficient test for
an arbitrary objective. Goal is not a general correctness guarantee.

## Compatibility and tests

Agent patch v85 applies the same owner-boundary hooks to the inspected ds4 main
source (`f4d03f6`) and Laguna source tree. The configured Laguna pin is
`448d5695d1c86401a4e9447c440feb983b73e6de`; its Agent source SHA-256 matches the
pinned upstream file (`44a5b1d149bb3d846c553e42b9f924dd488bf7ec1163c2a82aec1134ddb6bac2`).
This checkout is an archive, not a nested Git repository. Main and Laguna Agent/Cowork binaries were rebuilt;
Design was rebuilt against main. This is the original steering baseline,
not qualification of later engine updates. Current Qwen integration and its
remaining limits are tracked in [the Qwen checkpoint](QWEN_CHECKPOINT.md).
The Qwen27B host gate now executes real Agent/Cowork tools with a controlled
model peer: fifteen scenarios include Max admission on all four Agent routes,
valid completion after a real Bash check, and resumed Goals after a context
change. The gate passes normally and with host ASan/UBSan; it does not establish
real-model Goal quality or complete the Qwen family qualification.

Verification entry points (no model weights):

```sh
make test-goal test-steering
make test-task-graph-unit test-task-graph-http
make test-steering-patch test-steering-runtime
node tests/browser/ui_agent_design_playwright_test.mjs
DSTUDIO_TEST_BROWSER=webkit node tests/browser/ui_agent_design_playwright_test.mjs
node tests/browser/ui_roadmap_playwright_test.mjs
make test-design-runtime test-remote-utf8
```

The transport test executes native HTTP admission plus the production runtime
client in another process: FIFO, append-before-ACK, duplicate/stale/type/bounds
rejection, close/admission race and cancellation. The runtime test executes
actual Agent/Cowork/Design binaries and filesystem tools with deterministic
model frames: one turn, three model rounds, two context additions, no duplicate
tool effect. Goal tests execute the native scheduler and durable replay with
fixture transcripts: completion evidence, a failed command attempting to print
success, bounded continuation, missing input, pause/resume and crash handling.
Receipts retain their native RS boundary even after terminal color output;
interrupted, unknown, incomplete or failed results cannot qualify. Marker checks
use only the current attempt's bounded transcript, excluding user/event text
and stale buffer bytes. A late WAITING cannot erase a prior failed turn receipt.

Browser tests execute the real UI with simulated HTTP/model responses. They
check Chat/Tutor partial-answer preservation, recovered drafts without automatic
replay or loss, late-reply draft preservation, native same-turn routing without
Stop, Goal controls, and the existing Agent/Cowork/Design interactions. WebKit's
clipboard alone is simulated because Playwright does not offer its clipboard
permission override; Chromium exercises the actual clipboard API.

These are not live-model quality or throughput benchmarks. CUDA and Windows
steering have not been validated; native host steering is currently enabled
on POSIX hosts. No model was started or application restarted for this change.
