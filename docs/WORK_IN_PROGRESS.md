# Work in progress — September 30, 2026

This update publishes an **in-progress source snapshot**, not a fully qualified
release. The current implementation slice is closed and the remaining campaign
is paused. Publishing its code and documentation does not complete
[the full plan](../PLAN.MD) or update an already installed DStudio.app.

On September 30 a separate distribution change includes the four pinned
inference-engine source trees and the retired Qwen Next reference in Git and the
app. Setup and legacy q36 ownership migration use verified local sources;
Updates no longer fetches or pulls engines. All four engines build from an
empty relocated-app profile with external network denied, and packaging,
source-integrity, owner/publication, native setup and q36 migration checks pass.
No model, weights, installed user app or full quality run was started. Windows
and Linux installation were not rerun. See [bundled engines](BUNDLED_ENGINES.md)
for exact pins, source provenance, limits and verification commands.

The [Qwen Next migration](QWEN_NEXT_MAIN_MIGRATION.md) moves Flash Next onto
antirez/ds4 main `0aaea5a` (upstream September 20; the Qwen merge landed on
September 14) and retires its separate installer. Upstream requires new
single-file Q2/Q4 weights with embedded BF16 n-grams; old sidecar weights are
preserved, not silently converted. On September 29 the complete model-free set,
including the broad gate and an empty-profile network install, was rerun on that
pin. Native/fixture checks are separate from full-model qualification. This
scoped integration does not resume or close the full acceptance campaign.

On September 30 the operator resumed a scoped software-fix slice: parallel F16
attention for 27B, bounded batched prefill for 3.6, silent-prefill relay handling,
explicit Learn diagnostic reasoning settings and current diagnostic provenance.
Their focused native/operator/fixture checks pass; the operator reserved the
complete quality rerun, which has not been started. The desktop DeepSeek
preparation failure from stale bundled patches is also corrected and covered by
a materialized-bundle regression. See the dated
[Qwen checkpoint](QWEN_CHECKPOINT.md#scoped-software-corrections--september-30-2026).
Earlier scores/failures remain historical; these changes do not close the full
plan, the real long-context deadline or full-model numerical qualification.

The subsequent September 30 Chat research correction addresses the reported
empty transcript and source-map-heavy fallback. Progress now updates only its
own panel, keeps prior messages and text selections attached, and shows current
work in a bounded twelve-row view. At the owner's explicit request, synthesis
and review have no application-imposed elapsed-time cutoff; Stop still closes
the actual request. Discovery is bounded by counts and bytes rather than
elapsed time, so slow extraction does not spend a hidden time budget.

The writer uses streaming and retains actual generated text on transport
failure. An internal evidence scaffold is kept for diagnosis rather than
displayed as an answer. Incomplete research shows its actual error before the
draft; retry starts fresh work while preserving the failed attempt. Retrieved
facts mentioning an AI model cannot select unrequested technical-report sections.
`make test-search-evidence test-follow-scroll` and
`make test-ui-research-progress` pass with simulated model/page replies, including
actual loopback HTTP and both WebKit and Chromium. Deterministic clock checks
cover long writer/reviewer waits without a real-model run. The original private
failed research receipt is retained. These checks do not validate a new research
answer or qualify model quality; the full quality rerun remains operator-owned.

The subsequent timeout audit found two lower-layer cutoffs that the earlier
JavaScript correction did not remove: q36's 900-second admitted-request limit
and the native model bridge's 30-minute limit. Both are now removed, including
the bridge's HTTP receive and HTTPS curl work limits. The q36 change is delivered
on all three versioned runtime patch bases. Loading/preparation and their UI
waits also have no automatic elapsed-work cap; q36 compilation retains bounded
output, owner-death supervision and cancellation without a five-minute build
deadline. Attaching to an alive shared DS4 process no longer fails at three
minutes; DStudio does not stop that unowned process.

The q36 request cancellation path disambiguates an abandoned HTTP completion
from a legal TCP half-close. Owned request workers and relays arm an abortive close before work,
then disarm it after a completed response. Killing a request worker or closing
its requesting browser connection produces a reset that the native cancellation
path observes; it does not signal the model process or cancel another request.
Actual socket/process tests retain the failing FIN-only receipts and exercise
reset, valid half-close, late replies and unrelated work independently.
The DStudio host's separate `/v1` relay still treats requesting-client EOF as
cancellation; it does not support request half-close. This existing policy is
covered by the host exchange test, separately from q36's native HTTP tests.

New Task Graph nodes have no default elapsed-work budget (`timeoutMs: 0` or
omitted). Explicit positive budgets in saved/API graphs remain enforced and
serialized. Goal retains its turn/tool limits and evidence gates. PDF semantic
planning no longer expires after 90 seconds or substitutes an overview on
failure. Its previously hidden use of a private web-search parser is corrected;
invalid routing is an explicit failure. Chat attachment planning has Stop and
preserves original files/questions on cancellation or planning failure.

Focused native/HTTP, patch lifecycle, installer, graph and browser checks use
virtual four-hour waits, owned subprocess barriers and simulated model replies.
Real PDF extraction/evidence remains independently exercised. These are macOS
checks, not measurements of a slower PC, Windows/Vulkan qualification or new
model-quality results. Connection/control calls, individual external web
requests, terminal jobs, blocked consumers and cancellation escalation retain
their separate bounds. PDF extraction/embedding tools still have their existing
operation-specific limits; this slice removes model/planner/launch/research
wall-clock limits rather than qualifying those separate tool lifetimes.

The September 30 code cleanup removes the two unreachable legacy Search/Research
bodies and 33 private function declarations used only by them, including a
duplicate URL-seeding declaration. The canonical search runtime drops from
3,597 to 2,690 lines; the embedded UI copy is synchronized from it. The writer's
redundant infinite-deadline calculation and three obsolete timing constants
are removed; cancellation, work-count bounds and explicit test deadlines remain.
The public-entry-point harness now loads the complete canonical runtime instead
of maintaining a manual function list that omitted a writer dependency. Behavioral
coverage exercises supplied URLs, selected comparison evidence, evidence identity,
original request constraints and Stop over actual HTTP with simulated replies.

The same cleanup shares the `/v1` request upload/response exchange across the
existing platform branches without moving process ownership. A new native HTTP
regression first reproduced a truncated request header that sent bytes beyond
its stack buffer for long paths. The shared bounded header now preserves the
supported path and rejects truncation before sending. Original failed receipts
are retained. `make test-search-evidence test-frontend-unit test-ui-research-progress`
and `make test-v1-proxy-exchange test-v1-relay test-model-rpc-stream
test-model-rpc-interrupt test-model-rpc-lifecycle test-q36-host` pass on macOS.
These are scoped software checks; no real-model quality suite was launched,
and the shared Windows branch has not been executed on Windows.

`make test-slow-runtime test-http-lan`, `make test-macos-bundle` and
`DSTUDIO_TEST_BROWSER=webkit make test-ui-browser` also pass. The latter selects
WebKit where the harness supports it; the loading/video harnesses use Chromium.
Its initial Cowork attachment failure also reproduces against the pre-cleanup
UI: the simulator returned SSE to a nonstreaming JSON PDF-planner request.
The fixture now returns the actual completion envelope and verifies the original
planner request before the Cowork send. Production PDF failure handling is
unchanged. Historical-runtime fixtures retain the constants needed by their
older source variants; live comparison deadlines and grading are unchanged.
The workspace app bundle is rebuilt and checked without restarting a user's
application or engine.

Before publication, `make test-engine-pins test-common-quality-oracle
test-qwen-quality-chart test-task-graph-unit test-goal` also passes. These checks
exercise native installer metadata, synthetic grader/receipt integrity, the
reviewed Matplotlib chart and graph/Goal behavior; they do not run model quality.
The existing historical chart was regenerated and inspected with its original
public aggregate, without changing its score or replacing failed cases.

## What is usable, and what still needs work?

| Area | What has been demonstrated | What is still open |
| --- | --- | --- |
| Qwen3.8-27B | Real Chat, Agent code repair and Cowork spreadsheet workflows; image tools; model switching and Stop. The latest scoped DStudio replay passes 14/14 checks. | Full Learn/Tutor, PDF and desktop workflows, broad quality and long-context qualification. Design is not integrated. |
| Qwen3.6-35B-A3B | Chat and selected real Agent/Cowork file workflows; recoverable session preparation and cancellation. | The latest long Agent replay times out and its summary overcounts a partially generated function. Full disk-session checkpoints, vision, Design and complete quality/desktop coverage remain open. |
| Qwen3.8-Flash-Next | Experimental Chat, Agent and Cowork on main with the new single-file Q4 weights (verified download): real acceptance 12/12, Agent/Cowork 2/2 via CLI and 2/2 via the DStudio host, reset lifecycle, and bit-exact private session preparation. | The 100-case quality corpus, long context, Learn/PDF and desktop workflows, Q2, Design and vision remain open; earlier fork results remain historical. |
| DeepSeek V4.1 Flash Q2 | Verified download, native Metal integration and actual SSD-streaming runs on `bd66c40` and the current `0aaea5a`: 13 of 14 requests meet the checks in each. | The same format failure is retained in both runs. This is not full Chat/Agent/Cowork/Design qualification or a matched speed comparison. |
| Engine setup and upgrades | Pinned sources, versioned patches, stronger installation identity and cancellation, and a real q36 cross-version upgrade with verified cache reuse. | Complete upgrade/failure/recovery coverage across every supported engine on macOS, plus final release admission. |
| Agent goals and live input | Journal-backed goals and adding context while a turn is working, with explicit completion evidence and bounded control paths. | Full real-model quality, long-task and mode/backend qualification. A successful fixture is not proof of an autonomous task's quality. |
| Design | Nine original offline systems and browser checks for controls, layouts and both appearances. | The complete matrix of model-generated projects and their independent visual/interaction checks. Existing systems do not imply Qwen Design support. |
| Other models and platforms | Existing integrations and the individually documented historical checks remain available. | A pass on one model does not qualify every model. Since September 29 the campaign covers macOS on Apple Silicon only; CUDA, ROCm, Vulkan, Linux and Windows are out of scope and remain unqualified. |

## Passing a focused test is not finishing a model

The 27B's completed 100-task development replay remains **61 passed / 39 failed**:
31 answers miss correctness or format checks, and eight long requests fail or
time out. Later engine fixes and successful targeted retries are separate
evidence. They do not erase these failures or establish an updated 100-task score.

The latest 27B slice also passes **46/46** real HTTP/image/tool/cache checks,
**8/8** real upgrade checks and **42/42** installer regression tests. Installer
fixtures use actual processes and files but simulate downloads/builds where
documented. These totals measure different things and must not be added into
a model accuracy score. Full native desktop qualification remains separate from
headless-browser or simulated-engine tests.

## What completion requires

1. Fix and rerun the retained quality, long-task and context failures with their
   original requirements; keep the failed attempts visible.
2. Verify complete Chat, Agent, Learn/Tutor and Cowork workflows on each required
   model, including saved/reopened outputs. Qualify Design separately where it
   is integrated; do not advertise unsupported combinations. DeepSeek V4.1 Flash
   (Q2/Q4) and GLM 5.3 Flash come last, in a separate dedicated session; until
   then they remain open, not dropped or passed. Of the DeepSeek V4 Flash
   checkpoints only Vision-Exp remains in the campaign; the four non-Vision
   variants are out of scope, and their local files were deleted at the user's
   request on September 29.
3. Finish real native-desktop and installation/recovery acceptance on macOS.
   Missing weights or Mac resources mean not run or blocked, never passed.
   Other hardware is out of the campaign's scope since September 29.
4. Complete the planned generated-project and agent comparisons, publish reviewed
   data and Matplotlib charts, then qualify the final build against its exact
   engine and patch revisions.

## Evidence and resuming work

- [Qwen checkpoint](QWEN_CHECKPOINT.md): model-specific results and remaining work.
- [Engine/V4.1 update checkpoint](DS41_UPDATE_CHECKPOINT.md): revisions, patch
  ordering, hashes, actual runs and retained failures.
- [Engine release admission](ENGINE_UPSTREAM_ALIGNMENT.md): why a build alone
  cannot qualify all engines and backends.
- [Full acceptance plan](../PLAN.MD): the complete P0–P11 scope, not a smaller
  substitute based on the tests that already pass.
- [Test commands and prerequisites](../tests/README.md).

Private documents, raw private transcripts, local paths, weights, managed engine
checkouts and generated test evidence stay out of Git. Published aggregates and
receipt hashes do not claim that private raw evidence is independently available.
