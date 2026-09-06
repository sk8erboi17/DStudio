# Search, multimodal research and agent comparison — implementation and evidence

The starting publication is `c3329de`. The earlier native-agent/Task Graph and
original-Design comparisons do **not** cover OpenWork or OpenDesign's runtime.
This checklist records the delivered scope and its remaining quality limits;
passing a narrow subtest must not be presented as general product reliability.

| Requirement | Evidence needed | Current status |
| --- | --- | --- |
| Better Search and Deep Research | Matched questions, read sources and independently checked answers before/after | Latest answer-review replay: 4/4 checked requirements versus previous 2/4, on two Search and two Research development questions. Three rejected update attempts remain in the [complete-pipeline report](../extension/search/bench/PIPELINE.md); not a held-out/general score or model self-rating |
| Vision models can inspect web images | Real page pixels reach the selected native vision model; text-only models receive an honest limitation | Actual Vision-Exp reads both graphics; final complete 8-case replay confirms 3/8 before and 8/8 after. Other vision models and arbitrary images are not qualified by this run |
| Quality gates without excessive latency | Behavioral regressions plus real-model correctness and per-phase latency, with failures retained | Bounded work/cancellation gates, two-pass excerpt regressions, original-request handoff and unknown-citation checks pass. Reviewed per-requirement gate rejects the first focused candidate and accepts the final candidate without turning known failures into passes |
| Improve Agent and Cowork; compare OpenWork | Pinned actual OpenWork runtime, matching model/tasks, independently reopened files and results | Remote workspace regression fixed; corrected paired replay passes both code/document tasks for DStudio and OpenWork; original failures retained |
| Compare Design with OpenDesign | Pinned actual OpenDesign runtime, matching briefs/model, rendered artifacts and working-control audit | DStudio passes the specified controls but fails radio-label layout at phone/desktop widths. OpenDesign hits the task deadline and its partial file has runtime JavaScript errors. Original screenshots retained; no general ranking claimed |
| Publish clear README examples | Exact prompts, real generated website screenshots, Matplotlib charts and public measurements | Product comparisons, exact prompts and actual desktop/phone screenshots published; complete-pipeline and final evidence replay charts/data added with every failed outcome retained |

## Initial observations

- `extension/search/runtime.js` is the editable search implementation;
  `scripts/sync-search-extension.mjs` embeds it into `web/index.html`.
- Baseline page extraction chose a leading excerpt, truncated it again for
  storage, then gives the evidence extractor only the first 5,200 characters.
  Relevant later sections can disappear before the model sees them.
- At baseline, research model helpers ignored their timeout argument and the
  pipeline deadline was infinite. Investigate bounded cancellation and control before
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
the failing live pilot is retained. The corrected real-model Agent/Cowork replay
now passes both tasks for DStudio and OpenWork, including independent reopening
and execution of the actual files.

## Bounded full-pipeline work and current comparison

Search now admits at most 6 unique queries, 8 page attempts and 96 candidate
sources; Research admits 18 queries, 24 page attempts, 12 follow-up actions and
256 candidates. The source cap includes adapters, not only search responses.
The soft admission deadlines are 10/30 minutes; an already running operation
and the final bounded writer may finish afterward. Model calls honor their
requested deadline with a hard 15-minute ceiling. These deliberately generous
ceilings accommodate slow local models; they are not a latency improvement claim.

The behavioral gate executes the actual orchestrator with simulated evidence:
continuously novel but irrelevant pages cannot keep resetting the stall counter
forever; successive batches share budgets; cancellation rejects late search
results; deadlines abort the transport. Completed facts survive exhaustion,
the sufficiency state becomes incomplete, and the limitation remains in both
the returned report and model context even if the writer omits it.

The full public-web evaluation runner is
`tests/live/research_pipeline_benchmark.mjs`: real discovery, page reads, model
classification/extraction/judgment/synthesis and final answer, alternating
before/after. Its fixed questions cover an HTTP standard, versioned Python
behavior, planetary science and accessibility requirements. Expected answers
come from independently inspected RFC/Python/NASA/W3C sources, not a model
self-grade. Results remain provisional until all answers are reviewed.

The completed initial product pilot exposed test-harness defects as well as
production defects. OpenWork was initially queried before its managed proxy
was ready; those zero-inference attempts are setup failures, not a score against
OpenWork. The first browser audit also required an uppercase brand, placed the
demo disclosure earlier than the prompt required, and incorrectly routed the
second product's artifact to 404. All original receipts remain; behavioral
regressions cover corrected brand/disclosure semantics and real HTTP routing
for both products. Unchanged artifacts were re-audited equally. DStudio's
website passes the specified workflow; OpenDesign's partial saved page fits
all three widths but its Continue flow fails with actual JavaScript exceptions.
Both aesthetic merits and limitations must be judged from the real screenshots,
not those pass/fail counts. The Agent/Cowork corrected replay is separate from
the original failed attempts.

## Earlier focused-evidence investigation and limits

The [complete-pipeline report](../extension/search/bench/PIPELINE.md) retains
all three complete collections plus the documented interrupted collection.
The focused-v1 candidate lost an answer despite lower times and was rejected.
Follow-up fixes retain rule/scope text around excerpt boundaries, prevent URL
menus from dominating relevance, preserve original writer requirements, allow
explicitly grounded rule application and reject unknown citation IDs. The
model-free tests execute these behaviors; they do not pretend to measure model
quality. Both live runners now require those prerequisites before loading weights.

That four-question replay preserves all previously demonstrated individual
requirements. Nevertheless only 2/4 final answers meet **every** requirement:
NASA's source-definition conflict remains unresolved, and the otherwise correct
WCAG response still exceeds its requested word limit. Passing the non-regression
gate is not a semantic correctness guarantee. All sixteen complete-answer
durations and all failed outcomes are shown in the Matplotlib chart. The
subsequent full Vision-Exp evidence replay confirms 8/8 after the final source
changes, with separate data/plot and no replacement of the initial receipts.

Broader held-out research, curriculum quality, additional vision models,
WebKit UI qualification and repeated product tasks remain outside these small
development comparisons. Those limits are documented rather than inferred
from a passing build, two graphics or a single generated website.

## Answer review and visual benchmark correction

The answer-review update compares shared-number definitions before a draft,
checks the complete collected evidence, bounds corrective rewrites and counts
explicit supported word ceilings. The exact reviewed answer reaches the saved
assistant message without a second generation. Failed reviews remain incomplete.
The model reviewer is not independent verification: live attempts exposed both
a missed definition conflict and an invented gap that it incorrectly approved.
All rejected attempts and the parser failure remain in the
[measured report](../extension/search/bench/PIPELINE.md).
The latest complete replay passes all four checked questions and the
per-requirement non-regression gate, with 193/189-word Research reports.
Their observed 312/293-second durations are higher than the earlier failed
answers; correctness, not faster completion, is the demonstrated improvement.

The Design benchmark's original functional pass did not establish visual quality.
An actual Chromium geometry regression now reproduces the malformed radio label
columns at 390 and 1440 px, distinguishes the unaffected 768 px layout and checks
an independent good fixture. The original generated HTML and screenshots remain
unchanged; neither the passing regression detector nor corrected chart labels
mean the generated Design output has been repaired.
