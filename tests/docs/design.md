# Design systems, startup and provenance

[All test guides](../README.md). Run commands from the repository root.
Each section retains its original scope, prerequisites, results and limitations;
a historical pass is not a pass on a newer runtime.

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
[`design_additional_interactions.mjs`](../support/design_additional_interactions.mjs):
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
[integration scope and remaining acceptance](../../docs/DESIGN_SYSTEMS.md).

## Interaction oracle qualification

The eighteen frozen briefs each have an interaction oracle in
[`design_project_interactions.mjs`](../support/design_project_interactions.mjs).
Since November 11, 2026 every oracle is qualified by an authored reference
page: the first by the fixture inside `design_project_audit_test.mjs`, the
other seventeen by `tests/fixtures/design_oracles/CASE_ID.html` with
`CASE_ID.json`. Each page must be accepted standalone and inside the opaque
preview frame, each of its deliberate faults (at least three; 6 to 13 in the
new ones) must be rejected for the stated reason, and the complete audited
view must pass in both themes, in Chromium and WebKit.
`make test-design-project-auditor` runs all of them;
`node tests/support/design_oracle_qualification.mjs CASE_ID` runs one. These
are authored fixtures: they qualify the oracles, not a model and not the 18
generated projects.

Qualification found one oracle defect that rejected every implementation: the
row helper `item()` built its inner text locator from a region or dialog
scope, so a row would have had to contain the region containing it. The queue
(`queue-order-and-active-item`) and basket (`variant-basket-totals`) oracles
could not pass any page, and the compare dialog accepted only a table layout.
The helper now builds inner locators from the page or frame; all seventeen
pages pass and the two formerly blocked ones reject their faults.

Qualification also recorded limits that are **still open**. They are listed
here so that a generated project is not judged by them unknowingly.

Correct pages an oracle or the audit still rejects:

- `thread-replies-literal-text`: a thread that starts with sample replies (the
  count check assumes it starts empty) and an author button named only by the
  author's name (it must contain "profile" or "author").
- `review-reason-and-undo`: filter buttons that carry their count, such as
  "Resolved (1)".
- `object-selection-edit-history`, `layer-order-visibility-history`: a
  six-object limit enforced without disabling the Add button. The word-board
  oracle then loops without end; the poster oracle reports `8 !== 6` because
  it counts its own clicks instead of the objects on the board.
- `variant-basket-totals`: row buttons whose accessible name repeats the
  variant ("Remove Chalk, Long cable") make the field lookup ambiguous.
- `settings-draft-commit`: a label such as "Project name (required)" (exact
  match; read from the oracle, not run).
- Audit, WebKit only: required text that exists only as `<option>` labels is
  reported missing, because WebKit's `innerText` omits it.

Defects an oracle does not detect (each was tried as a fault and passed):

- `settings-draft-commit`: saved summary never updated; no field error text;
  Save committing only the name.
- `room-wizard-validation`: Back clearing the room; Start over keeping time
  and count; time not required; a stale count hidden by the capacity text.
- `workshop-journey`: Start again keeping the chosen day.
- `tool-shortlist-limits`: no reason for the limit; visible count never
  updated; Remove on the main list doing nothing.
- `schedule-conflicts`: Morning filter broken; a rejection without feedback on
  a page that mentions conflicts elsewhere.
- `catalog-compare-price-order`: a third product refused without a message;
  shelf toggle and count stale after Remove in the dialog; a filter change
  dropping the selection.
- `queue-order-and-active-item`: duplicate tracks; Current moving to the next
  track when the current one is removed.
- `variant-basket-totals`: merging by colour only; quantities above four;
  grand total stale after Remove.
- `thread-replies-literal-text`: replies over the length limit or of spaces
  only; Unfollow not leaving the Following filter; no follow indicator.
- `review-reason-and-undo`: an Undo that does nothing when the open report
  repeats its title; stale counts; last reason erased by Undo; reason shown
  as markup outside the dialog; a reason of spaces only; one reason shared by
  all reports.
- `map-list-selection-filter`: stale details after a search; map buttons not
  filtered; no selection mark; Outdoors filter; notes for a cleared selection.
- `itinerary-order-map-path`: Remove deleting another stop; stale stop
  numbers; a path that omits the last stop. Move down, duplicate Add and the
  four-stop maximum are not exercised.
- `object-selection-edit-history`: a ten-action history with Undo left
  enabled; Delete removing every note; arrow keys moving all notes; notes
  leaving the artboard; an export preview without coordinates.
- `layer-order-visibility-history`: Hide hiding every object; Show doing
  nothing; the review dialog ignoring order or visibility; added shapes
  sharing a name; Add shape adding nothing; Move layer up doing nothing.
- Audit: contrast is measured once on the initial view and skips closed
  dialogs and disabled controls; overlapping controls are not reported.

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
