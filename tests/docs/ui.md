# Browser and native-window UI

[All test guides](../README.md). Run commands from the repository root.
Each section retains its original scope, prerequisites, results and limitations;
a historical pass is not a pass on a newer runtime.

## Aperture startup screen

`make test-ui-loading` executes the real startup page in WebKit and Chromium
with a **simulated HTTP launcher**, plus the production saved-settings function.
It covers configured context/SSD preferences, native theme messages, effective
configuration and model identity, engine-reported memory plans and prefill,
DSpark byte estimates and explicit confirmation, occupied ports, responsive
small-window layouts, reduced motion, and explicit error recovery. Startup
failures remain readable until the user opens DStudio. An activity animation
changes the active arc without changing reported percentages or completed
phases; it stops for errors, confirmation, readiness and reduced motion.
Response barriers and browser clocks keep a preparation pending for a simulated
hour: the single start request must remain connected, status polling must
continue and old-engine readiness/counters must not finish the new attempt.
The native start reply follows preparation, so that request has no elapsed
preparation cutoff; individual status requests remain bounded. Response barriers
verify unknown initial counters and the ready indicator before navigation.
An admitted preparation must not be launched again; a pending replacement
must not inherit the previous engine's ready flag. Model/configuration changes
clear old metrics and progress. No time-based progress simulation or external
font, framework or image downloads run on the startup page.

The checks are included through `test-ui-browser` in `check-fast`. Both
Playwright browsers must be installed. Each run retains screenshots in a new
`tests/.artifacts/loading-design/BROWSER-*` directory. The prior failed layout
and duplicate-start regressions are retained privately. These tests verify UI
and HTTP behavior, not real model loading or answer quality. The native host
and macOS bundle have separate scoped checks; other desktop platforms remain
outside this rendering run.

## Sidebar and native macOS title bar

`make test-ui-sidebar` runs the production page in WebKit and Chromium with a
simulated launcher. It verifies the Rail layout (80px mode rail to contain all
three native window controls, 220px history panel), all five mode controls, collapsed history with visible
mode labels and Settings, persisted collapse, conversation selection,
pin/rename actions, creation from the conversation header and narrow windows
in both themes. History, workspace paths, learning completion and background
activity remain views of the existing conversation/stream owners; no sample
conversations or runtime measurements are installed from the reference mockup.
Screenshots and receipts are retained under `tests/.artifacts/sidebar/`.
Raster checks verify that each pane's color continues through the top inset in
both themes. The rail/history divider reaches the top; the history/chat divider
is removed. Collapsing history keeps the widened rail and all mode controls.

`make test-macos-window-theme` creates an actual Cocoa window and WKWebView
using the production wrapper. It verifies full-window content under native
window controls, no title-bar separator, the reserved 28px content inset and
real JavaScript theme messages in both themes. The transparent native drag view
receives top gestures without painting over the web panes. Hit testing verifies
all three window buttons, selectable WebKit content and the drag area after a
resize. It requires macOS and is included
in `check-fast` there; unsupported platforms report NOT RUN. The browser checks
are included in `test-ui-browser`. Neither check runs inference.

`tests/support/macos_window_preview.mjs` provides a separate, operator-driven
native window fixture. Pass the built `tests/.build/macos-window-theme` binary
and a captured `ui-document-policy/RUN/document.json` artifact. The task-owned
bundle uses simulated loopback APIs, origin-scoped settings/conversations and
synthetic images; it never opens the operator's DStudio profile or starts an
engine. Its bounded recording retains actual native window frames, move/input
events, original-image Blob decoding and HTTP requests. This checks OS dragging
separately from Playwright. Its five-minute limit belongs only to this isolated
preview. Native screenshots also verify text selection without moving the
window; successful automated hit testing alone does not prove OS dragging.

## Open IDE (Agent workspace view)

`make test-agent-workspace` executes the real `/api/agent/fs/list`, `read` and
`write` handlers and the real connection dispatcher on a task-owned temporary
workspace, with a task-owned idle child standing in for the Agent process. It
checks that only a running Agent exposes its workspace, that relative-path
syntax and symlink escapes are refused, that only lossless UTF-8 text is
published, that saves are refused while the agent works or when the digest is
stale (leaving the bytes unchanged), that an admitted save replaces the exact
bytes atomically with the original permission bits, that CSRF and the large
save body path work over a real 127.0.0.1 connection, and that the endpoints
stay host-local with LAN enabled.

`make test-ui-agent-ide` runs WebKit and Chromium against the same real
handlers through `tests/support/agent_workspace_host.c`. The agent stream is
**simulated**: events are scripted in the format recorded from
`ds4-agent-jsonl`, and the test performs each tool's file effect itself. It
covers the header button, the thought bubble (live reasoning, the last thought
kept while the agent writes without covering its caret, dismissal until the
next thought), the
live cursor and follow mode (a partially streamed path never opens a tab), the reload from disk
after `tool_result`, edit and terminal streaming, the read-only lock while the
agent works, exact-byte saves after the turn, conflict handling, the host-side
refusal while the agent works, and Task Graph access. Receipts and screenshots
are written to `tests/.artifacts/ui-agent-ide/`. It does not exercise a model
or measure inference.

The same target runs `tests/browser/ui_design_ide_playwright_test.mjs` in both
browsers. It serves the same real handlers in Design mode
(`agent_workspace_host design`) from a folder that already holds a user file,
and the page and security headers exactly as the native host serves them, so
both preview frames run under the production policy. The Design stream is
**simulated** in the event format produced by `ds4-design`. It checks that the
brief has no IDE and that Start stays enabled for a non-empty folder, the
**Open in IDE to see it live** shortcut, the Code · Split · Design layouts and
their persisted divider, the blank artboard before `<body>` and the
colors/classes the stream actually declared, and the streamed body in the
host-served live frame (opaque origin; the page's `<script>` and inline
handlers stay off; its relative stylesheet loads). With real wheel input it
scrolls the page in Split and in Design while further batches arrive and
asserts that the position and the document itself survive each update; after
`tool_result` the saved bytes stay in the same frame until the turn ends, and
the patched document equals a fresh parse of the same bytes. It then checks the
saved file with scripts on after the turn, the canvas shortcut, and a user's
unsaved edit previewed and then saved byte for byte. `make test-agent-workspace`
also checks that clearing a Design project removes only files the run created
(refusing when the folder had more files than the snapshot can track) and that
the live frame's policy allows only its own bootstrap, by a nonce that is
fresh for each response. The Agent IDE test holds background re-reads of the
file it changes on disk, so its conflict step always exercises the host's
digest refusal instead of depending on timing.

`make test-ui-native-titlebar` runs WebKit and Chromium with the 28px
title-bar inset that DStudio.app injects (`--native-titlebar-height`, top frame
only). It checks that no operable control in the main window or the Learn study
room reaches into that strip, where the window controls sit and a native view
turns clicks into window drags, and that the study room's top bar paints across
it. The Design IDE test applies the same inset and checks the Design canvas and
the fullscreen artboard. The runtime and roadmap are simulated; the native
window itself is not exercised.

## Blueprint (Agent)

`make test-blueprint-core` (part of `make test-frontend-unit`) executes the
production `createBlueprintCore` from `web/index.html`: every prefix of a
streamed spec parses without throwing and only adds nodes; validation drops
unknown endpoints, duplicates, unsafe paths and excess items and reports each
drop; reach and routes follow stated relationships only, cycles included;
citations are verified, moved, unverified, missing or unquoted against file
text, each cited file read once and bounded; layout is deterministic with no
overlapping nodes and every node inside its lane; the SVG escapes every author
string; the prompt names the file, schema and evidence contract; the Design
hand-off lists every part and relationship and stays under 26k characters for
the largest spec the schema keeps; the implement prompt follows the blueprint
basis.

`make test-ui-blueprint` runs WebKit and Chromium against the real host
workspace handlers and the real `/api/fs/mkdir` on a task-owned workspace. The
Agent stream is **simulated** in the ds4-agent-jsonl event format and the test
performs the write. It covers the header button, the production prompt and file
path, the diagram building from the streamed JSON, verification of each kind of
citation outcome against the workspace bytes, node evidence, upstream and
downstream trace, routes (including none), lens, find, opening a citation in the
IDE at its lines and returning, the standalone HTML export opened in a fresh
page, the new-blueprint card, a sequence diagram, an invalid file, reopening
the last blueprint after a reload, **Implement code** (the implement prompt in
the same conversation, on the running engine, without a new session) and
**Send to Design** (Design starts on `design/` inside the project, the blueprint
card waits for the user's brief and goes with the first message only). Design
startup is simulated too: no design engine or model runs.

`make test-blueprint-live` is **real inference**: an isolated DStudio host
starts the Agent with actual DeepSeek V4 Flash weights (one instance; run it
alone) on a copy of the held-out `tests/fixtures/blueprint/ticket-service`, sends
the production prompt for an architecture map and for a cache-miss sequence,
and grades the written specs with the production validator and verifier against
an independent oracle written from the fixture's code: components found,
expected relationships, unsupported relationships, cache-miss ordering and the
share of citations whose quote occurs in the cited file. Thresholds are fixed in
the test. Prompts, transcripts, written specs, SVGs, grades, model identity,
timings and failures stay in `tests/.artifacts/blueprint-live/`. A missing model
or a run exceeding `DSTUDIO_REAL_TEST_TIMEOUT_MS` is reported as failed/blocked.

First real run, October 2, 2026, on this Apple Silicon Mac (96 GB) with
`DeepSeek-V4-Flash-Vision-Exp-IQ2XXS-w2Q2K-AProjQ8-SExpQ8-OutQ8.gguf`, Agent
mode, thinking high, 65,536-token context, SSD streaming off: **2/2 passed**.
Architecture (786 s turn): 7/7 components, 6/6 expected relationships, 0
unsupported, 43/43 citations found at their cited lines (25/25 claims). Cache-
miss sequence (564 s turn): 4/4 participants, cache read → database read →
cache write in order, 33/33 citations found at their cited lines. Engine start
took 50 s. This is one held-out repository and two prompts: it shows the
pipeline works with the real model, not that every repository or model maps
correctly. The written specs, transcripts and SVGs are retained in the run's
artifact folder.

## GSA/RSA workflow workspace

`make test-ui-workflow` executes the production workflow in WebKit and Chromium
with **simulated native HTTP replies and filesystem bytes**. It covers the
**Open RSA/GSA** header control, removal of duplicate controls from the composer
menu, admission inputs and effective profile, phase-save barriers,
pause/step/resume, Stop during preparation and save, retained committed effects,
reload without replay, rejection, artifact previews and both themes at narrow
and desktop sizes. No model or tool subprocess starts. Screenshots and receipts,
including failed runs, remain under `tests/.artifacts/ui-workflow/`.
See [workflow behavior](../../docs/workflow-ui.md) for ownership and limits.

## Image previews under the native HTTP policy

`make test-ui-document-policy` starts the real HTTP host with an empty,
task-owned profile and deferred inference. It captures the produced bundled
page and security headers, then serves those exact bytes to WebKit and Chromium
with all runtime APIs simulated. Host status must remain not running before and
after capture. Each browser must prepare a local PNG, decode its Blob preview
and open the original-resolution viewer; Blob scripts and foreign frames must
still be blocked. It then executes all 15 image interaction cases in each
browser under the captured policy, including the installed-encoder/inactive
runtime error and retry with the original image bytes intact. This is image
admission/rendering evidence, not real-model vision qualification.

The original production policy blocked the session-owned Blob image URLs even
though fake-server image tests passed. Only image loading now permits Blob URLs.
Failed and successful receipts remain under ignored
`tests/.artifacts/ui-document-policy/` and `tests/.artifacts/chat-images/`.
Playwright with both browsers and Python/Pillow are required. No model downloads,
weight changes or live generation run in this target.

## Complete simulated UI matrix

`make test-ui-simulated` executes 25 browser suites in each of real WebKit and
Chromium, plus Learn/Tutor replays for all three Qwen model families with stale
checkout fixtures (56 suite executions). All launcher, generation, tool, installation,
download and persistence responses are isolated loopback fixtures. It never
starts DStudio, inference engines or weight downloads. The new image/selection
fixtures reject outbound requests and fail unknown endpoints. Clipboard writes
are simulated in both browsers so the operator's clipboard remains untouched.
Missing dependencies, browser errors, failed assertions and test-process
deadlines fail the matrix; they are never counted as passing or skipped.

| Surface | Observable coverage |
| --- | --- |
| Startup and navigation | Aperture phases, pending/failed launch, matching attempt identity, recovery, rail/history layout, both themes, pin/rename/new/collapse and narrow windows |
| Composer and settings | Model compatibility, context and thinking controls, gear menus, simulated install/download progress, preferences, transport and launch controls |
| Chat media | Picker/drop/paste, six-file/size admission, preparation failure/removal, stale-owner cancellation, original-image save/copy, galleries, overflow images, keyboard navigation, zoom, mobile viewer, persisted previews and generated media |
| Chat and Research | Enter/send, exact copy, edit cancel/save, regeneration, visible failure/retry, streaming, background conversations, host-store restoration in an empty browser profile, reading position, retained text, Stop, incomplete outcomes and research progress |
| Agent, Cowork and Design | Simulated native transcripts, tool/diff rendering, workspace attachments, document-table evidence, questions, plan/GSA/RSA controls, sandboxed artifact selection and annotation, reopen/resume |
| Learn and Tutor | Research-backed roadmap creation, audits/retries, graph editing, progress, PNG/export, study history, context steering, thinking/model controls, native image parts, attachment isolation and stable mouse/keyboard study targets |

`make test-ui-chat-images`, `make test-ui-chat-controls`, `make test-ui-selection`,
`make test-ui-stability`, `make test-ui-stream-interaction` and
`make test-ui-roadmap-hover` are focused entry points.
Image bytes are synthetic fixtures under `tests/fixtures/ui-images/`. Original
blobs live only in the browser session; persisted thumbnails are explicitly
labeled **Preview** and save with a preview filename and matching encoding.
Remove, conversation changes and room closure discard late preparation; earlier
ready attachments remain available. Deterministic blocked PDF replies verify
Stop/retry, room closure and immutable admission: files added during a read stay
available for the next send. These checks do not claim real-model vision
quality, media synthesis quality or operating-system drag/clipboard integration.

The selection suite sends slow (220 ms per chunk) and fast (12 ms per chunk)
simulated streams to Chat, Agent, Cowork, Design and Tutor. Actual mouse drags
select text and extend upward through autoscroll while new chunks continue.
Both ongoing updates and final completion must preserve the exact selected
passage and reading position. Releasing selection must expose accumulated text,
and the persisted response/transcript must retain every simulated byte/event.
Chat/Tutor comparisons apply their existing final-answer edge-whitespace
normalization; native transcripts are compared byte-for-byte, including tool
and session protocol events.
Syntax-highlighted code is selected with the mouse too. Design exercises its
live task list and releases a held initial hydration response between the real
Send mouse-down and mouse-up. The form must remain attached, preserve the draft
and admit exactly one turn. The same fixture fails against the previous brief
rebuild in both browsers; its receipts are retained. Artifact controls also run
in the existing Design suite. The checks do not use DOM Range APIs to manufacture selections;
range geometry only locates mouse targets.

The stability suite adds 15 cases per browser across all five modes: a held
passage, a drag extending into the heading, and actual Select All. Slow and
bursty simulated streams keep working through explicit update/completion
barriers. Bounded animation-frame observations check that the original endpoint
nodes/offsets remain attached, the complete protected passage stays selected,
and the reading position does not jump. The held passage must also retain
identical screenshot pixels before and after the updates. A real click clears
the highlight and exposes all deferred text; persisted bytes are checked
independently. Selection covering changing header clocks may legitimately
change its full string, but not the protected passage or endpoint identities.

The interaction suite adds ten cases per browser: slow (180 ms per chunk) and
fast (10 ms) generation in Chat, Agent, Cowork, Design and Tutor, using both
themes. Real upward/downward wheel gestures establish the reading position.
Actual keyboard selection in a Unicode composer draft must retain its focus,
value, extent and direction through four consumed updates and completion.
Frame observations also check the visible passage's position without a document
selection hiding a rebuild. Design's live progress rows intentionally retire
into a completed transcript; its composer invariants still apply. The quiet
fixture barrier permits the production persistence debounce to run without
completing the request. A producer-tick barrier avoids making the slow-stream
assertion depend on the duration of a short wheel gesture.

The roadmap control suite adds four cases per browser (two themes, 1100px and
760px widths). It moves to the original visible Study coordinates and performs
one mouse-down/up, rather than letting a locator retry a control that moved on
hover. Revealing Add/Delete must not move Study or intercept that click.
Keyboard traversal uses Tab in Chromium and Option-Tab in macOS WebKit, keeps
the control geometry stable, and preserves the study draft when reopening.
An actual upward mouse drag selects the study heading and description before
opening a different block. Both the static title and inner context must show
that new block: WebKit's transient old range must not hold an old thread's body
behind the new title. Selection protection applies to updates of the same
thread; an explicit thread change must publish its own content.
Narrow mode selection must close the drawer and update its expanded state.
After marking a topic complete, the suite edits a new block and reopens the
active conversation. The original form must stay connected with the same field
values and saved completion state. This reproduces the formerly stale message
view key that discarded drafts and active expansion controls on a later render.
No generation is required by opening or reopening a study.

Chat, Agent/Cowork/Design and Tutor use the same `createTranscriptInteraction`
handler for pointer ownership, wheel/keyboard input, edge autoscroll, selection
protection and deferred repaint release. It wraps the existing follow-scroll
algorithm, binds once to each persistent reader and retains at most one pending
repaint notification. Conversation changes reset that notification. Text and
thread identity stay in their existing owners; the domain callback revalidates
the displayed conversation before rendering. All five modes run the same mouse,
keyboard, completion, reading-position and persistence regressions.

The Learn fixture also holds its first source-read HTTP response until the
current URL appears in the loading panel. It checks real trace updates, elapsed
and quiet-interval feedback, and the single shared composer Stop. A simulated
native learning launch resumes a cancelled request in the same conversation and
is consumed once across reload. These are UI checks with simulated inference,
not real-model roadmap acceptance.

The broader Learn fixture holds its first expansion response until the live
status and disabled submission control have been observed. Recovery tests pause
the fixture browser clock and drain owned HTTP work before injecting their
snapshot, then resume immediately after reload. This prevents the old document
from overwriting the injected input and keeps intentional navigation from racing
its background requests. Browser errors still fail the test. The selection,
wheel, raster and composer stability suites use the normal browser clock.

The regressions address reader-spanning selection being detached, estimated
layout heights/unequal live and completed native typography moving a passage,
duplicate deferred bottom scrolling overriding fresh input, caret rounding
changing the autoscroll anchor, and roadmap hover controls moving under the
pointer or progress updates discarding the active block editor. Original failing
receipts are retained. The selection gesture starts
inside a word: Chromium also collapses the former trailing-space diagonal drag
in a static DOM with all application scripts removed. The revised oracle checks
the complete intervening line and the exact actual browser anchor, without
manufacturing a DOM selection.
The study-context gesture similarly targets a glyph inside the description's
word. An independent static HTML control also collapses Chromium's former
glyph target, including without application styles or scripts. The replacement
gesture still must select both the heading and the intervening description;
original failed fixture receipts and the static control remain in artifacts.

Research's HTTP-barrier test also uses real mouse selection during discovery
progress and on retained writer output after a transport failure, recording
`research-selection.gif` under `tests/.artifacts/research-progress-browser/`.
The local persistence fixture returns the native host's JSON object in `data`;
the Chat controls test consumes a produced snapshot from a fresh browser context
and checks the restored conversation against its original complete contents.

Prerequisites: Node, Playwright with installed WebKit/Chromium, and Python with
Pillow for the selection recordings. Each run retains its receipt/logs under
ignored `tests/.artifacts/ui-simulated/`, with source digests for each execution;
screenshots and animated GIFs live under
`tests/.artifacts/chat-images/`, `tests/.artifacts/ui-selection/`,
`tests/.artifacts/ui-stability/`, `tests/.artifacts/ui-stream-interaction/` and
`tests/.artifacts/ui-roadmap-hover/`. The GIF encoder
accepts at most 80 frames per recording and also emits a frame contact sheet for
visual review. Original failed receipts remain beside successful retries.
The recordings sample mouse gestures; they are not frame-rate or latency
benchmarks. Research waits for a browser paint before capturing the actual
highlight, without creating or modifying the selection.
The 180-second runner deadline bounds an isolated test process only; it does not
add a production generation timeout. Native macOS window/build checks remain
separate, and a passing simulated matrix does not qualify real inference or
other desktop platforms.

`node tests/support/ui_interaction_preview.mjs` provides a disposable browser
origin for direct computer-use checks. It seeds only its own main frame and
denies external fetches with a preview-specific CSP. Bounded stdin commands
pause/append/finish the simulated wire stream; mouse, keyboard and scrolling
remain actual browser interactions. Use a terminal with open stdin and close
the owned preview afterward. Its ten-minute lifetime bounds test diagnostics,
not production work. Receipts, screenshots and operator-recorded GIFs stay in
ignored `tests/.artifacts/ui-interaction/`. The native host's actual CSP remains
covered separately by `make test-ui-document-policy`.

Validation checkpoint, 2026-10-01 on macOS: `make test-ui-simulated` passed all
48 executions with unchanged production HTML throughout the run.
`make test-frontend-unit test-macos-window-theme test-macos-bundle` passed and
rebuilt the app. After synchronizing only Research screenshot capture with the
browser paint, `make test-ui-research-progress` passed its eight cases in each
browser again. The 20 slow/fast selection GIFs and both Research GIFs were
visually reviewed. These results cover the declared simulated UI matrix;
real inference, operating-system drag/clipboard integration, manual native
window dragging and the operator's running app were not tested.

Scoped follow-up validation, 2026-10-01 on macOS, after the native preview and
image-policy fixes: `make test-ui-sidebar test-ui-document-policy`,
`make test-ui-chat-controls test-ui-selection`,
`make test-frontend-unit test-qwen27-model-ui`, and
`make test-macos-window-theme test-macos-bundle` passed. The final image-policy
run covers four policy cases and 15 image cases per browser; the selection run
covers all five modes at both simulated speeds in both browsers. All 20 new GIF
contact sheets were visually reviewed. Separate native previews recorded OS
window moves, actual Blob image decoding and visible text selection, with all
HTTP APIs simulated. The app was rebuilt; the operator's running app and real
engines were not started or restarted. These are scoped follow-up checks, not a
new complete-matrix or inference qualification. Original failures remain in
ignored artifacts beside the successful retries.

Shared transcript interaction checkpoint, 2026-10-01 on macOS:
`make test-ui-simulated` passed all 54 executions after applying the shared
handler, Learn progress view-key correction and Tutor thread-navigation fix.
Production HTML SHA256 remained
`bbab19544100b7d03cf59d1da0f5b00558d18d6a087db6379be99b63e2612465`
throughout the final run. The 78 selection/scroll/composer/roadmap cases all
passed, and all 613 decoded frames of their GIF recordings were visually
reviewed. `make test-frontend-unit test-macos-window-theme test-macos-bundle
test-ui-document-policy` passed against that version and rebuilt the app without
launching it. Earlier complete runs with 52/54 results remain in artifacts.
One earlier WebKit Design gallery-filter clearing failure did not reproduce in
an unchanged focused replay or either later complete passing matrix; no causal
fix is claimed for that isolated failure. Direct Chrome mouse/wheel checks
also preserved Chat, Agent, Cowork and Tutor selections with simulated streams.
The complete receipt, recordings, failed-run links and visual review manifest
are retained in ignored `tests/.artifacts/ui-simulated/run-jxwQp1/` and
`tests/.artifacts/ui-audit-visual/final-review/`. The recorded GIFs are sampled
interaction evidence, not a performance benchmark or proof of every possible
UI state. All engines, generations, tools and downloads were simulated.

## Reasoning Markdown spacing

`make test-ui-reasoning-spacing` executes the production Markdown renderer and
styles in real WebKit and Chromium using a synthetic standalone layout fixture.
It compares Chat and Agent reasoning paragraph/list geometry with ordinary
Markdown and verifies code bytes, visible code indentation and explicit blank
lines in plain-text summaries. The regression fails before the spacing fix in
both browsers. It requires both Playwright browsers installed, is included in
`check-fast`, and writes screenshots and receipts under
`tests/.artifacts/reasoning-spacing/`. This is a rendering check, not a full-app
interaction or inference test.
