# Tests: what each result actually proves

Correctness before performance. No test is accepted merely because a function
name, comment, prompt phrase or CSS declaration occurs in application source.

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
See [workflow behavior](../docs/workflow-ui.md) for ownership and limits.

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

## Qwen Next on unified main

Flash Next now uses antirez/ds4 main `0aaea5a`, not a separate managed engine.
The new Q2/Q4 GGUFs include original BF16 n-grams; historical base + PLE receipts
do not qualify those weights. [Migration and verification scope](../docs/QWEN_NEXT_MAIN_MIGRATION.md).

Focused model-free entry points:

```sh
make test-engine-pins test-engine-setup-unit test-launch-preflight test-qwen27-model-ui
make test-agent-patch-migration test-runtime-patch-migration
make test-qwen38-agent test-qwen-session-reset test-qwen38-prepare-patch
make test-qwen38-snapshot-patch test-main-qwen-download
node tests/integration/glm53_m2max_patch_test.mjs /path/to/exact-main --unified-qwen
node tests/integration/agent_native_build_test.mjs /path/to/built-main
```

The native tests execute real parsers, tool effects, allocation failpoints and
Metal fixture buffers, with simulated model responses where declared. The
download test uses tiny real SHA-checked files and simulated transport. The
`--unified-qwen` stack gate also checks 40,448 hotlist IDs against an independent
int32 oracle under ASan/UBSan and the unchanged 256 KiB scratch bound.
`make test-first-launch-e2e` instead builds the bundled engine sources from an
empty profile through headless WebKit, with external network denied; it refuses weights before transfer and
checks Qwen Q2/Q4 reuse main plus the retired endpoint's 410 response.

## Host relay and model RPC

`make test-v1-relay` executes the production relay with real sockets and
deterministically simulates 601 silent poll intervals. It checks exact fragmented
HTTP/error/binary bytes and a real TCP reset on an abandoned response rather
than an ambiguous FIN. `make test-model-rpc-lifecycle` also exercises the actual
owned local model worker's Stop/reset and reaping. `make test-roadmap-request`
checks actual Learn harness HTTP requests against a simulated engine, including
explicit thinking off. These are model-free regressions, not quality results.

`make test-v1-proxy-exchange` builds and launches the real native host with an
empty task-owned profile and a loopback engine fixture on a reserved ephemeral
port. It checks GET/empty POST, buffered and fragmented large UTF-8 bodies,
exact HTTP/error/SSE/binary response bytes, long request paths, responsive status
while the backend is blocked, and Stop without duplicate effects or poisoning
the next call. It retains the host relay's existing EOF-as-cancellation policy;
request half-close is not supported here. The long-path test first failed with
bytes sent beyond the old header buffer, then passed with the bounded shared
exchange. Logs and receipts stay in `tests/.artifacts/v1-proxy-exchange/`.
It starts no model, uses no weights, and does not contact or signal a user's
engine. The executed platform is macOS; Windows execution remains not run.

## Twenty-five original Design systems

`make test-design-originals` serves the real native catalog and all twenty-five authored
packs. In Chromium and WebKit it exercises both themes, 320/390/768/1440px,
computed contrast, 200% text, radio/checkbox label columns, forms and dialog
focus return. Every pack is also opened as a standalone local file with HTTP
blocked. Market, Commons, Atlas and Canvas have domain interactions in normal
pages and the opaque app iframe: filters, cart totals/limits, literal replies,
review restoration, synchronized map/list selection, route ordering, object
edits, cancelled drags, keyboard selection and bounded undo/redo.

The sixteen added packs have their own actual browser scenarios in
[`design_additional_interactions.mjs`](support/design_additional_interactions.mjs):
reconciliation, conversation identity/literal replies, work limits, silent media
transport, journey/fare changes, local device controls, code selection/search,
recipe scaling, validated stock/history, adjacent-day rest, deal activities,
invoice quantities/status, billing/quotes and guided steps. Invalid admissions
must preserve previous content and drafts. These controls run in both themes and
desktop/mobile layouts, opaque frames and direct local-file exports; extended
retention/size boundary cases run in the light desktop view in both browsers.

Each missing pack is still recognized as supported but unavailable; the native
setup endpoint must not fetch or overwrite it. `make test-design-self` exercises
the real Agent pack dispatcher and exact returned Markdown, CSS, HTML, JavaScript
and recipe bytes for every supported ID, plus the craft project-plan reference.
The Chromium/WebKit Agent/Design UI test simulates the catalog response from
the real packs' `DESIGN.md` files and serves each pack's real `tokens.css`. It
checks the brief's gallery (family filters and counts, light/dark palettes and
type parsed from the tokens, search and empty state), that loading every new
system's brief reaches the actual composer and saved preference, replaces the
previous preset while keeping typed text, and that the chip removes it again.
It also types in the gallery search while further Agent polls are served (a
request-count barrier) and checks that the caret and every keystroke stay in
the search: idle polls used to move focus to the composer, so a search typed
across a poll landed in the prompt. `make test-macos-bundle` validates the catalog materialized from the
packaged app. These are authored assets and model-free tests, not the 18
model-generated projects required by the quality campaign, qualification of
generated output for the new sixteen packs or final native desktop qualification.

The October 1 gate passed 402/402 preview checks. Native runtime, recorded
benchmark validation, release checks, simulated gallery tests in both browsers
and macOS bundle smoke also passed. Failed WebKit resize receipts are retained
separately from successful retries; early Hearth/Counter diagnostic failures
were corrected harness assumptions, not product fixes. See
[integration scope and remaining acceptance](../docs/DESIGN_SYSTEMS.md).

## Design startup and baseline provenance

`make test-design-start` executes production catalog/migration JavaScript and
the native `/api/start` endpoint in an isolated empty-engine profile. It checks
retired/invalid/missing styles, delayed/offline/empty catalogs, deduplicated
requests, retries, preserved preferences and rejection without changing the
active configuration or admitting a task. A deliberately unavailable runtime
also verifies that admitted launches end in a failed task rather than hanging.
There are no weights or model-quality claims. The Agent/Design browser test
additionally holds the catalog response behind a barrier and checks the **first**
launch request, in Chromium and WebKit with simulated engine replies.

The included `make test-launch-preflight` invokes the real start handler with
a task-owned pipe-echo process representing an already running engine. Twenty-four
cases cover Qwen mode/checkout mismatches, missing model/PLE/drafter files and
incompatible forced SSD settings, including remote runtimes. Each rejected
request must leave that process responsive and keep configuration, credentials,
effective memory settings, task admission and pending steering unchanged.
The HTTP Design gate also checks a real child build failure **after** admission.
Neither test loads weights: these rejections do not qualify the supported Qwen
modes. Real Qwen3.8 Agent/Cowork workflows have a separate gate below.

`make test-agent-spawn` injects failures into the production launcher's three
pipe allocations and fork, for both Agent and Cowork. All eight cases must
release the prepared charter and every opened descriptor without publishing a
child. The prepared executable and checkpoint are fixtures; no model or child
process starts. This macOS-specific gate is included in `check-fast` on macOS.

`make test-launch-control` exercises the real HTTP host and owned subprocesses
with FIFO-blocked builders and tiny fixture checkpoint files. Eleven scenarios
cover responsive status and old-runtime input during preparation, failure without
publishing settings, task-specific/late cancellation, duplicate admission,
changed checkpoint/encoder identities, asynchronous handoff to a new PID,
TERM escalation, cancellation during loading, stale readiness messages and host
death. The test verifies actual stdin effects and child termination; no model
is loaded. Each run preserves its scripts, logs and receipt in
`tests/.artifacts/launch-control/http-*`.

`make test-ui-launch` runs the complete production UI in Chromium and WebKit
against an explicitly simulated HTTP launcher. Five response-barrier scenarios
check nonce generation, correct cancel-task identity, another window's pending
launch, canceled loading, preserved conversations/settings, duplicate shortcuts,
old error timers and successful transition to Agent. Screenshots and both failing
and successful receipts remain in unique `tests/.artifacts/launch-ui/run-*`
directories. These are browser interaction tests, not model-quality or native
desktop E2E claims. Both new targets are included in `make check-fast`.

`make test-quality-baseline` checks real-file hashing, archive Git provenance,
shared-store deduplication and complete receipt generation on isolated files.
Unselected managed `llama.cpp` installations and their binaries are included,
with C++/Objective-C++ sources, included C fragments and CMake recipes. The fixture
does not read the developer's real profile or execute engine binaries.
To capture a private baseline without loading
models, run `node tests/support/quality_baseline.mjs --hash-weights` (one bounded
read at a time). It reads the launcher's bounded `engine-checkout` setting and
the fixed managed sibling directories, including root-level checkpoint files.
`--engine PATH` and `--store PATH` add explicit locations. Broken weight links
and invalid settings are reported, not hidden as complete inventories. Source/binary identities,
the pre-existing diff and immutable hash receipts go into a new ignored
`tests/.artifacts/quality-multihardware/baseline-*` directory. A local SHA-256 is
provenance, not proof of checkpoint authenticity or inference correctness.

### Common-100 answer quality

`make test-common-quality-oracle` checks the evaluator without loading a model.
It exercises all 100 authored reference answers, known-wrong answers, ten real
before/after patch fixtures with preserved tests, strict JSON types/duplicates,
and code input preservation. Binary search also has counted element reads at
two sizes. Actual HTTP tests use **simulated replies** to verify that wrong
answers, truncation and missing long-context coverage fail; a transport failure
stops new requests by default and retains all unexecuted cases in the denominator.
The explicit `--restart-failed-engine` option instead waits for the process owner
to reap and replace its engine before the next case, at most eight times. It does
not retry the failed case. Simulations verify the handoff barrier, restart budget,
unchanged model requirement, interruption and failed owner; live receipts must
separately prove actual process teardown and subsequent inference.

The common corpus contains 12 arithmetic, 12 reasoning, 15 code, 10 debugging,
10 JSON, 10 extraction, 10 strict-instruction, eight Italian/English, eight
long-context and five insufficient-information tasks. Coding tasks are pure
Python functions; debugging returns actual unified diffs. These are not Agent
tool-loop tests or a comprehensive measure of open-ended language ability.
Language cases use explicit, objective choices or constrained transformations.

The code evaluator currently requires macOS `sandbox-exec`. Generated code
cannot read personal directories, write files, access the network or fork;
the Python subset additionally excludes imports, reflection and I/O. CPU,
runtime, input and output are bounded. A 256 MiB RSS watchdog terminates excess
memory use; this is a sampled termination threshold, **not a hard address-space
cap**. Other platforms have no unsafe fallback and are reported as unavailable.

An explicit existing-weight, single-engine run uses the native engine path:

```bash
node tests/live/engine_acceptance.mjs --infer --engines qwen \
  --installed-root /path/to/managed-engines --model-root /path/to/gguf \
  --common-quality --quality-use first-exposure
```

`--quality-use development-replay` is the default and must be used after exposure
to these cases. First exposure is to this frozen integration corpus, not a claim
that model training data has been audited. The native engine IDs `main`,
`laguna` and `qwen` are accepted; `--model-file NAME.gguf` chooses one explicit
existing quantization. `llama` is setup-only here: Qwen3.6/27B inference runs
through the host in `make test-llama-resident-live`, and a llama.cpp common-100
campaign has not been run.
This path currently requests resident Metal execution (Qwen3.8-Flash-Next reads
its embedded BF16 n-grams from SSD); it does not claim expert-streaming or other-backend
coverage. Do not run a configuration that exceeds the host's memory budget.
Before loading, the Qwen3.8-Flash-Next path hashes the complete weight file
against its fixed table and records the engine revision. Retained Qwen27B and
Qwen3.6 receipts from the retired `q36`/`ds4-qwen35` engines stay unchanged as
history; they are not llama.cpp results.

A patch answer whose last diff line lacks only its newline terminator is
accepted after exactly one newline is restored; prose, fences, wrong paths and
broken hunk counts still fail. That correction changed the corpus identity to
`5727dcb4…`. Earlier receipts are re-evaluated without new inference by
`node tests/support/regrade_common_quality.mjs OLD/results.json NEW_DIR "defect"`,
which writes a separate directory and never edits the original. Use an original
run as the source: a regrade directory has no per-case requests and is rejected.
Installation/protocol smoke tests remain separate from this quality option.

Requests use a 65,536-token capacity, temperature 0, seed 20260909, thinking off
and 2,048 output tokens. Frozen deadlines are 180 s for ordinary cases, 240 s
for code/patch cases, 900 s for long contexts. A long case additionally needs
at least 12,000 actual reported prompt tokens; configured capacity alone is not
coverage. Requests, complete responses, source/grader hashes, runtime identity,
timings and failures are retained in a fresh ignored `engine-acceptance` run.
The first model-quality campaign is separate from the evaluator's passing tests;
neither implies numerical parity, PDF/vision quality or desktop qualification.

`node tests/support/common_quality_summary.mjs TERMINAL_RESULTS.json NEW_PUBLIC.json`
creates a new aggregate only after a run is terminal. It checks all 100 cases,
category counts, stored totals and model/binary provenance; simulated model-free
HTTP receipts cannot qualify as model results. It excludes personal paths, raw
prompts and answers. An unrequested JSON wrapper around a correct value is
classified separately but **remains failed**. `common_quality_summary_test.mjs`
checks these publication boundaries with explicitly synthetic unit data.

`make test-qwen38-inspect` tests the reversible metadata-only PLE patch on
verified [historical input files](fixtures/retired-qwen-next/) expanded into a
private directory. It does not require the retired installed fork. Set
`QWEN38_DIR` to explicitly test another complete historical checkout.
Add `--native ds4/gguf` after a full source directory in the documented Node command in
[the patch notes](../patch/ds4-qwen38-inspect/README.md) to build the real CLI
and check its OS prefetch behavior and actual GGUF summaries on macOS. The
ordinary uninstrumented CLI is checked too. This does not generate tokens.

Historical Qwen Agent and Web patch migration cases use the same offline fixture
reader, retaining their original revision/hash and independent Git oracles.
Default backend link tests cover the active main and Laguna trees; Qwen Next
uses main and llama.cpp builds with CMake. Supply full source paths to `backend_link_test.mjs` for an
explicit historical backend-routing run. Its compiler outputs remain simulated.

`make test-engine-startup` runs four real HTTP startup cases without
`DS4UI_TEST_MODE`, with inference explicitly deferred and isolated source
fixtures. A persisted retired `q36` or `ds4-qwen35` checkout must be left
untouched and never receive ds4 Agent recovery; clean native sources remain
usable and missing/legacy-modified native sources keep their errors and backups. This gate is model-free and included in `check-fast`
on the current POSIX host, not a Windows or inference qualification.

`tests/live/desktop_chat_e2e.mjs` attaches only to an explicitly provided
task-owned `desktop-e2e-*` bundle/profile and verifies its process identity before
typing. It uses the real macOS window, Accessibility, keyboard and Send control,
then checks a new persisted answer against an independent JSON/arithmetic oracle
and the native accessibility tree. It records window-only screenshots, which
require a separate visual review. It neither launches nor stops the app. This
is one real Chat workflow, not headless browser coverage or model qualification.
Arguments are test directory, owned GUI PID, localhost URL and an optional exact
model filename (for example `gguf/Qwen3.8-27B-UD-Q6_K_XL.gguf`). The process
owner/start identity is revalidated before native interaction; the optional
model assertion prevents qualifying the wrong already-loaded checkpoint.

Learn and Pi/OpenCode live runners now print a new `run-*` output directory
on every invocation; use that exact directory when reviewing/publishing a run.
They do not clear historical attempts. Research-only development replay in Learn
requires both `DSTUDIO_REAL_ROADMAP_REUSE_RESEARCH=1` and
`DSTUDIO_REAL_ROADMAP_RESEARCH_FROM=PATH_TO_PRIOR_RUN`; the recorded input must
match exactly. Reused research is labeled replay, not a fresh E2E measurement.
For an explicitly non-thinking Learn diagnostic, set
`DSTUDIO_REAL_ROADMAP_THINK_LEVEL=off`. The generation request and progress
receipt now record that setting. Its default remains `max`, matching Learn's
product generation path; an engine launch default of `think: off` alone does
not override a request that explicitly enables reasoning.

## Model-stream integrity and Stop

`make test-remote-structured-tools REMOTE_TOOL_AGENT=/path/to/built/ds4-agent-jsonl`
runs the real lightweight Agent and Cowork tools against explicitly simulated
model frames. It covers exact argument/call-ID round trips, actual file creation
and readback, Office tools without a shell, interrupted/incomplete batches,
foreground shell cleanup, non-executable model prose, compaction, duplicate IDs
and invalid arguments. Literal and regex search execute the real dispatcher.
One-shot success, failure and Stop must produce distinct process outcomes.
Four repeated tool calls are fed byte-for-byte into the host watchdog, with
distinct transport IDs; a generated JSON record is not reconstructed by the
harness. This is integration coverage, not a real-model quality benchmark.

`make test-remote-turn-error` executes the host's control-frame parser and the
Task Graph scheduler/store. A failed turn followed by an idle marker must stay
failed in the task, node, durable result and journal replay; a successful next
turn must still complete. It uses an isolated workspace and simulated runtime
pipe, without starting or signalling an inference engine.

To rebuild only unified main, run `node tests/integration/agent_native_build_test.mjs ds4`.
For the historical three-source comparison, supply the archived Qwen fork explicitly:

```sh
make test-agent-native-build AGENT_MAIN_TREE=ds4 AGENT_LAGUNA_TREE=ds4-laguna-s21 \
  AGENT_QWEN38_TREE=/path/to/archived-qwen-next
```

Sources are copied into a new task-owned directory, without weights or reused
build objects. Agent/Cowork/Design are linked against each selected upstream;
the structured tool corpus runs both normally and with ASan/UBSan on the Agent
and first-party helpers. Upstream core/GPU objects are not sanitizer-instrumented.
First-party support, patches and native harness hashes must remain unchanged
during the run. Compilation does not expose new application modes or qualify
inference on another backend. Failed runs remain in `tests/.artifacts/`.
The same gate runs `agent_structured_probe.c` against each derived native
runtime: exact batch/argument/ID/history bounds, preparation without admission,
whole-group compaction, retained replay IDs, reset and allocation lifetimes.
It records native type sizes and a labeled model-free snapshot microbenchmark;
these timings are not model speed or a published before/after comparison.

`make test-model-rpc-input test-model-rpc-stream test-model-rpc-lifecycle test-model-rpc-interrupt test-remote-utf8` executes
the production native HTTP/SSE relay and shared runtime pipe consumer. The
61 stream/consumer scenarios use a simulated model, deliberately fragmented bytes,
actual outgoing request bodies and replays of the resulting runtime frames.
They cover Unicode, interleaved tool IDs, exact argument preservation, duplicates,
invalid/oversized inputs, incomplete endings and errors. A tool batch is not
published before successful completion. These are transport tests, not LLM
quality or proof that the structured dispatcher is integrated into every mode.

The stream gate repeats the shared corpus through native request-envelope
admission and the actual exec'd host worker
over HTTP and HTTPS, with two additional held-connection cases on each path:
Stop and death of the owning host (**63 cases per owner-relay path**). HTTPS
requires `curl` and `openssl`; it creates an isolated certificate and passes its
CA to the test child, without disabling TLS verification. Worker/process-group
exit, closed peer sockets and absence of named credential/body staging files
are checked. The owner-only relay has one active worker, at most one pending
request while cancellation is reaped, a 16 MiB body limit and 16 KiB delivery
staging. Inference has no automatic elapsed-work deadline; Stop, owner death,
actual transport failure and blocked terminal delivery remain separate. It does
not retry a failed action.
Windows code is not qualified by these macOS process tests.

The **18 input scenarios** exercise the first-party request writer, native
stdout parser and exec'd worker, not a source-code contract. A real peer checks
the complete large Unicode request; a deliberately stopped upload worker must
not prevent the HTTP Stop handler from returning or the client from cancelling.
The host retains at most 16 KiB upload staging plus an 8 KiB unread pipe suffix;
only the worker decodes/validates the body, with a 16 MiB decoded limit. The
internal header follows the canonical `rpc_send_request` format: an embedded
`model_request` inside a display event cannot initiate a network operation.
Each stdout/stderr drain has its own 64 KiB budget. Other cases cover stale
split headers, invalid IDs/Unicode/JSON, duplicate envelope fields, incomplete
input, decoded-body overflow, display-record overflow and a terminal-delivery
deadline with a genuinely full runtime pipe. The deadline fault changes the
monotonic deadline, not the assertion or production timeout.
An early-rejection scenario resumes an intentionally stopped validator, then
observes its exit without reaping it before the owner resumes. The owner must
deliver the validator's original error even when the unfinished upload now
gets EPIPE; it must not overwrite that receipt with a generic pipe error.

Display events have an explicit 4 MiB ceiling (the existing transcript
capacity); exceeding it fails the runtime rather than publishing a truncated
tool event. Their whole-record watchdog hashing/transcript publication still
need critical-path review: input byte budgeting alone does not qualify that
separate work or the complete P10 latency/memory profile.

The six lifecycle scenarios force exact OS descriptor reuse, 200 rejected
duplicate admissions, credential changes after admission, a stopped helper
requiring escalation, a full runtime pipe, worker death, actual connection failure,
oversized body and a request queued before Stop. The HTTP Stop handler must
remain usable under real pipe backpressure. The flag comparison uses an
independent written-pipe oracle: Darwin may expose its kernel-owned
`FWASWRITTEN` history bit, which is not a changed nonblocking policy. Original
failures and the size/layout report are retained with the receipts.

The 36 interrupt scenarios invoke the actual HTTP handler, Task Graph cancel
and watchdog across Agent/Cowork/Design labels and both protocol APIs. Each
owns a real child using the shared reader and a held HTTP connection through
the exec'd worker; blocking and nonblocking/partial
stdin, SA_RESTART, discarded candidates and restored descriptor flags are
checked, as are peer disconnection and worker reaping. No existing user process
is signalled. All four gates are in `check-fast`. Detailed receipts live under
ignored `tests/.artifacts/model-rpc-stream/`, `model-rpc-lifecycle/` and
`model-rpc-input/`.

`node tests/integration/runtime_model_interrupt_test.mjs PATH_TO_RUNTIME ...`
goes further: the actual compiled Agent/Cowork/Design binaries receive SIGINT
during a silent prefill, incomplete frame or uncommitted tool. Each must return
to WAITING without more model bytes, retain the exact next prompt and execute
a real filesystem tool on the next turn in the **same process**. Cancelled
effects must not appear. The native build gate includes this test for every
built variant. Requests, logs, source/binary hashes and failed attempts remain
under ignored `tests/.artifacts/runtime-model-interrupt/`.

This qualifies the runtime wait, not cancellation of the upstream HTTP worker,
separately owned resident engine, full-pipe backpressure or model quality. Those
lifecycle and end-to-end acceptance requirements remain open in `PLAN.MD`.

## Goal and context during execution

`make test-goal test-steering` runs the production Goal scheduler/journal and
native HTTP/runtime steering transport. It checks bounded continuation, actual
receipt requirements, failed-command spoof rejection, pause/resume, partial
resume recovery, FIFO, duplicate/stale/closed-turn rejection and append-before-ACK.

`make test-steering-patch` exercises apply and repeated/drift rejection on
isolated copies of the installed main/Laguna sources, preserving unrelated edits.
`make test-agent-patch-migration` adds all seven pinned source bases and independent
Git apply/reversal. The three previous variants retain frozen legacy output
parity after reversing the separately recorded renderer and remote-interrupt
corrections solely for the historical oracle. Every variant first reverses its
v100 readiness delta to its frozen v99 hash. Laguna and older MoE reverse their
v99 continuation deltas, then the v98 publication delta, to recover their exact
v97 bytes first. The
newer main/Qwen variants have no fictitious legacy oracle. It requires local source
objects or exact base files; `DSTUDIO_AGENT_QWEN38_DIR` selects the isolated new
candidate. It does not perform a network install.

`make test-agent-compaction AGENT_LAGUNA_TREE=ENGINE_LAGUNA
QWEN35_AGENT_TREE=ENGINE_MOE` requires the already-built native cores.
It executes actual compaction and control calls with deterministic session and
tokenization fixtures under ASan/UBSan. Fourteen cases per branch check original
transcript and memory preservation during blocked preparation, failed summaries,
failed rebuilds, cancellation/late Stop, stale identities, one owner-only
publication, successful export, and an honestly reported export failure.
Twenty- and 200-ms barrier holds demonstrate control access during preparation;
probe-only timings distinguish preparation, control, lock wait/hold and actual
publication. A zero sub-microsecond reading means below timer resolution, not
zero work. These are diagnostic fixture observations, not an inference speed
benchmark or percentile study.

The shipped v98 patches pass **28/28** (`run-KKPyWK`, `run-wGTgjx`); original
v97 code passes **4/14 per branch** on the identical final harness
(`run-XvWWAk`, `run-ZQ7QxN`). Earlier 12-case failures and the initial missing
piped-mode warning are also retained under ignored `agent-compaction/`.
`--source /path/to/frozen-derived-agent.c` runs that exact before/after input
without mutating supplied engines. Add `--helper FROZEN_COMPACTION_TEXT_HEADER`
when that source predates the current private helper API; the runner captures
and compiles the exact historical helper in its own directory. No models are
loaded. Real-model continuation
quality, multimodal state and other backends are separate gates.

`make test-agent-continuation` adds native GGUF tokenizer and generation-loop
regressions on the production patch output. Override
`COMPACTION_LAGUNA_MODEL` / `COMPACTION_QWEN35_MODEL` for the installed GGUF
locations. The native core reads vocabulary/metadata only: **no weight tensors,
GPU inference or model-quality evaluation**. ASan/UBSan covers 50 Laguna and
53 Qwen framing checks, preserving the exact original tail token IDs across
BPE/ChatML/tool/think boundaries. A scripted 18,000-token response crosses three
compactions and must render identically to the non-compacted reference without
renewing its output budget. Sixteen Laguna / fourteen Qwen loop checks also
cover native speculative orchestration, where supported, oversize admission,
repeated memory export, Stop/failure and a partial tool followed by a complete
retry that writes the actual file exactly once. The v100 addition latches Stop
across the admission-to-dispatch gap; the earlier fifteen/thirteen-case receipts
below remain historical rather than being assigned the new denominator.

V99 production receipts `run-Jntg6Y` / `run-CGHiec` pass their checks plus the
existing 14 publication cases each. The identical final loop harness on v98
passes only **4/15 Laguna** (`run-5DMOsP`) and **3/13 Qwen** (`run-kAfUMN`).
The initial second-compaction memory-boundary failure is retained in
`run-iBnqeM` / `run-Vwpree`, not replaced by the corrected run.
`--generation-only --source FROZEN_AGENT --tokenizer-model GGUF` reproduces
that older baseline without requiring v99's new framing helpers. All receipts
are under ignored `tests/.artifacts/agent-compaction/`; no simulated throughput
is presented as model performance.

`make test-agent-continuation-live CONTINUATION_BUILD_RECEIPT=RESULTS_JSON
CONTINUATION_FAMILY=laguna CONTINUATION_MODEL=MODEL_GGUF` explicitly launches
the binary from a passing native build receipt, with real resident weights,
Metal, 8k context and isolated session/workspace files. Laguna is the only
supported family; the earlier Qwen3.6 family ran on the retired `ds4-qwen35` fork. It never downloads weights, restarts
the app or stops an existing engine. Six development cases cover an archived
fact, 200 generated C functions across actual compaction, another explicit
compaction, real file tools using the retained fact, Stop and same-process tool
recovery. Generated C is independently compiled and executed; no missing code
is repaired. Native trace inputs and private summary text are kept separate
from generated output. Original prompts, answers, failures, timings and exact
build/binary identities stay in ignored `agent-continuation-live/` artifacts.
This is not a held-out quality benchmark or a claim of numerical equivalence;
missing prerequisites and unexecuted cases remain failures/not run.

The first real Qwen MoE continuation run (`run-lFiDBs`, v99) passes **4/6**:
generated code, original facts and real tools survive compaction/Stop. It also
exposed premature `/compact` readiness and suppressed Stop feedback. Original
failures remain retained. The v100 replay `run-raYfjK` passes **5/6**: both control
defects are fixed, but generated C omits every function's return type, confirmed
by an independent C11 compiler. Laguna `run-krSaOZ` passes **4/6**: its generated
code compiles and runs through compaction, but the summary drops remembered
values. Post-Stop write/read succeeds; that case still fails its additional
check because the preceding `after.json` was never created. Both engines exit
normally with unchanged captured inputs. Initial Laguna `run-yftqXG` retains
the unsupported custom-prefill error with six cases not run. The runner now
uses Laguna's native prefill selection; Qwen retains its 512-token chunk.

These runs inject the native current session date/time, so even identical user
prompts and sampling are not token-identical A/B inputs. The v99/v100 Qwen traces
confirm this timestamp difference; no causal quality change is inferred from
4/6 versus 5/6. V101 revises the private summary instructions to retain explicit
future-use facts and earlier durable state. Its Laguna replay `run-QcP9k6`
passes 6/6 with independent code compilation/execution and real file checks.
Manual review still finds the first summary falsely declares an open reply
complete: this limitation is not covered by the six-case total, and remains
open. MoE v101 `run-lC2uDg` also passes 6/6, but its separate summary review
finds stale pending work after the task finished and a tool-shaped summary;
no tool is actually dispatched by that private summary. Broader summary-quality
acceptance is a separate gate.
A deadline aborts remaining scenarios instead of sending another prompt while
the prior engine operation is unknown.

V102 adds actual runtime reply state to the summary request and refreshes its
progress instructions. The same worker is tested first during an open reply,
then after its EOS and a manual compaction. The new checks consume the native
tokenizer's actual prompt; they are not source-text assertions or a claim that
a model obeyed it. Laguna `run-EJUCfG` and MoE `run-Kl7ppp` pass 18/18 and 16/16
loop checks plus their unchanged publication/framing sets. Frozen v101, with
its captured helper, passes 16/18 and 14/16 on the same C oracle
(`run-tDsUKF`, `run-4iJ6ks`): both runtime-state assertions fail. The subsequent
v102 native build `run-Ethbt2` passes 77/77 stages. Laguna's real replay
`run-b3xpGT` passes 6/6 and the separate scoped summary review: accurate
57/200 partial progress, then 200/200 complete, with both explicit facts kept.
MoE v102 and wider quality acceptance remain pending. Build, workflow and
summary evidence remain distinct, recorded in the
[upstream checkpoint](../docs/DS41_UPDATE_CHECKPOINT.md).

`make test-agent-idle AGENT_IDLE_ENGINE=ISOLATED_BUILT_ENGINE` compiles the actual
patched worker with ASan/UBSan and runs 20 command/ownership/notice checks, using
a deterministic blocked session API and no inference. It requires a task-owned
engine under `tests/.artifacts/`, not an installed checkout. Set
`AGENT_IDLE_FLAGS="--source FROZEN_DERIVED_AGENT"` for the unchanged before-code.
Laguna/MoE pass 20/20 on v100 versus 8/20 on v99; 1,000 control reads complete
while preparation is held, and worker layout is unchanged. `test-agent-native-build`
also executes this probe for each supplied current engine family.

`make test-agent-runtime-notice AGENT_NOTICE_RECEIPT=RESULTS_JSON` consumes the
actual passing native probe's JSONL notice records through the production UI
segmenter, including fragmented frames and quoted/Unicode text. Plain model text
must not become a service event, and a service message must not become an answer.
The app browser workflow additionally checks visible Stop feedback and absence
of raw JSON in WebKit and Chromium; its engine replies are explicitly simulated. Notice-only
conversations and invalid/empty frames are included in the 135 native-frame
consumer checks, including Design's empty-conversation decision.
Final browser receipts `agent-notice-visibility/webkit-ohVk0e` and
`chromium-Pn6ZYj` include a reopened notice-only Design conversation in light
and dark themes, completed entrance animations, on-screen geometry and at
least 4.5:1 notice contrast. Screenshots were visually reviewed. The original
fixture-timing/ownership failures remain retained; these passes are UI evidence,
not real-model or packaged-app qualification.

`make test-runtime-patch-migration` does the same for the web bases and four
server inputs (current/previous main, with/without native metrics). Exact raw
sources may be supplied in `DSTUDIO_RUNTIME_BASE_SOURCES`, named
`web-main-current.c`, `web-main-previous.c`, `web-laguna.c`, `web-qwen38.c`,
`server-main-current.c` and `server-main-previous.c`.
The test applies the metrics prerequisite itself where required and checks all
hashes against the committed base manifests. This is not model-quality evidence.
`make test-steering-runtime` requires their already-built Agent/Cowork
binaries plus main Design: it executes real filesystem tools, inserts context
at two owner boundaries and proves the same turn continues without duplicate
effects. Model frames are deterministic fixtures; no weights are loaded.

`make test-unified-patch test-agent-build` is in `check-fast`. It executes the
native patcher and builder, including malformed/linked inputs, ambiguous patches,
build failures, source edits during compilation, forced termination and a
compiler that retains the checkout lease after its parent dies. A separate
regression replaces the staging pathname: publication is rejected and
cleanup stays confined to the retained directory, with an explicit visit bound.
The compiler in `test-agent-build` is explicitly simulated. In contrast,
`make test-agent-native-build` creates source-only main/Laguna snapshots and
really compiles and links both Agent/Cowork pairs on macOS, then runs their
filesystem tools and steering loop with simulated model frames. It additionally
builds the real main Chat PLD binary and checks its CLI, while asserting that
Laguna's unsupported PLD ABI leaves no derived server. No weights or
existing user runtimes are touched. See [patch prerequisites and limits](../patch/ds4-agent-jsonl/README.md).
The gate also builds Design and executes its real read tool and steering loop.
All three runtime types additionally exercise model-wait Stop and next-turn
tool execution without restarting the process, with model replies simulated.
It runs upstream Agent unit tests and fragmented rendering both with and without
a JSONL worker, under ASan/UBSan for private Agent/helper C objects. Core/GPU
objects remain uninstrumented. Set `AGENT_QWEN38_TREE` to also build the new
Qwen3.8 source; building a runtime alone does not qualify its application modes.
On macOS, `DSTUDIO_AGENT_BUILD_BACKEND=cpu make test-agent-native-build` selects
a fresh real CPU build; it does not qualify Windows or Linux behavior.

`make test-qwen38-agent QWEN38_AGENT_TREE=PATH_TO_BUILT_CANDIDATE` requires the
already-built unified main source and native core objects (historical fork
inputs remain available for replays). It executes the Qwen
parser, original Agent units, eight prompt combinations, real file writes,
Cowork document readback and rejected workspace escapes. Its model text and
engine identity are fixtures: this is protocol/tool behavior, not inference
quality. ASan/UBSan instrument the private Agent/parser/helper C objects only;
`QWEN38_AGENT_FLAGS=` disables them explicitly. It neither starts a model nor
changes the supplied engine checkout.

`make test-metal-workspace` links a small probe against the already-built native
Metal objects for main and Laguna (Qwen3.8 uses main). It runs from the engine's
directory and from an unrelated workspace with spaces, through the production
host environment. Each run initializes the actual shader library and checks
257 GPU additions against a scalar result. `METAL_WORKSPACE_TREES` selects the
input trees; unavailable hardware/objects fail, never silently pass. This test
does not build in the supplied trees or load model weights. Eight missing
shader-path overrides were found by this test, including the GLM/vision, DFlash
and Qwen sources; compilation alone had not exercised workspace-relative loading.

The explicit live development gate is:

```sh
make tests/.build/agent-build-probe test-qwen38-tool-oracle
node tests/live/qwen38_agent_smoke.mjs ENGINE MODEL_GGUF
```

It requires the already-built Qwen candidate's Agent/Cowork and actual weights.
Runs are sequential, with 16k context, a 512-token prefill chunk, 1,024 output
tokens per model round, temperature 0, seed 42, thinking/MTP/DSpark off and at
most 12 tool calls/600 seconds per workflow. No downloads, app restart or
termination of an existing engine are performed. This uses resident backbone
weights plus embedded BF16 n-grams on SSD, without expert streaming. It verifies
exact generated files, source preservation, required document tools and
subsequent readback. The former `--qwen35` variant is rejected: Qwen3.6 now runs
on llama.cpp and is covered by `make test-llama-resident-live`.
The first run's Cowork failure is preserved: its original grader erroneously
forbade extra local reads despite the request permitting them. The corrected
oracle still rejects shell/network, wrong targets, missing writes/results and
missing document readback; the complete two-workflow run was repeated. These
are development checks, not held-out quality, numerical parity or app-mode
qualification. Runtime requests/answers and personal paths stay in ignored
`tests/.artifacts/qwen38-agent-live/` (older Qwen3.6 receipts stay in
`tests/.artifacts/qwen35-agent-live/`).

## Qwen real host workflows

```sh
make tests/.build/dstudio-server-test test-qwen38-tool-oracle
node tests/live/qwen38_host_smoke.mjs ENGINE MODEL_GGUF
# Additionally exercise generation interrupt and a new session:
node tests/live/qwen38_host_smoke.mjs ENGINE MODEL_GGUF --controls
# Separate reset lifecycle: visible prefill, cancellation with retained memory,
# then a successful reset and real tool read:
node tests/live/qwen38_host_smoke.mjs ENGINE MODEL_GGUF --reset-lifecycle
```

Use an already-installed `ds4` at pin `0aaea5a`, with the single-file model
resolving to its shared model store. The former `--qwen35` variant on
`ds4-qwen35` is rejected; its receipts below are retained history. This runs the real headless HTTP host in a
private profile: asynchronous launch, the unmodified production Agent/Cowork
charters, structured tools, exact saved files and readback. Agent uses the
production automatic Task Graph route, including its actual durable journal.
Each mode must also remain usable for another read after a rejected Design
switch; the Agent-to-Cowork transition must replace only the test-owned process.

Runs are sequential with 16k context, thinking/MTP/DSpark off and expert
streaming off: resident backbone plus embedded BF16 n-grams on SSD. Sampling remains at the
production Agent defaults, **not** the fixed seed/temperature of the CLI gate.
Each workflow is bounded to 12 tool calls and 600 seconds, with bounded logs,
private KV directories and strict workspace checks. The runner refuses an
existing inference process; it does not download weights, restart the user's
app or stop unrelated engines. Requests, answers, process and binary identities,
source-install receipt and failures remain in `tests/.artifacts/qwen38-host-live/`
(older Qwen3.6 receipts stay in `tests/.artifacts/qwen35-host-live/`).

`--controls` requires actual generated tokens before sending an interrupt,
checks the canceled task and the still-running engine, starts a new session
and requires another real tool read without changing earlier files. Its
separate deadlines are 120 seconds for generation, 15 for interruption, 600
for reset and 120 for readback; the 600-second workspace-workflow limit is
unchanged. An early terminal reply fails this control gate; bounded follow-up status and
transcript observations are retained, not used to silently accept the failure.

The complete September 7 Qwen3.8 replay passed both workflows. Its initial Agent
attempt is retained as a failed test: the grader incorrectly rejected the
host's `.dstudio/task-graphs/` receipts. The corrected oracle permits only the
graph IDs reported by the host and checks journal identity, ordering, terminal
success, file/byte limits and symlink rejection; arbitrary hidden files remain
forbidden. Separate oracle regressions exercise valid and invalid workspaces.
This is two real development workflows, not held-out quality, numerical parity,
foreground desktop coverage or evidence for CUDA/ROCm.

The following Qwen3.6 receipts were produced on the retired `ds4-qwen35` fork
and are retained as history. The initial Qwen3.6 host control run remains failed: its workspace operations
passed, but the counting request ended before interruption could be tested.
The native Agent/Cowork CLI gate passed separately; it does not override that
host failure. The complete retry passed Agent and Cowork, including generated
tokens before interruption, canceled task receipts, new-session completion and
tool readback. It also exposed delayed native progress while the synchronous
reset ran. A generation interrupt did not qualify cancellation during reset.
The separate version-91 reset fix and gate below address that ownership path;
they do not erase or establish the cause of the initial counting failure.

`make test-qwen-session-reset QWEN38_AGENT_TREE=ENGINE38` executes the shipped
patches and real native worker with simulated inference and deterministic
barriers: seven Qwen3.8 cases (the six retired Qwen3.6 cases ran on `ds4-qwen35`). It checks the command reader remains available, old context
and attachments survive failure/cancellation, duplicate reset admission fails,
late cancellation prevents publication and save failure retains the old identity.
The original synchronous baseline fails the three shared scenarios. ASan/UBSan
cover the Agent/helpers, not the already-built engine objects. The observed
arm64 Qwen3.8 worker size remains 2,184 bytes; candidate session
count is bounded to one alongside the live session.

Patch 92 additionally requires the native Qwen3.8 empty-candidate API. Run
`make test-qwen38-prepare-patch QWEN38_AGENT_TREE=EXACT_SOURCE` for multi-file
apply/repeat/restore, drift, partial-state and symlink rejection. The explicit
`make test-qwen38-prepare-live QWEN38_AGENT_TREE=BUILT_CANDIDATE
QWEN38_MODEL=GGUF` loads actual Metal weights and checks
cancellation, old-session preservation and bit-identical logits/state against
normal sync. It is a development regression, not held-out answer quality.
`qwen38-prepare-live/run-8t4x4R` passed eight checks; the original preflight
shader-path harness failure remains `run-Okzbuo`. The separate real host replay
`qwen38-host-live/run-xdrRmf` passed Agent/Cowork reset and file workflows with
the unchanged 15-second Stop deadline. Earlier failed replays remain recorded.

`--reset-lifecycle` uses actual weights, a random conversation-only code and a
task-owned project-memory fixture which forces a genuine prompt-cache miss.
It must observe prefill while busy, cancel within the existing 15-second
deadline, receive exactly one native terminal error, and recall the exact code
without tools. A second reset must complete, emit one success receipt and permit
a real read without changing prior files. Each reset remains bounded to 600
seconds; these development replays are not speed or held-out quality benchmarks.
The memory fixture is model-specific: the Qwen3.8 pin reports progress after
native 8,192-token chunks, so its fixture must span two chunks. No chunk-size/context override or numerical engine change is used.
The shared progress oracle requires unfinished work (`0 < done < total`).
The first Qwen3.8 attempt, `run-uAb5iW`, remains failed: its 4,358-token reset
completed successfully in one chunk, without an intermediate observation where
cancellation could be tested. The longer-fixture retry is separate evidence,
not a retroactive pass or an intra-GPU-kernel cancellation guarantee.

Two initial Qwen3.6 reset replays are retained as failures (`run-KaB607` and
`run-l76E5r`). Both had correct recall but exposed test-decoder defects: status
frames interleaved between answer tokens, then the reserved final-line Task
Graph receipt already hidden by the UI. The shared oracle now decodes those
transport elements for both Qwen variants before an exact-answer assertion.
Regressions at every split retain wrong codes, extra prose, repeated receipts
and malformed frames as failures; an echoed question is never an answer.
Qwen3.8's second reset attempt (`run-QQtql2`) also remains failed: cancellation
and recall were correct, but the grader included the native autosave system
line in the answer. The decoder now removes only that exact terminal shape.
A regression executes the actual UI `splitUserTurns`/`segmentAgent` functions
to verify the same text/system separation for correct and wrong answers.
See [the Qwen checkpoint](../docs/QWEN_CHECKPOINT.md) for final replay results
and the explicit desktop/quality/backend coverage gaps.

## Native backend and browser gates

### Cowork spreadsheet read scope and saved-file receipts

`make test-cowork test-cowork-bench-validate` executes the production Python
helper, C/JSON/Python bridge, native HTTP endpoints and document-table previews.
It uses actual generated Office files, not LLM answers. The read regressions
cover default A1:T50 omissions, explicit follow-up ranges, stale XLSX dimensions,
Unicode and character/byte limits, literal zero-padded IDs, formulas and source
preservation. A deterministic serialization counter verifies that a shared cell
string is not expanded thousands of times before the output budget is applied.
Document-table extraction must reject dimension metadata that excludes stored
cells. Writer receipts report normalized sheet names and ranges with
`readBack:false`; only a separate read observes saved values.

The read scope describes nonempty data in the selected worksheet, not formatting,
all workbook sheets or semantic verification. Output is bounded both to 750,000
characters and below the bridge's 1 MiB UTF-8 byte limit. These are file/tool
regressions; run the separate real Qwen tools gate below to assess that workflow.

### Qwen3.6 and Qwen3.8-27B on llama.cpp

Both models run on DStudio's bundled llama.cpp `b11371` (`99b9548`), built
offline from `src/engines/llama.cpp` on first use. Agent and Cowork use the
pinned main `ds4` tool runtimes in remote mode against the owned resident
`llama-server`; Chat uses the same process through the `/v1` proxy. Design
uses its remote adapter over the same model RPC, with the tool schemas sent as
structured function tools (`DS4UI_REMOTE_TOOL_PROTOCOL=openai`).

`make test-resident-unit` compiles the production routing, preflight and
`/props` readiness functions: model-to-engine routing, retired-checkout
rejection, the 27B projector requirement, context/power/DSpark preflight, and
readiness that must match the exact model path, alias, build, slot count,
context and vision modality. A `/props` reply from another model or build is
not ready.

`make test-resident-guard` (`tests/integration/resident_guard_test.mjs`) runs
the real `--resident-guard` process with a stand-in server script. Closing the
owner channel (Stop or host death) stops the server; a server ignoring SIGTERM
is killed after the 4-second grace; a changed executable is refused before
exec; an installation in progress is refused, not waited for; and the guard
runs only as a process-group leader. No model or llama.cpp build is involved.
Both targets are part of `make check-fast`.

```sh
make test-llama-resident-live DSTUDIO_LLAMA_MODELS=qwen36   # or qwen27
```

This explicit heavy gate builds or reuses the managed `llama.cpp`, launches the
real host in a private profile with the existing verified weights and runs ten
checks: an Agent CSV total computed with real tool calls, Agent recall, a
Cowork summary of a saved file, Chat with thinking on (exact product plus
reasoning present) and off (no reasoning), a 27B image question with pixel-only
expected answers, and owner death releasing the server. It refuses to start
when port 28000 is already listening. Receipts, requests and answers stay in
ignored `tests/.artifacts/llama-resident-live/`. The first Qwen3.6 attempt
(`run-vaKmku`) is retained as a failure: with thinking off it computed
4249045 instead of 4248045. The corrected case checks exact arithmetic with
thinking on and a thinking-off reply without reasoning; both models then pass
10/10 (`run-NFwKHF`). These are development regressions on Apple Metal, not
held-out quality, numerical parity or CUDA/ROCm/Vulkan qualification.

`make test-llama-install-profile` (in `check-fast`) executes the installer's
production build recipes, receipts and leases with simulated toolchains
(tiny `nvcc`/`hipconfig`/`amdgpu-arch`/`glslc` executables): the macOS recipe
keeps its original build identity; Linux/Windows add every CPU variant and a
module per detected backend; a requested backend without a toolchain fails;
an unrecorded `libggml-*` module or changed bytes make an installation not
current; exclusive install and shared server leases exclude each other.

`make test-llama-dynamic-build [LLAMA_DYNAMIC_INFER=gguf/MODEL.gguf]` builds the
dynamic (Linux/Windows) layout for real on macOS, offline under `sandbox-exec`:
shared libraries, every Apple CPU variant and the Metal module. It checks that
no load command points into the deleted stage, that the server runs from a new
location and lists Metal, reuse, and tamper rejection; the optional model run
loads existing weights once and checks one exact answer. The first run is
retained as a failure (`run-n4hyywj1`): its relocation check matched raw bytes
and caught `__FILE__` source paths that the tested static build also contains;
the corrected check reads `otool -l` load commands. This does not execute
CUDA, ROCm, Vulkan, Linux or Windows; those paths were only cross-compiled with
`zig cc` (x86_64/aarch64 Windows, x86_64 Linux).

### Qwen3.6 on MLX (Apple Silicon)

Qwen3.6-35B-A3B also runs from the MLX MXFP8 folder
(`mlx-community/Qwen3.6-35B-A3B-mxfp8`, pinned revision `5c216c8`) on the MLX
runtime bundled as unmodified wheels in `src/engines/mlx/` (mlx 0.32.3,
mlx-lm 0.32.0). The same resident owner, guard and model RPC serve it; only the
server (`python -m mlx_lm server` from a private virtual environment, with
`patch/mlx-lm-single-model`) and the readiness probe (`/v1/models` must list
exactly the admitted folder) differ.

- `make test-mlx-install-unit` (in `check-fast`): wheel verification against the
  manifest (changed, extra or linked wheels install nothing), per-Python hash
  selection, interpreter discovery with simulated interpreters, the receipt
  rule, and the patch's apply/repeat/reverse/drift lifecycle with real
  `git apply` on the `server.py` taken from the bundled wheel.
- `make test-mlx-install` (explicit; macOS 26, Python 3.12-3.14): a real
  installation into a new root with outbound network denied by `sandbox-exec`
  (pinned versions, Metal reachable, the server CLI runs, reuse, a changed
  interpreter is not current). No model is loaded.
- `make test-mlx-download-host` (in `check-fast`; Apple Silicon): seven real
  HTTP/process/file scenarios with a simulated installer and tiny weight files:
  the runtime installs before any weight transfer without changing the selected
  model, progress counts the folder and its private stages against the pinned
  36.67 GB, Open folder, verification is not completion, installer and
  verification failures, the refused partial cleanup, a linked folder admitted by
  its target's identity, and the real downloader rejecting a folder replaced
  after admission (`--verify-only`, offline).
- `make test-mlx-model-ui` (in `check-fast`): the production catalog/download UI
  functions; the download is offered on a Mac only.
- `make test-resident-unit` and `make test-resident-guard` include the MLX
  readiness rule and the MLX guard kind with its own installation lease.
- Real inference: `make test-llama-resident-live DSTUDIO_LLAMA_MODELS=qwen36mlx`
  and `make test-harness-live DSTUDIO_HARNESS_MODELS=qwen36mlx` (results in
  [docs/HARNESSES.md](../docs/HARNESSES.md)).

October 3, 2026, M2 Max, the user's existing verified MXFP8 folder linked into
`ds4/mlx/`: the resident live run passed **6/6** (`run-scIcQY`): Agent CSV
total, recall, Cowork, Design with the exact `<h1>` (133 s), Chat with
thinking on (reasoning present, exact product) and off (no reasoning), and a
killed host leaving no MLX server. Startup, including the offline MLX
installation, took 22 s. Three earlier runs are retained as failures, each
fixed in production code with a regression:

- `run-dI6doj`: `/api/start` rejected the folder as a missing model file (only
  regular files counted); `model_rel_present` now admits an MLX folder with
  `config.json` (unit-tested with a file, an empty folder and a link).
- `run-GDiTZ0`: the loaded server was never declared ready, because its
  Python HTTP server answers `HTTP/1.0` and the probe accepted only `HTTP/1.1`.
  The probe now accepts both; the unit test replays the real server's reply.
- `run-JzTNjb`: 4/6. Chat lost the reasoning (MLX names the field `reasoning`;
  fixed by `patch/mlx-lm-reasoning-content`) and Design stopped with
  `finish_reason=length` (upstream's 512-token default for requests without a
  limit; the server now starts with `--max-tokens` equal to the context).

These are development regressions on one Mac, not a quality comparison with
the llama.cpp Qwen3.6 or a numerical-parity claim for MXFP8.

`scripts/download-mlx-qwen36.py --verify-only --directory <folder>` checked an
existing local copy against all 20 pins (36,665,809,057 bytes) in 27 s.

### Harnesses: pi and OpenCode as the Agent runtime

`make test-harness-bridge` (in `check-fast`) executes the bridge's production
classes with real processes and sockets; pi, OpenCode, the host's model RPC
and ds4-server are explicitly simulated. It covers stdin framing and the
200 ms prompt boundary, frames that cannot be forged by model text, the
loopback endpoint's identity/sampling/thinking rules, one model request at a
time, Stop failing in-flight and queued requests without letting a late frame
through, pi RPC and OpenCode SSE event translation, user-echo exclusion and
WAITING/turn-error markers. `make test-harness-patches` (in `check-fast`) runs
real `git apply` on private copies: apply, repeat-apply rejection, exact
reverse, drift rejection without changes, the receipt rule (a different patch
set, pin or entry point is not current) and the bundled snapshots' identity.

`make test-harness-live` (explicit, real weights, sequential) runs pi and
OpenCode through the production host with Qwen3.6 and Qwen3.8-27B (llama.cpp)
and DeepSeek V4 Flash (bridge-owned ds4-server): a CSV total written to a file,
a code read in the same session and a file-tool read outside the workspace,
each checked independently, plus no surviving process after the host stops.
October 3, 2026: 18/18 on all six combinations. Retained failures:
`run-Q00iea` (a stale host binary ran the native Agent; the target now
rebuilds the host) and `run-qIhfpz` (OpenCode read beside the workspace; fixed
by `patch/harness-opencode`). See [docs/HARNESSES.md](../docs/HARNESSES.md).

`make test-llama-resident-live` also includes a Design case: the saved page
must contain the exact generated `<h1>`. Qwen3.6 passed with structured tool
calls; its first DSML-text attempt (`run-seDvHn`) is retained as a failure.
On Qwen3.8-27B (thinking on) the first run is retained as BLOCKED at the
one-hour turn bound (`run-i63kwA`): the page with the exact heading was saved
and verified, but the turn had not finished. The same run with no turn bound
(`DSTUDIO_REAL_TEST_TIMEOUT_MS=0`, `run-X0nLw6`) passed 6/6, Design in 2241 s.

`make test-qwen27-download-host` runs seven real HTTP/process/file scenarios,
with explicitly simulated installer and model bytes. It verifies asynchronous
engine preparation, two-component progress, a captured store despite another
checkout selection, Open folder for that same store, verification before
completion, Stop, failures and Resume.
A native ownership regression keeps a separate process alive while cancelling
the blocked installer; the download must not inherit the host's model-stop
signal handler. New cold owner state is 4,108 bytes, with a fixed two-file scan
and at most four one-byte downloader phase notifications. No hot layout changes.

`make test-qwen27-download` executes the real Python/curl downloader against tiny
HTTP fixtures: hashes, exact-range resume, size bounds, concurrent leaders,
directory/file identity, failure preservation and transfer/verification phases.
The host passes the admitted store's device/inode so a replacement directory
cannot receive a stale download after engine preparation.

`make test-ui-qwen27-download` exercises the actual Settings controls and native
HTTP host with the same simulated installer/weights. Select WebKit or Chromium
with `DSTUDIO_TEST_BROWSER=webkit|chromium` and light/dark with
`DSTUDIO_TEST_THEME=light|dark`. It covers confirmation, setup, transfer, hashing,
Stop and Resume; download progress must never replace the composer model label.

`make test-qwen27-download-settings-live QWEN27_INSTALL_ROOT=/path/to/install`
uses a previously installed pinned `llama.cpp` and both real components. The
production Settings HTTP path verifies the actual weights/projector and reuses
the engine, preserving their identities and current model selection. It starts
no LLM and does not substitute for an empty-network-install or inference gate.

`make test-qwen27-model-ui` executes the production model catalog, settings and
request functions. It distinguishes 27B from Flash-Next, checks the exact
projector/quantization pair, preserves other models' preferences, and sends
`chat_template_kwargs.enable_thinking` without a `reasoning_effort` for the
llama.cpp models. The existing `ui_model_picker_playwright_test.mjs` exercises
actual controls, launch requests and light/dark rendering for 27B as well as
the earlier models. Run it normally and with `DSTUDIO_TEST_BROWSER=webkit`;
its engine is simulated. `make test-qwen27-model-ui` also executes attachment
preparation for Chat/Tutor, Cowork and PDF routing, preserving attachments when
a textual/cloud/LAN model does not support those pixels. Its PDF renderer is
simulated.

`node tests/unit/cowork_spreadsheet_oracle_test.mjs` executes the real Office
CLI on temporary CSV/XLSX files in sixteen model-free cases; it is included in
`test-cowork-unit`. A CSV/TSV `inspect` can be a complete read; XLSX `inspect`
is metadata and cannot replace cell reading. Partial/truncated results,
mismatched IDs, wrong values, missing results and readback before creation fail.
`make test-goal` exercises Goal receipt cases and the existing continuation,
pause/resume and journal-recovery contracts.

`make test-macos-bundle` exercises current-main Chat runtime preparation using
the materialized bundle payload from Finder's `/` working directory, and checks
that the bundle ships the `main`, `laguna` and `llama` sources with the
installer pin. The lifecycle compiler is explicitly simulated. An old bundle
lacking the current PLD patch fails this test; a separate actual native build
verifies compilation. No model is loaded or user app restarted by this gate.

The common-100 runner in `tests/live/engine_acceptance.mjs` has an explicit
`--restart-failed-engine` option. Only the tester's native engine is stopped and
reaped before a fresh process is started with the same weights, binary and
settings. At most eight restarts are allowed; the failed case remains failed and
is never retried. Subsequent cases keep their original prompts/deadlines.
Missing readiness, changed identity, cancellation or an exhausted restart budget
stops the run with remaining cases marked not run.

`make test-qwen-quality-chart` checks actual Matplotlib bars against the reviewed
public common-100 aggregate, preserving every failure and rejecting incomplete,
inconsistent or simulated measurements. The chart is tied to the reviewed
source receipt so another model/run cannot inherit its hardware/date captions.
Recreate it with `python3 extension/benchmarks/qwen-quality/plot-results.py`.
The [benchmark notes](../extension/benchmarks/qwen-quality/README.md) describe
that development replay; it was measured on the retired `q36` engine and is not
a llama.cpp result.

`make test-engine-upstream test-engine-pins` tests release admission separately
from model quality. The first suite uses controlled Git remotes, real patch
conflicts, scoped receipt failures and the actual `dist-macos` publication
recipe with a tiny fixture bundle. The second executes the compiled native
`--engine-pins` command, including a relocated path with spaces, invalid
arguments and no profile writes or model startup. To test the desktop binary
itself, run `node tests/integration/engine_pins_test.mjs /path/to/DStudio.app/Contents/MacOS/DStudio`.

`make check-engine-upstream` is a different command: it checks the declared
candidate matrix, current remote revisions and actual installer metadata. The
initial matrix intentionally fails while required source reviews, installers
and qualification receipts are missing. `dist-macos` runs it against the
freshly built bundle before making a release ZIP; normal `.app` builds remain
available. See [upstream admission](../docs/ENGINE_UPSTREAM_ALIGNMENT.md) for
checkouts, platform scopes, evidence format and limitations. A checker-fixture
PASS is never an engine, inference or multi-platform qualification PASS.

`make test-backend-link` executes GNU Make with each of the four local upstream
Makefiles and compares native versus Agent/Chat-PLD/Design linker invocations
for Metal, CPU, CUDA and ROCm. ROCm arguments come from the upstream target's
actual recursive Make invocation, not a copied core-object list. The compilers
and linkers are explicitly simulated; this checks backend routing and complete
object/library selection, not compilation or inference on unavailable GPUs.

`make test-pld-build` checks the production Chat builder with a simulated compiler:
cache, Metal-only invalidation, preservation of a working binary on failed links,
invalid linker outputs, source changes during compilation and unsupported ABI.
It retains the original failures and successful runs under ignored
`tests/.artifacts/server-pld-build/`; no compiler fixture is counted as inference.

`node tests/browser/ui_agent_design_playwright_test.mjs` checks the real UI's
Chat continuation, native steering, late-reply draft preservation, receipt
reconciliation across turn changes and Goal controls. Run also with
`DSTUDIO_TEST_BROWSER=webkit`. `node tests/browser/ui_roadmap_playwright_test.mjs`
checks the learning pipeline and Tutor continuation with prior context intact.
Browser HTTP/model replies are simulated. None of these tests measures model
quality. See [behavior, limits and branch evidence](../docs/GOALS_AND_STEERING.md).

`make test-ui-qwen-learn` exercises that full Learn/Tutor workflow for Qwen3.8
and Qwen3.6, including model-specific thinking, unchanged configured context,
research/audit/retry routing, text selection, reading position and persistence.
It also repairs moved engine paths during generation, block expansion and
Tutor, without discarding the pending question (`DSTUDIO_TEST_STALE_CHECKOUT=1`).
Repeat with `DSTUDIO_TEST_BROWSER=webkit make test-ui-qwen-learn`.
The original DeepSeek case remains the runner's default; `DSTUDIO_TEST_MODEL`
accepts `deepseek`, `qwen38` or `qwen35`. Each run serves one frozen HTML input
and retains its hash, requests, outcome and failure screenshot in ignored
`tests/.artifacts/roadmap-browser/`. These are simulated-engine UI tests, not
model-quality results or a foreground `.app` E2E.

`make test-chat-lifecycle test-follow-scroll` executes the production settings,
readiness, HTTP/SSE and scroll functions with deterministic barriers/frames.
It checks stale model selections (including A → B → A), immutable request
inputs, cancellation and shared launch interest, plus deferred scroll writes.
Checkout tests execute the production resolver, launch preparation and API
client together: repaired identities propagate to each caller without borrowing
another caller's sampling/thinking/context or reviving an obsolete selection.
The same gates are prerequisites of `make test-frontend-unit`. Their receipts
are separate from real-model testing and preserve the original failed runs.

Browser fixture preferences must be initialized only in the top-level app's
own origin. Preview frames retain their opaque sandbox; browser errors are not
suppressed to accommodate test initialization. The gear, context and attachment
preview regressions also accept `DSTUDIO_TEST_BROWSER=webkit` (default Chromium).

The model-picker browser gate checks light/dark at desktop, 390 px and 320 px:
popover anchoring, exact model-to-engine selection, keyboard/search behavior,
and the visible geometry and hit targets of **all** composer controls, including
Send and the readable reasoning level. It waits for the real sidebar transition
instead of disabling animations. Each attempt keeps a separate receipt and
screenshots; failures also capture the visible page. These layout checks do not
claim that a simulated engine generated a correct answer.

## Focused gates and measured results

Image presets: `make test-image-pipeline` executes the production coordinator
and shell with explicitly simulated pixels. `make test-image-runtime` compares
all four presets, seven aspect ratios and every CFG step to the installed
official Ideogram/Comfy scheduler, including progress and the unchanged MAX
default; it does not generate images. `make test-http-lan` checks native HTTP
dispatch and rejects invalid presets. The Settings browser test runs in Chromium
and WebKit; the video browser and native Design interrupt tests check that the
saved preset reaches image requests without changing editing or video profiles.

The opt-in [Hermes-inspired live benchmark](live/image_preset_benchmark.py)
starts the actual installed Ideogram worker sequentially, with real weights.
It retains per-image captions, hashes, parameters, progress, failures and
wall time including model startup/shutdown. PNG sanity checks are separate from
visual prompt-adherence review. Public charts use Matplotlib; see
[image preset results](../extension/benchmarks/image-presets/README.md).

Current main compatibility, native Metal fixtures and empty-directory setup:
[September 7 update](../docs/DS4_MAIN_UPDATE_2026-09-07.md).
`node tests/integration/upstream_agent_prompt_test.mjs ds4` requires the already
built current main checkout on macOS. It compiles ten actual patched
Agent/Cowork prompt builders and parses the emitted schemas to verify native
vision capability gating, tool parameters and GLM envelope placement. It uses
an isolated source copy, does not load weights and is not a model-quality test.
Add `--laguna` with an already-built supported Laguna checkout to run its six
native/DSML/remote prompt cases instead. Both variants verify that the runtime
supplies all Office schemas without relying on duplicate JSON in `COWORK.md`;
the main variant retains its ten checks unchanged. Compiler and assertion
failures remain in the run's command logs and final receipt.

Qwen protocol tests likewise require the matching prepared core, not just a
checkout bearing a familiar branch name. In particular, `test-qwen38-agent`
needs the supported Agent source plus the versioned
[`ds4-qwen38-prepare`](../patch/ds4-qwen38-prepare/README.md) adaptation and
rebuilt core objects. The harness does not patch the supplied checkout or
reinterpret a missing API as a passing test.

Historical main engine update and real DeepSeek/GLM prefill/decode comparison:
[September 5 update](../docs/DS4_MAIN_UPDATE_2026-09-05.md).
`make test-main-decode-metrics` checks timing-span parsing and refuses speed
comparisons for failed workloads or changed model/prompt identities. The live
runner is opt-in and starts one actual model at a time.

DeepSeek V4.1 Q2 SSD measurement is explicit and separate from that historical
before/after comparison:

```sh
node tests/live/ds41_ssd_benchmark.mjs ds4 ds4/gguf/DeepSeek-V4.1-Flash-Q2.gguf tests/.artifacts/ds41-ssd-new-run 8 32768
```

It requires the complete pinned 365.7 GB file and verifies its full SHA-256
before starting one native Metal server, with an explicit 8 GiB expert cache
and 32,768-token context. Engram's disk table is separate from expert streaming.
It neither downloads weights nor stops another application. Five exact-answer
checks and three distinct workloads repeated three times retain all 14 planned
outcomes, raw responses, native processed-token prefill/decode times, settings,
source/binary/model identity, memory samples and failures. A timeout stops the
owned engine before further requests; it is not silently retried. Each attempt
requires a new directory, containing `results.json`, `engine.log` and a readable
`performance.txt`. No qualified speed appears in the text report until all
checks pass. These bounded tasks are not broad model-quality or numerical-parity
qualification. `make test-main-decode-metrics` also checks this benchmark's exact
oracles, truncation rejection, missing-evidence handling and failure reporting.

`make test-server-metrics-patch` executes the actual native JSON/SSE serializers
before/after the usage patch on current main, previous main and Laguna. It also
checks complete apply/check/restore, partial/drift rejection and preservation of
unrelated edits. The counters are controlled fixtures, not measured inference.
Source prerequisites, locations and timing boundaries are in the
[patch notes](../patch/ds4-server-metrics/README.md).

`make test-search-evidence` executes query-aware page excerpt selection and
the actual evidence-extraction request path with simulated model replies. It
checks late-page/Unicode evidence, fixed input bounds and cancellation without
publishing stale facts or issuing another call. Its loopback HTTP test verifies
real request closure and independent deadlines. It is not an LLM quality test;
live research and competitor work is tracked in
[the quality plan](../docs/SEARCH_AGENT_QUALITY_PLAN.md).

The [real page-evidence comparison](../extension/search/bench/README.md) runs
eight public fictional questions through actual Chrome and a resident native
vision model. The complete version-2 run is 3/8 before and 8/8 after, with all
latencies and original failed/grader receipts retained. It is not a full research
pipeline or competitor benchmark. `make test-search-publication` checks public
export bounds/denominators and the actual Matplotlib chart values.

`make test-remote-agent-workspace` executes the real Agent binary with simulated
model frames and actual read/write/bash tools. Absolute and relative `--chdir`
paths must affect all tools exactly once; missing directories fail before an
inference request. This catches the remote-mode regression caused by upstream
moving the local engine's `chdir` later. No weights are loaded by this gate.

`make test-web-visual-unit` executes the native same-page screenshot response
adapter. `make test-web-visual-browser` additionally requires Chrome and Python
Pillow: it compiles the browser helper against all four installed engine source
trees, reads a public fixture in isolated headless Chrome, decodes the JPEG and
checks its actual colors, retained text, exact page-tab cleanup and aggregate
fragmented-response limit. It preserves each run in a fresh ignored directory.
Neither target loads weights or establishes that a model interpreted the image
correctly. Search's simulated-model gate separately checks multimodal request
content, capability/model-switch validation, three-capture bounds, cancellation
and exclusion of image blobs from serialized chats.

Published benchmark charts use Matplotlib. Regenerate the engine, Design and
anonymous PDF charts from committed aggregates with
`python3 tests/support/publish_benchmark_charts.py`; run
`python3 tests/unit/published_benchmark_charts_test.py` to exercise actual
export validation, private-field exclusion, plotted values and PNG rendering.
These tests do not add inference or quality measurements. See the
[README results](../README.md#latest-measured-results) for their distinct scopes.

| Directory | Executes | Does not prove |
| --- | --- | --- |
| `unit/` | Production functions with controlled inputs and checked outputs | A model answered correctly |
| `browser/` | Real browser interactions, usually with simulated engine responses | Real model inference or real downloads |
| `integration/` | Tools, files, subprocesses, HTTP, build lifecycle | Model quality unless real weights are explicitly loaded |
| `live/` | Explicit network, hardware and/or real-model runs | All models, platforms or workloads are correct |
| `support/`, `fixtures/` | Shared harnesses and controlled input data | Independent test results |

## Clean installation and real inference

```sh
make test-setup-live                  # Real GitHub downloads + builds: main, Laguna, Qwen3.8, Qwen3.6
make test-first-launch-e2e            # Headless .app + real WebKit UI + fresh offline engine installation
make test-inference-live              # Real resident Metal: installed DeepSeek + Laguna
make test-inference-live ENGINES=qwen  # Requires downloaded Qwen base + PLE
make test-engine-acceptance           # Fresh builds AND real inference for all four engines
make test-qwen-chat-live              # Actual DStudio launch + Chat HTTP proxy, real Qwen
make benchmark-qwen-decode            # Native generation tok/s, three exact-output checks
```

The setup gate calls DStudio's production headless installer, using the same
bundled-source installer and runtime builders as app setup. It starts with no engine
directory, verifies/copies pinned local sources, builds the executables,
executes their help command, and checks that optional engines share the model
store. It does **not** simulate a browser onboarding click. Existing user
checkouts, models, preferences and running processes are not replaced or stopped.

`test-first-launch-e2e` instead relocates the signed `.app`, starts its real
binary from `/` with an empty `DS4UI_DATA_DIR`, and uses headless WebKit to
operate the first-run installation controls. `DS4UI_TEST_MODE` is **not** set.
It clicks Install, chooses the optional models, and checks real setup responses,
pinned revisions, compiled executable startup, automatic checkout selection,
shared model storage and discovery after reload. It also reverses/reapplies six
native main adaptations on a private source copy and requires exact file
preservation. This is not the complete Agent/server-PLD/web patch stack. The
same focused check is `make test-native-patch-roundtrip`; it uses the production
M2 build-hunk selector and metrics integrity checks. An existing engine-port listener (or a test-owned sentinel)
must survive installation and test shutdown.

Only `/api/model/download` is intentionally refused at the browser boundary,
**after** actual optional-engine setup; weights are not downloaded and inference
is not counted as tested by this gate. Model-start attempts are also blocked.
No setup/build/catalog response is simulated. This is headless application/UI
coverage, not Finder double-click, native title-bar, or native file-picker QA.
Evidence and screenshots are retained in `tests/.artifacts/first-launch-*/`.

To follow a successful setup with real loading of every supported installed GGUF:

```sh
node tests/live/installed_models_e2e.mjs tests/.artifacts/first-launch-<successful-run> ds4/gguf
```

This heavyweight gate requires the existing inference engine to be stopped
explicitly. It uses the freshly built runtimes and links their empty task-owned
GGUF directory to existing weights, without copying or moving them. Models are
loaded **one at a time**, with 8k context, DSpark off, resident Qwen/Laguna and
SSD expert streaming for main DeepSeek/GLM models. Qwen3.8 keeps its native SSD
PLE. Each model must become ready, return exact arithmetic and JSON extraction
answers through DStudio, then answer a checked prompt through the real Chat UI,
including completed SSE and visible rendered text. No response is mocked.
Auxiliary GGUFs and unsupported models are listed separately; missing weights,
timeouts, truncated answers and failed checks are not passes. This does not
qualify all quantizations, maximum context, vision, Agent or Cowork behavior.

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

Qwen3.8 has experimental **Chat, Agent and Cowork** integration on macOS Metal
with the new engine pin. Its Design adapter is not implemented. Only Qwen3.8
needs the SSD-backed PLE file. Qwen3.6 and Qwen3.8-27B run on the bundled
llama.cpp engine; see [Qwen3.6 and Qwen3.8-27B on llama.cpp](#qwen36-and-qwen38-27b-on-llamacpp).

The Qwen3.6 sections that followed here (fresh `ds4-qwen35` setup, its
September 7 11/12 native baseline in `engine-acceptance/run-m8zF5Z/`, and the
`ds4-qwen35-catalog` patch) described the retired fork. Their receipts are
retained under ignored `tests/.artifacts/`; the commands were removed with the
fork and are no longer runnable.


## Local regression suite

### Vision encoder with SSD streaming (real Metal)

```sh
make test-vision-streaming-live
# Optional existing source/encoder locations:
make test-vision-streaming-live VISION_DS4_DIR=/path/to/ds4 VISION_ENCODER=/path/to/encoder.gguf
```

This explicit, bounded regression clones the pinned local Git source into an
ignored test directory and maps only the installed 933 MB DeepSeek Vision-Exp
encoder. It does not launch a language model, restart the app or touch downloads.
Real Metal kernels encode a synthetic image and route text/image token IDs before
and after three alternating language-weight span replacements. The unpatched
build must reproduce six mapping failures; the patched build must preserve the
exact encoder and routing outputs on all six checks. Baseline output hashes must
also match between the separate unpatched/patched builds. Patch apply/restore is
checked twice, with exact tracked-source restoration.

Logs, engine revision and the run receipt remain under
`tests/.artifacts/vision-stream-*/`. Missing hardware/weights or a failure is not
counted as a pass. This verifies the reproduced memory-mapping regression, not
full PDF comprehension, end-to-end LLM inference or BF16 reference equivalence.
The native fix takes effect only when a rebuilt engine is started; this test
cannot update an already-running process.

### Small SSD prefill batches (real Metal, 128k context)

```sh
make test-ssd-prefill-batch-live
# Optional existing checkout (default installed Vision-Exp weights under gguf/):
make test-ssd-prefill-batch-live SSD_TEST_DS4_DIR=/path/to/ds4
# Or specify existing GGUF and encoder explicitly:
node tests/live/ssd_prefill_batch_test.mjs /path/to/ds4 /path/to/model.gguf /path/to/encoder.gguf
```

This sequential test reproduces the DStudio GLM/M2 port's DeepSeek regression:
the old port rejects a batch with more than eight distinct experts, although
each token selects only six. It builds clean, task-owned engine sources and
checks that the production migration fixes both the real Metal kernel and the
real first transformer layer. Nothing restarts the app, copies/downloads weights
or changes user preferences. Each layer process has a 60-second deadline and
loads layer 0 only, with 131072 context, SSD on and a 256-expert cache (about
4.17 GiB planned GPU allocation on the tested Flash model).

- Four synthetic GPU batches check every result against an **exact CPU oracle**:
  12, 30 and 384 distinct experts, plus GLM's eight experts per token. Invalid
  per-token counts 0/9 and resource count 385 remain rejected.
- Six real-weight cases (1, 2, 139, 760, 761 and 1024 tokens) check **every output
  float bit-for-bit against upstream without the GLM/M2 port**. This covers the
  reported 139-token failure and both sides of the selected-address boundary.
- The legacy binaries must reproduce the specific kernel/layer failures; a
  timeout or missing dependency cannot satisfy the negative test. Existing
  GLM top-8/cache numerical tests run as well.

Logs, patch/engine identity, raw layer outputs and hashes are retained in
ignored `tests/.artifacts/ssd-prefill-*/`. This is a numerical layer regression,
**not** full-model inference, PDF comprehension, a 128k-token input test, BF16
equivalence or a speed benchmark. The context allocation is 128k; each tested
input contains at most 1024 tokens.

`make test-glm53-m2max-patch` also exercises fresh apply/restore and installed
legacy migration, with dry checks, partial-state refusal and unrelated-edit
preservation. Native readiness and the PLD builder tests verify that Metal-only
source changes invalidate old binaries. Frontend behavior tests verify that a
generic prefill failure is no longer mislabeled as an out-of-memory diagnosis.

### Model-free checks

For an explicit real-embedding benchmark of every PDF in a supplied directory,
see [PDF library benchmark](../docs/PDF_LIBRARY_BENCHMARK.md). It retains private
source-grounded questions, per-file cold/warm times, retrieval/evidence failures
and matplotlib charts in ignored artifacts. This tests retrieval, not answers
from a generative model.

For complete PDF reading, run `make test-pdf-complete` (Poppler and Playwright
WebKit required). This executes the native reader on actual PDF fixtures and
compares all text, page by page, to independent Poppler extraction. It covers
uneven page lengths, warm/changed inputs, sparse/scanned/oversized fallbacks,
native images, mixed attachment preparation and full Chat upload with actual
source highlights. Only the browser's engine response is simulated; no model
is loaded. Reports/screenshots are kept in ignored `tests/.artifacts/pdf-complete-*`.
See [the reading design and limits](../docs/PDF_READING.md).

For PDF evidence, run `make test-pdf-evidence`, also with
`DSTUDIO_TEST_BROWSER=webkit`. This uses real synthetic PDFs, the native HTTP
endpoint and Poppler to verify passage matching, render geometry and clickable
links. Repeated labels retain all distinct passages in a modal chooser; no
unattached source or ambiguous calculation is silently accepted. Choosing a
different page aborts the old request and a delayed reply cannot replace the
current image/highlights. Invalid/truncated metadata is hidden with an honest
warning. The full-app attachment browser test separately verifies streaming and
chat reload with repeated labels (simulated model answer, no inference).
The evidence suite also exercises collapsed source cards, keyboard expansion,
direct quotation-to-page navigation and narrow-screen wrapping in both themes;
the original quotation bytes still reach Poppler unchanged. Screenshots are in
`tests/.artifacts/pdf-evidence/`.

Run `node tests/browser/ui_model_picker_playwright_test.mjs` (also with
`DSTUDIO_TEST_BROWSER=webkit`) for the composer picker. This uses a simulated
launcher, not model inference. It checks the popup's actual distance from the
model button with a multiline draft, viewport bounds, keyboard/search behavior,
outside-click dismissal and light/dark layouts.

`make check-fast` runs local functional/browser/integration tests without a
large language model. `make test-cowork`, `make test-frontend-unit`,
`make test-pdf-evidence` and `make test-pld` select narrower suites. Stateful test
doubles remain useful for failure/recovery coverage but are labeled as such.
`make test-video-open-weight` is separate: it compiles and runs a small real
Metal attention-equivalence probe and requires the installed H3 checkout.

Settings and model-switch regressions can also run in WebKit (the browser engine
used by the macOS app):

```sh
node tests/browser/ui_settings_redesign_playwright_test.mjs
DSTUDIO_TEST_BROWSER=webkit node tests/browser/ui_settings_redesign_playwright_test.mjs
```

Both require the corresponding Playwright browser installed. They click Done
with invalid fields in hidden panes and exercise Qwen/DeepSeek/GLM selection,
SSD preferences, cancellation, duplicate clicks, delayed preparation, stale
readiness, progress and launch errors. Background download progress and paused
state remain in Settings while the composer retains the model name, including
after a reload; these display-only interactions must issue no engine/download
mutations. Filtering/refreshing the model list also preserves the selected
download target; the confirmed request must name that exact model, not the first
option in the refreshed list. Loading visibility is hit-tested in the browser. The launcher
responses are simulated; no weights are loaded and these
tests do not measure inference. Screenshots go under `tests/.artifacts/`.

The composer model picker has its own browser regression:

```sh
node tests/browser/ui_model_picker_playwright_test.mjs
DSTUDIO_TEST_BROWSER=webkit node tests/browser/ui_model_picker_playwright_test.mjs
```

It searches installed models by name/quantization, excludes manual engine-branch
choices and support files, checks keyboard navigation and viewport fit in both
themes, and verifies that selecting Qwen chooses its matching engine before
launching. Catalog delays/errors and background download polling must preserve
search input and focus. The launcher is simulated; this is not real inference.
Screenshots and the request receipt go under `tests/.artifacts/model-picker/`.

The old source-pattern contract files were removed. Their useful parser, LAN,
Markdown and browser checks were retained as behavioral tests. Build-failure
injection tests cover cleanup and source preservation, not compiler correctness;
real first-run builds provide that separate evidence.

Original Design packs and native agent quality have separate checks:
`make test-design-originals` exercises the actual catalog and rendered components;
`tests/live/design_originals_comparison.mjs` launches the real native agent.
`make test-design-generation-process` tests its process/capture path with real
subprocesses and **simulated native protocol**, without a model. Unicode and
multiline input survive chunk boundaries, both output pipes drain before
artifact acceptance, and malformed/incomplete JSON cannot become a PASS. The
test also exercises cancellation, original deadlines, owned-group cleanup,
failed log admission and a real OS-limited file write failure. Existing output
is never replaced. Raw log prefixes, exact received/persisted counts and failures
remain available when capture fails. Each real case admits at most 128 MiB of
stdout, 32 MiB of stderr, a 2 MiB line and 16,384 events / 16 MiB of structured
events. One write per pipe is in flight; a slow disk applies backpressure, not an
unbounded memory queue. These are explicit benchmark resource limits, not
claims about native tool maxima. Startup/turn deadlines remain 15/30 minutes;
overrides may shorten them, not hide failures by extending them. Generation
latency ends at idle; teardown and total capture time are recorded separately.
`tests/support/design_comparison_audit.mjs` operates completed generated pages;
`tests/support/design_comparison_report.mjs` summarizes two full audits, retaining
failures and rejecting mismatched models, prompts, settings or audit revisions.
The eighteen-pack auditor under development is
`tests/support/design_project_audit.mjs`, with separate task-specific browser
scenarios and immutable, bounded export snapshots. Run
`make test-design-project-auditor` for **authored grader fixtures**, not model
quality: the shared pipeline, editorial search/dialog, reading-list notes,
repair-queue and incident assignment/resolution scenarios run in
Chromium/WebKit, both appearances, local files, an opaque iframe and enlarged
text (the enlarged-text/file matrix currently qualifies the shared editorial
pipeline; the new domain oracles cover both browsers, themes and opaque frames).
Broken Clear, repeated essay/dialog content, shared or HTML-interpreted notes,
stale rows/counters, shared assignees, auto-applied drafts, incomplete or
out-of-order history, wrong item details, broken Retry, misaligned radios, symlink escape
and incomplete provenance must fail. A forged successful-delivery flag with
incomplete native capture is rejected; unstarted projects remain NOT RUN in the
18-case denominator. The remaining fourteen scenario oracles and native
eighteen-project generation are not yet qualified; see
[Design systems](../docs/DESIGN_SYSTEMS.md). No manual benchmark HTML repair.

`make test-design-project-resources` exercises actual Chromium/WebKit error
events on explicitly authored defective pages. Errors arriving during teardown
remain failures. Per view, retained browser problems are bounded to 64 entries,
64 KiB of serialized entries and 4 KiB per text detail (without splitting
Unicode). Any exceeded bound closes that view and fails it, retaining the prefix
and explicit overload reason; it never becomes a truncated success. Console,
script, opaque-frame and blocked-network floods are covered, and a separate
browser context remains usable. These are retained-evidence bounds, not a hard
RSS limit on the browser's internal event transport. Dialog checks await actual
closure within the existing three-second action budget; a dialog that permanently
prevents Escape still fails. None of these fixture tests measures LLM quality.

`make test-design-comparison-report` tests this accounting with synthetic
receipts; it is not an inference or aesthetic-quality test.
`node tests/live/design_generation_limit_test.mjs` explicitly loads real DS4
weights and deliberately limits each round to one token. It checks three bounded
continuations, an honest incomplete status, return to the input loop and prior
file preservation. This is runtime fault injection, not a useful-answer or model
quality test. Run it sequentially after other model tests. An optional captured
comparison directory selects its frozen executable/source to reproduce the old
failure; that failing receipt is retained rather than counted as passing.
`make test-design-tool-recovery` executes the native loop with deliberately
truncated simulated model frames and verifies exact file preservation/retry
results. `make test-design-tool-stream` runs the same loop and checks the live
`tool_call_begin` / `tool_call_param` / `tool_body_delta` events used by Open
IDE: the streamed write body equals the saved bytes, deltas are capped,
cut on UTF-8 boundaries and never contain DSML markup, edits stream old then
new, and an unclosed stanza is previewed but never executed. `make test-design-archive-build` compiles a real local source archive
without engine Git metadata and checks rebuilds after source changes. Neither
test loads a model; the archive test does not download its fixture.
`make test-design-build-freshness` executes the production native builder and
script with an explicitly simulated compiler: 17 cases cover failed/incomplete
links, byte-bound freshness, compiler flags, untracked GPU/header changes,
complete/partial patches, concurrent Agent/Chat builds, parent/group death,
stale source rejection, directory replacement and symlink confinement. Failed
and successful receipts are retained under `tests/.artifacts/design-build/`.
The native archive gate supplies the separate real compilation/startup proof.

Design now builds in a private source/object snapshot under the checkout's
native build lease. It does not patch the original checkout or reuse its shared
objects. Only the native owner publishes the prepared executable; a surviving
compiler cannot publish after that owner dies. The derived stamp includes source,
support and selected Make/compiler configuration digests plus the executable's
digest. A crash between executable and stamp replacement is not a fresh build.
Compiler/linker program bytes, resolved Apple tools and SDK identity are part of
the configuration receipt. If a custom command cannot be resolved, it remains
buildable but is not eligible for cached reuse. One focused case uses real Make
and the real compiler metadata to change a wrapper without changing its version.
For a direct developer build use `./dstudio --build-design ENGINE_DIR`; the shell
entry point accepts `DSTUDIO_BUILD_HOST` for an explicit current host binary.
Snapshots admit at most 4,096 source files, 32 MiB per file and 128 MiB of source;
cleanup is descriptor-anchored and bounded. Eight retained interrupted snapshots
block another build for inspection, rather than authorizing deletion by name.
Windows' prebuilt-runtime path is separate and is not qualified by these macOS
tests. Full cross-backend/toolchain qualification remains a separate gate.
To limit the existing native build/tool gate to the changed Design path, use
`DSTUDIO_NATIVE_DESIGN_ONLY=1 node tests/integration/agent_native_build_test.mjs
MAIN_DIR LAGUNA_DIR QWEN38_DIR`; add `DSTUDIO_AGENT_BUILD_BACKEND=cpu` for CPU.
Each supplied checkout is copied into an isolated source fixture; weights are
not copied or loaded. Runtime tool frames are simulated in this gate.
See [Design systems and regression coverage](../docs/DESIGN_SYSTEMS.md).
Successful previews and prompt-string checks are not counted as model quality.

Actual-product comparison helpers live under `tests/support/product_*`;
`tests/live/product_quality_pilot.mjs --run` requires the pinned OpenWork and
OpenDesign checkouts and their installed runtime tools. It starts the actual
servers, not a generic standalone OpenCode task, and routes their inference to
one shared local model. Run it sequentially. Independent code/document and
Chromium workflow audits reopen the saved outputs. The artifact-serving and
semantic grader regressions are model-free:

```sh
node tests/unit/product_artifact_server_test.mjs
node tests/unit/product_design_grader_test.mjs
```

`make test-search-evidence` also covers whole-loop work budgets and actual HTTP
stream cancellation. Its model/page responses are simulated. In contrast,
`node tests/live/research_pipeline_benchmark.mjs --run` loads real weights and
executes full Search/Research against public websites, including the final
answer. Each invocation creates a fresh ignored receipt directory and preserves
failures. Review every answer against the fixed primary-source expectations
before publishing a quality score; completion and citations alone are not a pass.

The included `research_entrypoints_test.mjs` executes public Search and Research
through actual loopback HTTP with simulated classifier, picker, page, extractor,
judge, writer and reviewer messages. It checks that a classifier cannot drop a
supplied URL, explicit evidence is read first, sufficient evidence avoids
unrelated discovery, a comparison retains selected external evidence, original
language/request constraints and evidence identities survive, and Stop during
a blocked read cannot start a late writer. The live harness loads the complete
canonical runtime; private helper-list omissions cannot change its behavior.
No quality scores, live inference deadlines or evaluation requirements change.

Focused regressions exercise URL-heavy page excerpts, overlapping windows,
Unicode offsets, preserved original language/length constraints, evidence-ID
selection and cancellation during synthesis. They run production functions
with synthetic source/model data, not real-model quality measurements.
`research_answer_review_test.mjs` exercises omitted counter-evidence, bounded
writer/reviewer corrections, actual word counts (including exclusive bounds),
malformed/unknown review IDs, transport failure and cancellation. Additional
regressions preserve valid multi-envelope JSON comparisons and correct an
invented evidence gap without deleting the general rule that answers it.
The distinct
`research_reply_delivery_test.mjs` executes the production assistant-reply
lifecycle: exact reviewed text reaches the rendered and persisted message,
failed review stays incomplete, and ordinary Chat/Search still stream normally.
These are simulated model/UI dependencies, not a desktop WebKit E2E run.

`make test-search-evidence` also executes `research_synthesis_runtime_test.mjs`:
the production writer/reviewer can wait beyond the former four- and fifteen-minute
cutoffs with a deterministic clock, while explicit test deadlines and Stop abort
the transport. Actual streamed text survives EOF, output-limit and transport
failures; missing output never becomes an internal evidence scaffold. News facts
mentioning a model cannot select technical-report sections.

`make test-slow-runtime` advances production owner clocks by four hours with
real task-owned child/pipe barriers: slow llama.cpp `/props` readiness, runtime preparation,
silent native inference, late readiness/results, Stop/reaping and discarded
canceled replies. A held private DS4 lock also exercises shared-engine loading
through the real HTTP status response without touching the user's lock/process.
Its PDF planner test executes production routing/preparation with simulated
model/read responses: exact physical pages, invalid plans, original bytes and
canceled late reads. These checks use no weights or quality corpus.

The Research work-budget test advances each extraction by two simulated hours
and still reaches the unchanged page/query/action ceilings. Goal/Task Graph
checks cover unbounded defaults, preserved explicit budgets, serialization,
durable transitions and cancellation. Launch browser checks preserve a loading
attempt and its Cancel button after four simulated hours in WebKit/Chromium.
`make test-pdf-complete` also exercises Chat's real WebKit attachment/Stop flow
and four-hour physical-page planning with real Poppler reads and a simulated
model. Earlier failed receipts remain in ignored artifacts; these checks do not
change the quality harness's frozen deadlines or start the operator-owned suite.

`make test-ui-research-progress` requires Playwright with installed WebKit and
Chromium. It runs the production UI against isolated loopback HTTP fixtures with
simulated model/page replies: current progress beyond twelve events, large pending
batches, attached messages and text selection, reading position, background chat
isolation, Stop, fragmented UTF-8 SSE, visible incomplete outcomes and retained
failed receipts on retry. Screenshots and receipts go to ignored
`tests/.artifacts/research-progress-browser/`. This is model-free browser/runtime
coverage; it does not start the quality corpus or assess a real research answer.

For a new measured replay, `--before COMMIT` records the intended historical
runtime; `--variants after` keeps all four questions without re-running that
historical version. The live runner follows each runtime's actual final-answer
handoff, including direct delivery of reviewed reports in the new version.
Independent answer review remains mandatory; the model review is not the grader.

The complete [pipeline report](../extension/search/bench/PIPELINE.md) separates
live answer reviews from those deterministic checks. Its publisher requires
every question and a review bound to each unchanged raw row. After review,
`node tests/support/check_research_quality.mjs REFERENCE_JSON CURRENT_JSON`
rejects any lost previously demonstrated requirement, even if the aggregate
score or latency improves. The current receipt must contain all four after
cases; a partial retry cannot satisfy this gate.

`make test-product-comparison-publication` also runs a real headless Chromium
layout regression on the untouched published website. It detects wrapped radio
labels entering the indicator column at 390/1440 px, tests an independent good
layout, and verifies the original artifact hash. A passing regression detector
does not mean the archived design passed: its visual defects remain visible.
The same target now checks the untouched DS4-regenerated artifact in Chromium
and WebKit, with five radio choices and the complete journey at four widths.
It is a model-free regression of saved output, not a new inference run.

`make test-design-self` also reproduces the radio defect through the production
`verify_artifact` geometry gate and `inspect_layout`, then verifies a CSS-only
repair at 1280/768/390 px. That synthetic fixture is a regression test, not a
replacement for a model-generated benchmark artifact.

To regenerate the workshop from an empty workspace using the real Design
runtime and local DS4 weights, without rerunning unrelated competitors:

```sh
node tests/live/product_quality_pilot.mjs --run --products dstudio --cases design-workshop-journey
node tests/support/product_design_browser_audit.mjs PATH_TO_RESULTS_JSON --browser chromium
node tests/support/product_design_browser_audit.mjs PATH_TO_RESULTS_JSON --browser webkit
```

This is a development replay of the same brief, not a new head-to-head ranking.
The browser audits operate the unchanged generated HTML, including native radio
keyboard selection when present and both workshop/day label geometry. Preserve
the original failed artifact and every unsuccessful replay; never hand-edit
generated HTML or substitute a manually corrected screenshot.

See the [real-run report](../docs/ENGINE_ACCEPTANCE.md) for actual failures as well
as successes. Qwen native generation throughput is reported separately from
DStudio Chat latency and from the small cross-engine acceptance battery.


## Bundled offline engine sources (September 30, 2026)

`make test-engine-sources` executes the production verifier, source copy and
exclusive publisher with real files. Its 18 cases cover byte/mode integrity,
missing/extra/altered inputs, linked files and parents (including a deterministic
parent-switch barrier), source/manifest and target races, owner-lease replacement,
independent preparations overlapping at a deterministic barrier,
retained-candidate limits and interrupted durability acknowledgement. It also
copies/verifies all three active source snapshots (main, Laguna, llama.cpp) and
rejects copying or installing the retired Qwen Next source. `make test-macos-bundle`
checks that the relocated app materializes exactly those three snapshots with pins
matching its native metadata. No inference is claimed by these cases.

`make test-engine-updates` exercises the actual native HTTP endpoints with a
fixture checkout and Git peer. Update checks must not invoke Git, and stale
`ds4-latest` requests must fail before changing sources or executing commands.
The original failing receipt is retained separately from the passing run.

`make test-first-launch-e2e` uses a relocated signed app, an empty profile and
real WebKit controls. External outbound connections are denied by macOS for
the app and all its compiler/installer children; loopback UI requests remain
allowed. Main and Laguna compile from the bundled snapshots, and llama.cpp is
built through the app's `--install-engine llama` CLI, with no weights or model
inference. Packaging and source installation are separate
from the operator's full model-quality rerun. See
[provenance, source omissions and refresh workflow](../docs/BUNDLED_ENGINES.md).
