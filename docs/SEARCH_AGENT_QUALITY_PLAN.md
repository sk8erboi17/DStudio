# Search, multimodal research and agent comparison — work in progress

The starting publication is `c3329de`. The earlier native-agent/Task Graph and
original-Design comparisons do **not** cover OpenWork or OpenDesign's runtime.
This checklist preserves the full requested scope; a completed subtask is not
completion of the project below.

| Requirement | Evidence needed | Current status |
| --- | --- | --- |
| Better Search and Deep Research | Matched questions, read sources and independently checked answers before/after | Real page/evidence development comparison: 3/8 before, 8/8 after; complete pipeline evaluation pending |
| Vision models can inspect web images | Real page pixels reach the selected native vision model; text-only models receive an honest limitation | Actual Vision-Exp run reads two graphics correctly; bounded browser and capability gates pass, broader model/visual coverage pending |
| Quality gates without excessive latency | Behavioral regressions plus real-model correctness and per-phase latency, with failures retained | Evidence/Stop gates pass; overall latency budgets and live evaluation pending |
| Improve Agent and Cowork; compare OpenWork | Pinned actual OpenWork runtime, matching model/tasks, independently reopened files and results | Actual server compiled/API setup exercised; pilot exposed remote workspace regression, fixed with real-tool gate; matched rerun/audit pending |
| Compare Design with OpenDesign | Pinned actual OpenDesign runtime, matching briefs/model, rendered artifacts and working-control audit | Actual daemon compiled, project API exercised; real-model pilot/audit in progress, no product ranking claimed |
| Publish clear README examples | Exact prompts, real generated website screenshots, Matplotlib charts and public measurements | Search evidence chart/data/report prepared; actual competitor-generated website screenshots still pending |

## Initial observations

- `extension/search/runtime.js` is the editable search implementation;
  `scripts/sync-search-extension.mjs` embeds it into `web/index.html`.
- Baseline page extraction chose a leading excerpt, truncated it again for
  storage, then gives the evidence extractor only the first 5,200 characters.
  Relevant later sections can disappear before the model sees them.
- Research model helpers ignore their timeout argument; the current pipeline
  deadline is infinite. Investigate bounded cancellation and control before
  adding more concurrent work or arbitrary shorter model timeouts.
- The legacy report prompt required 10,000 words and contained a fixed 2025 date.
  Report depth should follow the user's question and available evidence.
- Baseline page reads returned text/metadata, not inspected image pixels. Adding
  image URLs or alt text alone cannot establish multimodal research support.
- Keep the private before source/binary snapshot and all experimental outputs in
  ignored, task-owned artifact directories. Pin competitor source revisions and
  inspect their actual public invocation path before running a benchmark.

Primary comparison repositories:
[OpenWork](https://github.com/different-ai/openwork) and
[OpenDesign](https://github.com/nexu-io/open-design).
They are comparison targets, not dependencies to vendor into DStudio.

## First implementation tranche

- Query-aware literal excerpts now survive both page ingestion and the 5,200
  character extraction input. The selector examines at most 256k characters,
  retains a source introduction and marks omitted spans. It adds no model round
  and does not increase the existing prompt budget. It is lexical selection,
  not a claim of perfect semantic retrieval or complete-page coverage.
- Removed the legacy mandatory 10,000-word report and fixed 2025 date. Report
  scope follows the request/evidence; the application supplies the current date.
- A late result after Stop is rejected before publication. Per-source extraction
  no longer swallows cancellation and advances to another page. The real-test
  HTTP adapter now forwards cancellation and retains its independent deadline.
- `make test-search-evidence test-frontend-unit` passes: 27 deterministic
  evidence/cancellation cases, actual loopback HTTP cancellation/deadline checks
  and existing frontend behavior. Model replies in the evidence gate are
  simulated. These are not a real-model quality or speed benchmark.

Comparison checkouts are pinned to
[OpenWork `6c5dfca`](https://github.com/different-ai/openwork/commit/6c5dfca66a239b65a113fc7c787e5e17de43d59b)
and [OpenDesign `3d0d15f`](https://github.com/nexu-io/open-design/commit/3d0d15fc55031e8e6cead709491e7b82565c4dee).
Their actual server/daemon invocation and model configuration must be exercised;
running an unrelated generic OpenCode command does not count as either product.

## Bounded page pixels

- `patch/ds4-web-vision/` adds a reversible, build-time-only adaptation of the
  native web helper. Upstream files are not edited by this adaptation. Text and
  one 1024×768 JPEG viewport come from the same owned page target. A bounded
  DOM scan selects the first substantive image/chart and scrolls to its position;
  URL changes discard the pixels. Offscreen/obscured content is not claimed as
  visually inspected. This is not full-page image retrieval.
- `/api/web-read` accepts `includeImage: true`. Capture failure keeps readable
  text and reports `visual.status: unavailable`; image URLs/alt text are not
  accepted as captured pixels. JPEG payloads are capped at 768 KiB encoded;
  fragmented CDP messages have an aggregate 4 MiB bound.
- Search/Deep Research admits at most three capture attempts per run, only
  when the active engine reports ready native vision matching the selection.
  Extraction sends actual `image_url` data-URI content, checks the active model
  again before publishing, and labels visual observations separately from text.
  Scratch pixels are non-serializable source properties, released on extraction;
  no screenshot blob is saved in chats, traces or reports. Text-only models do
  not request pixels or admit model-claimed visual facts.
  Pages without a substantive graphic return `not_needed`, skip screenshot
  encoding/model-image work and do not spend one of the three capture slots.
- `make test-web-visual-unit` exercises the native response adapter.
  `make test-web-visual-browser` compiles the produced browser code against all
  four local engine source trees and runs isolated headless Chrome. Actual JPEG
  decoding verifies magenta-left/green-right fixture pixels, source identity,
  preserved offscreen text, unchanged text-only output and owned-tab cleanup.
  It also verifies below-fold graphic pixels and the no-graphic fast path.
  The four `ds4_web.c` inputs currently share SHA-256
  `c6baf247c8063b80bac793ee6a031a352299be6632eaceac81f3bc5f302367c4`;
  this is **browser-helper compatibility**, not four-model vision support.
- Two original browser-test failure receipts are retained. They exposed a
  grader defect: `/json/list` includes Chrome UI/background workers, not only
  owned page targets. The corrected gate compares the exact original page-ID
  set and has a deterministic regression proving an extra page still fails.
- Primary API oracle: [Chrome DevTools Page.captureScreenshot](https://chromedevtools.github.io/devtools-protocol/tot/Page/#method-captureScreenshot).
  Native model input oracle: the pinned engine's `ds4_server.c` image content
  parser and `ds4_engine_vision_encode_memory` path. No image URL fetching is
  delegated to the model. Chromium tests do not qualify WebKit UI behavior or
  Windows/CUDA execution.

## Real-model evidence and the first product pilot

[Public page-evidence comparison](../extension/search/bench/README.md): eight
development questions, full paired version-2 run, actual Chrome/HTTP and native
Vision-Exp. Before answered 3/8 correctly; after 8/8. Timings are shared-host,
not consistently faster, and include the 52-second outlier. Original fixture
and grader errors are documented separately, not erased by the new run.

Both pinned competitor checkouts build successfully. OpenWork's actual server
must report its managed OpenCode proxy ready, not just `/health`; the listener
binds before the managed engine. OpenDesign's daemon creates and reopens a real
project through its public API. Both use task-owned data/config directories
outside the DStudio checkout, not the user's saved configuration. No generic
standalone OpenCode result is counted as either product.

The initial real Agent/Cowork pilot exposed a DStudio adaptation regression:
newer upstream opens the engine before changing working directory, but remote
mode returned earlier and skipped that change. Its tools searched the engine
checkout instead of the selected project. The remote entry now changes directory
exactly once before returning; old and new upstream layouts share that path.
`make test-remote-agent-workspace DS4_DIR=ds4` proves actual read/write/bash effects
for absolute/relative paths and rejection of a missing directory without model
work. The original binary passes only the missing-directory case (1/3); the
fixed main and Laguna binaries each pass 3/3. A full Agent build attempted on
Qwen3.6 is unsupported and fails at existing edit 070; no passing Agent claim
is made for Qwen, whose advertised integration remains Chat/native. The separate
four-source browser-helper gate passes. Model replies in the workspace gate are simulated;
the failing live pilot is retained and a corrected live rerun is still needed.

Next: measure matched complete research cases before selecting overall latency
budgets; independently audit and rerun the actual product pilot. Keep
Agent/Cowork improvements, both competitor comparisons and README
prompt/screenshots as separate required deliverables after those foundations.
All published benchmark charts must use Matplotlib, with reviewed public
measurements, plotting scripts and PNGs committed to GitHub as for Task Graph;
these model-free gates are not benchmark evidence of better answers or speed.
