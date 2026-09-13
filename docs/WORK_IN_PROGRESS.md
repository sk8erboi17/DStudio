# Work in progress — September 13, 2026

This update publishes an **in-progress source snapshot**, not a fully qualified
release. The current implementation slice is closed and the remaining campaign
is paused. Publishing its code and documentation does not complete
[the full plan](../PLAN.MD) or update an already installed DStudio.app.

## What is usable, and what still needs work?

| Area | What has been demonstrated | What is still open |
| --- | --- | --- |
| Qwen3.8-27B | Real Chat, Agent code repair and Cowork spreadsheet workflows; image tools; model switching and Stop. The latest scoped DStudio replay passes 14/14 checks. | Full Learn/Tutor, PDF and desktop workflows, broad quality and long-context qualification. Design is not integrated. |
| Qwen3.6-35B-A3B | Chat and selected real Agent/Cowork file workflows; recoverable session preparation and cancellation. | The latest long Agent replay times out and its summary overcounts a partially generated function. Full disk-session checkpoints, vision, Design and complete quality/desktop coverage remain open. |
| Qwen3.8-Flash-Next | Experimental Chat, Agent and Cowork integration. Earlier real reset and file workflows pass. | Those earlier results do not qualify the newly pinned speculative decoder. Design, vision and the full current-revision quality/desktop matrix remain open. |
| DeepSeek V4.1 Flash Q2 | Verified download, native Metal integration and an actual SSD-streaming run: 13 of 14 requests meet the checks. | One format failure is retained. This is not full Chat/Agent/Cowork/Design qualification, a matched speed comparison or evidence for non-Metal backends. |
| Engine setup and upgrades | Pinned sources, versioned patches, stronger installation identity and cancellation, and a real q36 cross-version upgrade with verified cache reuse. | Complete upgrade/failure/recovery coverage across every supported engine and platform, plus final release admission. |
| Agent goals and live input | Journal-backed goals and adding context while a turn is working, with explicit completion evidence and bounded control paths. | Full real-model quality, long-task and mode/backend qualification. A successful fixture is not proof of an autonomous task's quality. |
| Design | Nine original offline systems and browser checks for controls, layouts and both appearances. | The complete matrix of model-generated projects and their independent visual/interaction checks. Existing systems do not imply Qwen Design support. |
| Other models and platforms | Existing integrations and the individually documented historical checks remain available. | A pass on one model or an Apple Silicon Mac does not qualify every model, CUDA, ROCm, Vulkan, CPU or Windows. |

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
   is integrated; do not advertise unsupported combinations.
3. Finish real native-desktop, installation/recovery and hardware-specific
   acceptance. Missing hardware or weights mean not run or blocked, never passed.
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
