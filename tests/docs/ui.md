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
phases; the tests assert that it stops after a terminal error and under reduced
motion (stopping for confirmation and readiness is not asserted).
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

`make test-ui-theme-first-paint` checks that the saved theme is on the static
shell before the app has loaded its history. The history database is held by
a deterministic barrier that never answers, so the app module cannot reach its
own theme step; the test then reads the theme attribute and the painted rail
color while the page is still inert. Eight cases cover dark, light, `system`
under both emulated OS schemes, an unknown value, another schema version,
missing settings and damaged settings, in WebKit and Chromium. On the page
before this fix the three dark cases fail. The check was added after
`check-fast` on November 10 (`campaign-3b03ef4e-py314.log`, retained) failed
`test-ui-sidebar` once in WebKit: under load the dark page was captured with
light panes while it was being repainted from the default theme. Twenty
unchanged repetitions afterwards passed, so that single failure is not a
measured rate.

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

`make test-ui-task-graph` (in `check-fast` through `test-ui-browser`) runs
WebKit and Chromium with every `/api/task-graph*` request forwarded to the real
test host, whose scheduler, journal and synthetic executor (nodes that only
wait) run the graphs; the Agent session status is simulated and no model runs.
The user opens the live Task Graph from the ⌘K palette, starts a ready graph,
watches the node cards follow the host's states, pauses (the running node
finishes and the next stays pending while paused), resumes to success and sees
the durable events. A second graph is paused, the window closes and the host
process stops; after both start again the dialog lists the paused and the
finished graph from their journals with no new event, and the paused graph
resumes and finishes without rerunning its completed step.

`make test-ui-skills-editor` (in `check-fast` through `test-ui-browser`) runs
WebKit and Chromium with `/api/user-skills*` forwarded to the real test host
under a task-owned `HOME`. A skill written in the editor (quotes, backslashes,
a tab, non-ASCII text and a `---` line) is saved byte for byte as
`SKILL.md` in the folder the Agent runtime reads, selected for the next turn
without a restart, reloaded exactly for editing, rewritten in place, and listed
again in a new window with an empty browser profile. A skill over the size the
host can store is refused in the editor with its text kept; before November 12,
2026 the host saved it cut to 32 KiB and reported success, and each
edit-and-save added a trailing newline.

`make test-ui-plan` also acts on finished plans with simulated replies: Stay in
plan mode sends nothing and the next request is planned into its own file;
Implement plan turns Plan off and sends the execution turn for that file; Chat
about this turns Plan off and the next message is a plain turn.

`make test-ui-design-flow` runs `tests/browser/ui_design_flow_playwright_test.mjs`
in WebKit and Chromium against the same host in Design mode, with the real
`/api/design/files`, `/api/design/file` and `/api/design/preview/` handlers. The
Design stream is **simulated** with the events `ds4-design` emits for
`question()`, `propose()` and `write` (the shapes `make test-design-turn-gates`
receives from the real runtime), and the test performs the writes. It checks that the designer's
questions appear numbered above the composer, that **Continue** is held while
the turn still runs and then sends the exact `§QUESTION_ANSWER` turn once, that
the form closes, the reply after it renders and a reload does not ask again;
that three proposed directions render side by side as sandboxed live previews
of the host-served files, open full size and step between screens, and that
**Use this** sends the lock prompt for the chosen one and marks only it chosen;
and that the canvas **Export** saves every project file (nested folders, binary
bytes, a non-ASCII name) in `project.zip`, which Python's `zipfile` verifies CRC
by CRC and byte for byte. A file the host refuses to serve (larger than its
8 MiB limit) stops the export with a message instead of being archived as the
error text, which the page used to do. Receipts go to
`tests/.artifacts/ui-design-flow/`; no model or design engine runs.

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
basis; Workflow, Data flow and Lifecycle each get their own prompt and node
types, a node-type fallback, a default relationship type (control, data,
event) and their layout direction.

`make test-ui-blueprint` runs WebKit and Chromium against the real host
workspace handlers and the real `/api/fs/mkdir` on a task-owned workspace. The
Agent stream is **simulated** in the ds4-agent-jsonl event format and the test
performs the write. It covers the header button, the production prompt and file
path, the diagram building from the streamed JSON, verification of each kind of
citation outcome against the workspace bytes, node evidence, upstream and
downstream trace, routes (including none), lens, find, opening a citation in the
IDE at its lines and returning, the standalone HTML export opened in a fresh
page, the SVG export opened from disk (same parts, verification marks and its
own styles; no script or external reference) and the JSON export reopened with
the same evidence (a blueprint shown as its group overview still exports every
part, not the overview boxes, which it used to do), **Refresh** after the cited
code changed (the rewritten quote is reported as not found, the shifted ones at
their new lines, the file untouched), the new-blueprint card, Workflow, Data
flow and Lifecycle maps requested from it and drawn with their node and
relationship types, a sequence diagram, an invalid file, a map turn that ends
without saving its file (the panel reports it instead of returning to a blank
form, which it used to do) or saves one with no nodes, reopening the last
blueprint after a reload, **Implement code** (the implement prompt in the same
conversation, on the running engine, without a new session) and **Send to
Design** while the Agent still works (the engine switch is confirmed first:
Cancel starts and interrupts nothing; then Design starts on `design/` inside
the project, the blueprint card waits for the user's brief and goes with the
first message only). The simulated host replies to each send with the turn's
real `from`/`at` offsets, as `api_agent_send` does. Design startup is simulated
too: no design engine or model runs.

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
reload without replay, rejection, artifact previews, the light theme at
desktop and narrow (600 px) widths and the dark theme at desktop width only.
No model or tool subprocess starts. Screenshots and receipts,
including failed runs, remain under `tests/.artifacts/ui-workflow/`.
See [workflow behavior](../../docs/workflow-ui.md) for ownership and limits.

`make test-rsa-collectors` (in `check-fast`) is not a test of the app's RSA
workflow. It runs the RSA benchmark comparison script
`src/harness/rsa/bench/compare.mjs` with Playwright against three authored
loopback pages (single-page app, sign-in, media) and checks that its detectors
fire and that it writes its collector list, claim audit and quality gate.

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

`check-fast` does not run this matrix. It runs the same suites through their
own targets, in both browsers except `ui_gear_popover`, `ui_attachment_preview`,
`ui_video_generation` and the normal `ui_roadmap` scenario, which it runs in
Chromium only (`ui_reasoning_spacing` also runs in Firefox there). The three
Qwen Learn/Tutor replays run only in this matrix or through
`make test-ui-qwen-learn`. Until November 11, 2026 `check-fast` also ran
`ui_model_picker`, `ui_agent_design`, `ui_think_max_context`,
`ui_settings_redesign`, the two plan-mode suites, `ui_gsa` and `ui_rsa` in
Chromium only; their targets (`test-ui-browser`, `test-ui-plan`, `test-ui-gsa`
and `test-ui-rsa`) now add the WebKit run.

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

The shared reasoning selector is editable in Learn, Agent, Cowork and Design;
High is the application default. Learn generation, audit, repair and block
expansion honor the selected level. GSA/RSA do not override the preference in
UI workflow phases, native send or Task Graph dispatch. Selecting Max always
shows its repetitive-loop warning, including when context is already adequate.
Its existing context increase shares that dialog. Declining changes neither
level nor context. Tutor inherits the selected setting and warns on Max too.
`DSTUDIO_TEST_LEARN_THINK_LEVEL=off|high|max` controls the Learn browser fixture;
`ui_think_max_context_test.mjs` covers context and warning accept/cancel in both
browsers. Qwen's single native On/Off switch remains unchanged.

Learn now saves a prerequisite outline and each developed stage before
assembling the complete draft. Factual stage/global audits and the separate
curriculum judge still gate publication. Only a verified candidate replaces the
previous graph. Interrupted drafts remain saved and retry reuses validated
stages when the learner input, authoring instructions and saved evidence match.
Changing reasoning effort, model, context or memory mode keeps authored stages;
audit receipts still require the exact model/settings/evidence identity. Older
drafts without an input key can be loaded only as unverified work owned by the
same surviving learner message, with identical saved evidence and validated
stage ids/URLs. Editing that message removes its descendants. This is saved
curriculum work, not native KV/session restoration.

The workspace renders one current attempt. Previous attempts remain stored and
are accessible in collapsed history, including the original technical errors.
Starting a retry replaces the paused view immediately. A verified roadmap stays
usable with a compact update notice until a verified replacement exists. The
main paused view uses a readable explanation, saved-block counts and a resume
action; technical transport details live behind an explicit disclosure.

All roadmap generation, audit, repair and block-expansion requests stream through
the same bounded recovery path. It detects a substantial exactly repeating
reasoning suffix (at least 8,192 characters and four copies) or recurring
normalized paragraphs even when reordered, closes that request,
and retries only its phase with bounded unverified working-note excerpts.
Distinct long reasoning has no elapsed-time or output-token cutoff. Automatic
phase recovery and verification repair are limited to three attempts/rounds;
unresolved work is retained as incomplete, never accepted. Each phase retains a
bounded reasoning preview with an explicit omitted-character count, at most
1,048,576 output characters, and twelve small recovery receipts. A saved draft
has the same character limit. Storage failure prevents claiming a saved step.

`make test-roadmap-request` executes the production phase functions with
simulated frames: exact and short-period cycles, productive long reasoning,
serial request retirement, cancellation, stale results, invalid JSON, broken
transport, source/id validation and saved-stage continuation. Its first file,
`roadmap_request_test.mjs`, is the exception: it checks only that the live
Learn runner's request helpers under `tests/support/` send the selected
reasoning setting to a simulated engine, not the app. Run the focused
browser recovery case with
`DSTUDIO_TEST_LEARN_RECOVERY=1 DSTUDIO_TEST_BROWSER=webkit node tests/browser/ui_roadmap_playwright_test.mjs`
(or `chromium`). It stops after the first saved stage, reloads, resumes without
regenerating it, encounters a repeated reasoning stream, then completes all
verification. The normal fixture also repairs a truncated block expansion.
Add `DSTUDIO_TEST_LEARN_THINK_LEVEL=max DSTUDIO_TEST_LEARN_RESUME_THINK_LEVEL=high`
to check effort/context changes across resume, and
`DSTUDIO_TEST_LEARN_LEGACY_DRAFT=1` for an older saved draft followed by an empty
failed restart. The fixture observes DOM mutations for overlapping cards,
checks collapsed history and retained technical failures, and verifies that
saved stages are not requested again. `make test-ui-learn-recovery` runs the
recovery case with the effort change on Chromium, and the same case with the
legacy draft on WebKit; the other combinations are run by hand. Tutor checks
also exercise rapid warning
cancel/reopen/accept, including a queued close event from the prior dialog.
These checks do not qualify real-weight Learn output or the broader P3/P6 gates.

November 5 replaces the monolithic factual auditor with a finite plan: batches
of at most four content items, every stage pair and every stage/capstone pair.
Read-source excerpts accompany external factual checks. Supported/contradicted
verdicts require quotes that match both the supplied excerpt and the actual
read-page text. Unread discovery snippets are excluded. Missing evidence,
uncertain contradictions and unresolved claims cannot pass factual admission.
Per-batch receipts are persisted immediately; reuse revalidates the exact
item, selected evidence/full-source digest, learner context, model settings and
protocol. Changing a stage reopens its content batch and affected global pairs;
unchanged checks remain saved. A continuously active stream also periodically
flushes progress instead of indefinitely postponing a trailing debounce.

November 6 replaces Learn's shared leading-term excerpt query with bounded
per-item queries and literal passage selection. Navigation and duplicate link
tails no longer consume the same space as substantive page text. Each item gets
a selection turn, with resource-attribution claims before proposed exercise
counts. The packet retains at most eight sources and 14,400 evidence characters;
each source receives at most 3,600 characters and 24 selected passages. This
redistributes the former eight-by-1,800 ceiling, so a six-source batch can use
more text than its former six fixed slices. At most the first 256,000 characters
of each selected page are prepared. Preparation and selection yield between
pages and revalidate Stop and run ownership. This temporary per-batch index is
discarded after use; full read-source text remains authoritative. The generic
Search selector is unchanged.

Final-project pairs now carry explicit whole-roadmap scope and the remaining
stage ids; a project needing later-stage skills is not itself contradictory.
Content checks distinguish author-proposed learning tasks from external claims,
while embedded factual assertions still require evidence. Requested/canonical
URLs reach the actual audit request. Receipt identities bind these per-job
instructions and context: older content/project verdicts remain retained but
must run again; unchanged stage-pair contracts can reuse exact receipts. New
outline/stage text exceeding existing field limits is refused for bounded phase
recovery instead of silently clipped. Existing drafts remain available.

`tests/unit/roadmap_evidence_test.mjs`, included in `make test-roadmap-request`,
executes production retrieval against authored long menus, late named/numeric
facts and reordered four-item batches. It checks literal spans, Unicode,
character/count limits, canonical URLs, final-project context and deterministic
cancellation/stale ownership during both page preparation and selection. Its
simulated reviewer checks the produced contract, not real model quality. A
private model-free replay of five saved batches recovered nine missing witness
fragments; it neither admits new verdicts nor modifies the user's draft.

November 8 adds prerequisite-safe edits and explicit draft access; see the
[scoped correction](../../docs/changes/2026-11-08.md). `make test-roadmap-request`
includes the production graph-edit checks. The normal browser scenario now
refuses a drag before a prerequisite and deletion of a referenced block, accepts
an independent move, and verifies that a reload keeps edited graphs marked
unverified. The missing-evidence scenario displays a labeled draft, keeps edit
controls disabled and permits **Study draft** after the audit stops, without
promoting its unresolved verdicts to success. Run normal, partial and
missing-evidence scenarios in both Chromium and WebKit; replies are simulated.

November 10 routes Learn prompts sent during generation to notes on the
running request; see the [scoped change](../../docs/changes/2026-11-10.md).
`tests/unit/roadmap_notes_test.mjs` executes reply admission, the JSON-bounded
notes request, lazy stage guidance, targeted stage rewrites and partial draft
previews. `make test-ui-learn-notes` runs `DSTUDIO_TEST_LEARN_NOTES=1` in Chromium and WebKit. It holds a
real stage request and an audit request in flight, and checks:

- the readable partial draft;
- a durable note that neither aborts the step nor creates a new turn;
- the answer at the next boundary, and guidance only in later stages;
- one targeted rewrite with re-audit, and a single verified attempt.

Replies are simulated.

The November 10 Learn workspace redesign is covered by the same production
scenarios:

- the normal scenario checks the stage map, map navigation and stage
  collapse, header chips, the verified and modified notices, the block
  details, and menu-based add/delete;
- recovery and missing-evidence scenarios check the single status panel;
- `ui_roadmap_hover_controls_playwright_test.mjs` checks that hover and
  keyboard focus reveal *Study* and the **⋯** menu without moving them, and
  that arrow keys and Escape work in the menu;
- `tests/support/learn_ui.mjs` reaches block actions the way a learner does;
- `tests/unit/roadmap_view_test.mjs` executes the audit, hour, dependency,
  short-title and lossless checkpoint helpers.

Host mocks used by browser tests acknowledge an accepted history write as
`{"ok":true,"durable":true,"rev":N}`, as `src/dstudio_chat_store.c` does.
A mock that omits `durable` produces a persistence warning, which layout
assertions would then measure instead of the composer.

`make test-real-roadmap-notes` is the explicit real-weight check of the
message reply and targeted rewrite phases with an authored curriculum. It
reuses `DSTUDIO_LIVE_HOST` when set (an already running host whose engine must
report effective SSD streaming); otherwise it starts an isolated host and KV
directory with SSD streaming.

Within a completed response, verdict admission is now independent per id. A
three-of-four reply durably retains the three valid checks, then requests only
the missing id. Invalid quotes, duplicate/conflicting ids and malformed siblings
cannot qualify a check or discard valid neighbors. The same three-request phase
budget covers partial replies and other recovery; exhaustion retains progress.
Stop/reload revalidates partial receipts and preserves later saved jobs. Truncated
or failed transports cannot admit otherwise complete-looking partial JSON.
`DSTUDIO_TEST_LEARN_AUDIT_PARTIAL=1` exercises this path in the Learn browser
fixture, including Stop while the missing-id request is pending; the audit
target runs it on Chromium and WebKit. Unit tests cover invalid siblings,
stale ownership, storage/transport failures, identity drift and finite retries.
Older retained partial output is reusable only with a matching authoring-input
key, completed transport, exact compatible receipt prefix and unchanged pending
item text. The private saved failure is replayed separately from inference;
its transcript remains ignored and is not a public fixture.

The audit plan retains at most 512 jobs and 8M plan/evidence characters; receipts
retain at most 2M characters. Exceeding these budgets reports incomplete work
and preserves the draft. Receipt matching is derived-work reuse, not independent
proof that the model's semantic judgment is correct. Without WebCrypto on an
insecure LAN origin, checks run again rather than using a weak digest. The
reordered-paragraph detector holds at most 80 normalized paragraphs and requires
at least five recurring paragraphs, 6,000 duplicated characters and a majority
of duplicate paragraph occurrences; isolated quotations and distinct numerical
examples are covered by negative tests.

`make test-ui-learn-audit` runs Chromium/WebKit Stop/reload/reuse and missing-
evidence publication regressions. `make test-real-roadmap-audit` explicitly
loads existing V4.1 1017 Q2 weights in SSD streaming, serially runs five authored
factual/consistency oracles through the production host and Learn phase
normalizer, retains all attempts, and stops its owned engine. It neither downloads
weights nor qualifies a complete real roadmap. The retained private failure can
also be replayed through `DSTUDIO_TEST_REASONING_REPLAY` in
`tests/unit/roadmap_generation_test.mjs`; the transcript is never published.

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
Since November 12, 2026 `make test-ui-chat-controls` also covers Chat's
boundaries on the same simulated fixture, in WebKit and Chromium. Send and
Enter with an empty, spaces-only or tabs-and-newlines composer issue no request
and add no message. An authored stream that ends with `finish_reason: length`
shows "Response truncated (token limit)" with Continue; one that ends without
`data: [DONE]` shows "Response incomplete". In both, Continue sends the retained
text verbatim as the previous assistant turn followed by `Continue.`, and the cut
answer stays saved unchanged. HTTP 400 context refusals worded as ds4-server and
llama-server word them are shown with Retry; the refused request carried every
earlier message and none is trimmed from the saved conversation. A
`dstudio-files` block becomes a file tile whose canvas renders the Markdown,
downloads the exact bytes and reopens after a reload. Deleting a conversation
from its row menu removes it from the sidebar, the browser history and the
fixture host store (with a tombstone) and it stays deleted after a reload. The
test first failed against the previous page: the screen-reader status announced
a token-limit cut (and an error) as "Response completed"; it now announces
"Response truncated (token limit)" and "Response failed". The engine replies
are authored; this is not model behavior at a real context or token limit.

`make test-ui-chat-engine-death` runs the production page in WebKit and
Chromium against the real test host (`tests/.build/dstudio-server-test`). The
host's `/v1` relay forwards the completion to a scripted engine process (no
model) that streams two chunks and is then killed with SIGKILL. With
close-delimited SSE (ds4-server framing) the page keeps the partial text and
shows "Response incomplete" with Continue. With chunked SSE (llama-server
framing) Chromium reports "Connection interrupted during the response." with
Retry, while WebKit's fetch ends the body and the page shows "Response
incomplete"; both keep and save every streamed byte. The host keeps answering
`/api/status`, and once a new scripted engine listens Continue or Retry
completes the answer. The UI fixture pipes only the completion request to the
host; the other page endpoints are simulated. Receipts and screenshots are in
`tests/.artifacts/chat-engine-death-BROWSER/`. The host does not own this engine
process, so its own crash reporting for an owned engine is not exercised here.

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

## Conversation history persistence

`make test-chat-store-unit` executes the production native store with isolated
files and deterministic publication/failure gates. `make test-ui-persistence`
runs Chromium and WebKit with real IndexedDB/localStorage and the native HTTP
host, then Learn's simulated storage-failure recovery on both browsers. No
weights load and no inference occurs. Reports remain under ignored
`tests/.artifacts/history-persistence/` and `roadmap-browser/`.

The browser tests preserve more than 6 MiB of authored history, including long
reasoning, Agent/Cowork/Design transcripts and Learn/Tutor data. They verify
quota migration, settings after quota exhaustion, native acknowledgement while
an IndexedDB transaction is blocked, one in-flight writer, later save promises,
real native permission errors, simultaneous browser/native failure, recovery,
restart, independent-window merging, active-conflict refusal, malformed revision
headers and a clear-history epoch. LAN/offline history uses browser storage
without reading or writing the host-private history endpoint. The Learn case
denies both stores for three Retry clicks, checks unchanged saved draft data
and zero new research/model requests, restores storage, exercises Stop while
the next native save is blocked, and finishes the
simulated roadmap. The broader Learn/Tutor, Chat controls, Agent/Design and
workflow suites exercise their actual shared-save consumers separately.

The native file owns local-host history. Its browser copy is a replica;
LAN/offline clients own their browser history. Browser storage is scoped to
the origin and schema version (`dstudio-history`, `snapshots`, `chats.v2`). It
has one active write and one latest pending snapshot, with no automatic history
eviction. Migration commits before deleting the old localStorage key; failure
retains existing copies. Host saves admit one immutable candidate of at most
64 MiB plus the previous snapshot, refuse concurrent writes/wipe as busy, and
publish file/memory/revision only after preparation. Browser save callers are
bounded to 64; excess calls return an explicit failure. Since November 12,
2026 `make test-ui-persistence` executes both ceilings. In the browser, a
history over 64 MiB is refused with "Conversation history exceeds the 64 MiB
storage limit" while memory keeps every byte and neither the browser copy nor
the native file changes; with 64 callers waiting behind a blocked native save
the 65th is refused with "Too many conversation saves are pending", all 64
admitted callers resolve as saved and the next save carries the refused
caller's edit. Over HTTP, the real host saves a history of exactly 64 MiB,
answers 413 to a declared length one byte larger without changing the file,
and reloads the whole 64 MiB after a restart. Snapshot failure never
trims text or disables settings. The existing 300,000-character native transcript
tail limit is unchanged and separate from quota-failure handling.

A checkpoint succeeds after either a native durable acknowledgement or browser
storage completion. A native failure with a successful browser save is visible
as a warning. An active-window conflict remains a failure even if its local
replica saves. If both paths fail, critical callers stop before further work;
the in-memory draft remains. Native errors before rename preserve the old file.
Rename followed by failed directory sync returns uncertain durability and
updates memory to the file actually published. Cancellation does not undo an
already admitted history save; callers revalidate their own turn/settings after
awaiting it. Tests exercise these outcomes without claiming cross-platform
durability or engine KV restoration.

## Reasoning Markdown spacing

`make test-ui-reasoning-spacing` executes the production Markdown renderer and
styles in real WebKit, Chromium and Firefox (all three when
`DSTUDIO_TEST_BROWSER` is unset, as in the Make target) using a synthetic
standalone layout fixture.
It compares Chat and Agent reasoning paragraph/list geometry with ordinary
Markdown and verifies code bytes, visible code indentation and explicit blank
lines in plain-text summaries. The regression fails before the spacing fix in
both browsers. It requires the three Playwright browsers installed, is included in
`check-fast`, and writes screenshots and receipts under
`tests/.artifacts/reasoning-spacing/`. This is a rendering check, not a full-app
interaction or inference test.
