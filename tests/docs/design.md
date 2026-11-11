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
preview frame, each of its deliberate faults (at least three) must be rejected
for the stated reason, each declared variant must be accepted, and the
complete audited view must pass in both themes, in Chromium and WebKit.
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

A second pass on November 11 then worked through the limits that the first
pass had recorded, oracle by oracle. For each defect an oracle did not detect,
the frozen brief was read first: where it requires the behaviour, the oracle
gained an assertion with a specific message and the fixture gained the defect
as a fault; where it does not, nothing was added. For each correct page an
oracle rejected, the oracle was made to accept it and the page became a
`variants` entry of the fixture (an equally correct rendering the oracle must
accept). After that pass the seventeen fixtures held 262 faults and 85
variants (270 and 86 since the shared-helper correction below). Checks
that unrelated page text could satisfy (a regular expression over the whole
body, a title repeated by an open panel, a count that the catalogue itself
contained) now read the element concerned or the change the action caused, and
no oracle loops without a bound any more.

Deliberately not required, because the brief does not ask for it: rejecting a
reply or a reason made only of spaces; a follow indicator separate from the
Follow/Unfollow control; a selection mark on the map or list; the last reason
surviving an Undo; a message when the six-object limit refuses an addition.

The audit of the first generated projects (November 12) found one defect in
the shared layout check, not in the pages: text hidden on purpose was exempt
only under the class name `.sr-only`, so a `.visually-hidden` header with the
same 1px clipping rule failed reflow, and a skip link parked left of the page
until focused failed as text outside the page while the packs' own skip link,
parked above the page, passed. The check now recognises the visually-hidden
box and a positioned element wholly outside the page by how they render;
`make test-design-project-auditor` keeps both patterns passing and still
rejects text partly outside the page, text cut by an ordinary container and
content that widens the page, in Chromium and WebKit.

Limits that are **still open** after the second pass:

Shared helpers, used by every oracle. The second pass did not change them and
the scenarios worked around them locally. A third change on November 11
corrected the five limits recorded here and moved the duplicated workarounds
into the shared layer: one implementation each for the rows of a title, the
entries and rendered order of names, row action names, lines that appeared,
words that changed between two states and a statement that an action makes
appear. Each correction is exercised by a variant that the old helper
rejected and by a fault that the corrected helper still rejects; the fixtures
now hold 270 faults and 86 variants.

- Fixed: `choose` finds a tab that carries a count ("Resolved (1)"), after the
  tab or button named by the label alone (`filter-tabs-with-counts`,
  `tabs-undo-does-nothing`).
- Fixed for semantic rows: `item`, `selectEntry`, `shown` and `absent` read a
  row that says "1. Old kiosk" or "10:00 — Sound walks" in one text when no
  element is the bare name, so `absent` now fails on such a row
  (`number-in-name-text`, `numbered-list-rows`; `numbered-rows-not-filtered`,
  `numbered-rows-reset-keeps-itinerary`, `numbered-rows-move-wrong-row`,
  `numbered-rows-select-wrong-place`). `ordered` also reads names that share
  one line and places each name where it is rendered (`dialog-plain-lines`,
  `number-in-name-text`; `plain-details-library-order`,
  `plain-review-insertion-order`). `literal` accepts a label or byline in the
  same element (`reason-with-label`, `byline-replies`,
  `number-and-text-in-one`; `labelled-reason-markup`, `byline-markup-reply`).
  A letter or digit beside the name makes another name: "Note 1" is not found
  in "Note 10", nor North garden in "North gardeners' shed".
- Fixed: `itemAction` accepts a title shown in two rows when one button does
  the action, `itemActions` returns every such button for a scenario that may
  press any of them, and an action name may hold the title inside it ("Add
  Night lines to queue") (`shortlist-panel-lists-tools`,
  `title-inside-action-names`; `panel-rows-list-remove-does-nothing`,
  `inside-names-on-wrong-rows`).
- Fixed: a dialog opener given as a string matches "Review my day (2)", after
  the button named by the string alone (`other-wording`, `counted-names`;
  `counted-opener-review-insertion-order`).
- Fixed: `withinText` matches the text as rendered or as the page wrote it, so
  the queue oracle reads `Current` case-sensitively again
  (`uppercase-current-mark`; `current-mark-not-rendered`).

Still open in the shared helpers:

- `item`, `selectEntry`, `shown` and `absent` read a longer text only inside a
  semantic row (`article`, `li`, `tr` or the roles row, listitem and group). A
  page that writes "1. Old kiosk" in a paragraph or in a block without a role
  is still not read, and `absent` still passes there without having looked.
  A sentence outside the rows that names an item ("Current: Paper
  satellites", a status line) deliberately does not count as listing it; a
  scenario that must exclude every mention uses `unmentioned`, which reads
  any element.
- When no row holds the bare name, a row that only mentions it in a longer
  text ("Conflicts with Sound walks") is taken for a row of that name.
- The longer-text match reads each text node alone and only the first place
  where the name occurs in it, is case-sensitive like the exact match, and
  knows only ASCII letters and digits as the continuation of a name. A name
  split over several elements is not found.
- `itemAction` still fails when two rows of one title both offer the same
  unnamed action; `selectEntry` still needs the exact title as the name of a
  control or one row for it.
- `assertText` and `comparedProduct` still read the rendered text only, so a
  case-sensitive pattern fails under a CSS capitalisation; the catalogue
  oracle keeps its case-insensitive size check for that reason.
- `choose` operates a select only when it is given the name of its group; the
  session board oracle keeps its own code for an unnamed select.
- Counts of the bare name that scenarios still make themselves: the
  renderings of a session title on the session board page and the cleared
  detail area of the pocket guide.

Correct pages still rejected:

- `thread-replies-literal-text`: several author buttons in one thread, the
  author as a link, a followed state not named "Unfollow…".
- `review-reason-and-undo`: filters built as a select; a count further than
  twelve characters from its status word; other names for Resolve, Undo
  resolution or Clear filters.
- `map-list-selection-filter`: map pins that are links; a legend with every
  place name inside the map region.
- `queue-order-and-active-item`: Current stated only in a line outside the row.
- `variant-basket-totals`: the cable option as a select or a pressed button.
- `catalog-compare-price-order`: a compare dialog built from non-semantic
  blocks.
- `itinerary-order-map-path`: a route shown only by restyling segments that
  were already drawn.
- `object-selection-edit-history`, `layer-order-visibility-history`: notes and
  objects that are not buttons inside the artboard or poster region.
- `room-wizard-validation`: choices offered as plain buttons that expose no
  state cannot be read, so the time-required and time-preserved checks are
  skipped for such a page.

Still not verified:

- `settings-draft-commit`: a page that validates without reporting anything;
  which rendered line is the error; the order of before and after in the
  review dialog.
- `workshop-journey`: "full readable descriptions"; whether the day choices
  are native radios.
- `tool-shortlist-limits`: the reason and empty-state checks rely on English
  wording, and the count must be a digit or a number word.
- `review-reason-and-undo`: when the count is not in the filter control, an
  unrelated number near the status word can satisfy the count check.
- `catalog-compare-price-order`: side-by-side geometry; a selection count
  written in words.
- `variant-basket-totals`: quantity zero or a fraction.
- `schedule-conflicts`: saved choices under the Morning filter.
- `itinerary-order-map-path`: numbers and names are read only inside the map
  drawing; row numbers produced by a CSS counter cannot be read back; the path
  check is lenient when a skipped stop lies on the line between two others.
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
a task-owned pipe-echo process representing an already running engine. Its
cases (31 on November 11, 2026; the binary prints its own total) cover Qwen
mode and memory-mode mismatches, throttled power, DSpark and hot-list requests
for a llama.cpp model, a missing model, 27B projector or DSpark drafter file, a
checkout whose receipt names another engine or none, and incompatible forced
SSD settings, including Laguna and remote runtimes. There is no missing-PLE
case. Each rejected
request must leave that process responsive and keep configuration, credentials,
effective memory settings, task admission and pending steering unchanged.
The HTTP Design gate also checks a real child build failure **after** admission.
Neither test loads weights: these rejections do not qualify the supported Qwen
modes. Real Qwen3.8 Agent/Cowork workflows have a separate gate below.

`make test-agent-spawn` injects failures into the production launcher's three
pipe allocations and fork, for both Agent and Cowork and for both launch paths
(Qwen3.8 in ds4 itself, Qwen3.6 through the llama.cpp tools frontend). All
sixteen cases must release the prepared charter and every opened descriptor
without publishing a child. The prepared executable and checkpoint are
fixtures; no model or child process starts. This macOS-specific gate is
included in `check-fast` on macOS.

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
