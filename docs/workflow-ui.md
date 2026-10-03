# GSA and RSA workflow

In Agent mode, **Open RSA/GSA** opens the workflow beside the existing IDE and
Blueprint controls. Choose GSA or RSA, enter a mission and target, review the
workspace and security profile, and start the analysis. The four phase cards,
activity, findings, output and artifact preview use the layout supplied in the
workflow design. They show the current run rather than seeded demonstration
events.

The view uses the existing native GSA/RSA admission and phase-save endpoints and
Agent runtime. A phase becomes **Saved** only after the native phase-save reply
accepts it. The displayed effective profile comes from native admission; it can
differ from the requested profile. Tool availability is accessible inside the
workflow.

**Pause after phase** lets the current phase finish and save, then holds the next
prepared prompt. **Resume** sends that prompt once. **Next phase** runs one queued
phase and pauses again after its save. **Stop** interrupts the current runtime
and prevents deferred admission or save replies from advancing the pipeline.
Earlier saved artifacts remain available. A save already accepted by the host
can still appear after Stop; the run remains stopped and no next phase starts.
If a native phase save is still pending, starting another analysis stays disabled
until that save settles. With Loop enabled, pausing during the final report lets
the report save and then exposes **Resume loop**. The next iteration starts only
after that explicit resume.

Conversation metadata stores bounded run pointers. Reopening or reloading reads
the native `run_state.json` and lists the selected run's files. It does not replay
a model request. Artifact previews display bytes read through the existing
workspace file endpoint. Phase output is a derived view and does not replace a
saved file.

After a run is admitted, setup collapses to leave space for its activity and
evidence. **New analysis** reopens setup for an inactive run. Iteration controls
open earlier saved runs, and **Follow current run** returns to the active iteration.
The iteration selector fits its complete selected label, and target, workspace
and effective profile values wrap within the metadata cards.

When the selected phase is running or awaiting native save acceptance and has no
activity rows, Activity shows a blue spinner with rotating terminal-inspired
phrases. Its status identifies the pending work; the decorative phrases are not
tool events or completion evidence. Actual activity replaces the indicator.
Closing the view, leaving Activity or inspecting another phase stops its timer.
Reduced-motion preferences use a static indicator and phrase.

## UI verification

The browser test runs the production UI with explicitly simulated native HTTP
responses, phase persistence and file content. It never launches an engine,
loads weights or runs inference. The simulated fixtures do not establish model
quality or native inference correctness.

```sh
make test-ui-workflow
node tests/browser/ui_workflow_playwright_test.mjs
DSTUDIO_TEST_BROWSER=webkit node tests/browser/ui_workflow_playwright_test.mjs
node tests/browser/ui_gsa_playwright_test.mjs
node tests/browser/ui_rsa_playwright_test.mjs
DSTUDIO_TEST_BROWSER=webkit node tests/browser/ui_gsa_playwright_test.mjs
DSTUDIO_TEST_BROWSER=webkit node tests/browser/ui_rsa_playwright_test.mjs
```

The workflow test covers admission inputs and effective profile, native save
acceptance, pause/step/resume ordering, cancellation during preparation and
phase save, retained committed effects, reload without replay, native rejection,
host-byte artifact previews, missing state and retry, nullable artifact rows,
isolation from older phase events, loop/history/follow controls, dark/light
themes and narrow layouts. It also checks complete iteration labels at 1360px
and 600px, wrapped metadata without clipped text or excess card height, editable
setup values, waiting-indicator lifecycle, real tool activity replacing the
indicator, and reduced motion. A virtual browser clock checks phrase rotation
and timer shutdown; HTTP barriers control phase-save ordering directly.
Screenshots and JSON receipts, including failures, are written under ignored
`tests/.artifacts/ui-workflow/`.

The scoped checks passed on macOS in Chromium and WebKit: 18 workflow cases in
each browser through `make test-ui-workflow`, plus the existing GSA and RSA UI
suites in both browsers. These include the pending-save admission guard and
pause/resume across a final report and subsequent loop iteration. Earlier
failed receipts are retained; the reload failure exposed an admitted run pointer
that had only been scheduled for persistence. Admission now saves that pointer
before dispatch. Later retained layout failures exposed native select border
space missing from its intrinsic size; matching the sizing box resolved the
clipping. The final screenshots also verify the compact setup and waiting
indicator in light and dark themes. UI-only verification does not qualify
real-model execution, and these checks do not restart the app or models.
