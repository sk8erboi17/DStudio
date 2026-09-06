# DStudio originals

Five original visual systems replace the downloaded design catalog. They ship
with the repository and macOS/Windows support bundle, without a first-run
design download. Runtime/model dependencies retain their required notices.

| System | Composition | Starting point |
|---|---|---|
| Folio | Issue rail, expressive serif, reading column and marginal index | Publications, research |
| Signal | Compact navigation, operational rows, tabular readings | Tools, operations, data |
| Forma | Large sans statement, unequal project areas, structural whitespace | Portfolios, showcases |
| Grove | Humanist type, welcome beside one focused action | Services, learning, onboarding |
| Pulse | Condensed poster type, hard rules, practical timetable | Cultural programmes, events |

These are visual vocabularies, not universal page templates. Task and audience
determine hierarchy, typography and interaction. Explicit user choices win.

## What the agent receives

Each `extension/design-systems/<id>/` contains:

- `DESIGN.md`: direction, adaptation rules, states and acceptance checks.
- `tokens.css`: coordinated light/dark roles and offline component primitives.
- `components.html`: original composition and interactive component view.
- `assets/preview.js`: local interactions, no network or persistence.
- `references/recipes.md`: composition, reflow, state and export guidance.

The native design_system tool lists these files; pack_file actually reads the
root CSS/HTML. Previously those paths were rejected despite instructions to use
them. Generated projects must copy their dependencies into their own workspace,
not rely on DStudio API URLs. The lab toolbar and fictional sample identity do
not belong in client deliverables.

The agent writes a short design-plan.md covering audience, primary action,
content priority, typography, topology, mobile reflow and interaction states.
This is guidance, not proof of good output.

A complete brief can start a planned build without an obligatory questionnaire
or an English skip phrase. Missing consequential decisions still warrant a
question; an actual question pauses the tool batch before later file changes.
The work-card prerequisite and artifact verification remain enforced.

Substantial projects can use local linked HTML/CSS/JS instead of one oversized
inline write. An incomplete tool batch never executes any of its calls and does
not undo earlier completed rounds. The agent receives a concrete recovery steer:
inspect saved files, retry smaller complete calls and preserve all requested
behavior. This does not raise generation limits or save truncated source.

The local loop also distinguishes a genuine EOS from exhaustion while still
drafting prose, including before the first todo. It can continue such a response
at most three times per user turn, with the same per-round token limit. Context
space for the continuation is checked explicitly. Exhausting that recovery bound
is recorded as incomplete, not successful delivery. This fixes the silent stop
exposed by the real workshop development run; its targeted replay is documented
separately from the initial comparison.

Source lint reads the entry's directly linked local CSS/JS as well as inline
styles/scripts. A source-only spelling change therefore does not hide focus or
motion rules, or produce warnings merely because `:root`/media queries live in
another file. A naturally reflowing page is judged by its rendered layout, not
by the presence of a media query. Dependency lint is bounded to 4 MiB and rejects
out-of-project paths; skipped/oversized inputs are explicitly unverified.
Nested imports and actual behavior still need browser/interaction checks: this
is not a complete CSS cascade or JavaScript analysis.

Text-only runtimes also tell the agent that pixel inspection is unavailable,
while `inspect_layout` and the deterministic render checks remain usable. This
prevents an instruction to repeatedly call an unavailable vision tool from
masquerading as visual verification. It does not turn geometry into perception.

## Quality without stylistic uniformity

The blanket hard failure for sans display fonts is removed: a valid Arial or
system-ui heading is not a defect by itself. Arbitrary two-line heroes,
accent percentages and section quotas no longer override the brief.
Counting CSS references to an accent or repeated hex values is no longer an
aesthetic warning either: neither measures painted area, contrast or hierarchy.
The live old-agent run exposed unnecessary extra inspection after this warning.
Color craft and the main prompt now agree with that policy: no fixed neutral/
accent percentages or blanket display-font blacklist. The scale and typography
roles come from the brief and the selected system. Accessibility guidance is a
practical baseline, not a claim of certification or legal compliance.

Exact-copy checking permits inline emphasis and spans within the requested
phrase. Useful typography must not be removed solely to satisfy a raw substring
search. Hidden copies, changed wording/spacing and fragments assembled across
separate sections or controls remain invalid. The native source check is bounded;
it is not a complete browser text/visibility engine.

Native verify_artifact and artifact now measure 1280/768/390px layouts even on
text-only models. Page overflow, control overlap and media distortion are P0
failures; missing rendering evidence is also a failure. Geometry is refreshed
even after CSS-only changes. The existing vision assessment remains separate.

Geometry is not an aesthetic score. A model's own critique is not an independent
quality benchmark. Real comparisons must operate the resulting interfaces.
See the [real-agent development experiment](DESIGN_AGENT_EXPERIMENT.md) for
observed output defects, regression derivation and comparison status.

A separate P1 readability warning now measures long paragraphs confined below
12em into at least six rendered lines. It reports actual selectors, font sizes,
widths and the containing grid/flex layout through inspect_layout. Short labels,
hidden content and explicit verse line breaks are excluded. This is an inspection
cue, not a blanket aesthetic veto or a required universal column width.

Rendered inspection also lists visible fragment links without a DOM destination.
Missing ordinary anchors produce a P1 warning with selectors/hrefs available in
`inspect_layout`. Valid named anchors, encoded IDs, top links and text fragments
are accepted, including destinations created by JavaScript. This is not a hash
router or full-navigation test: intentionally scripted routes require actual
interaction checks, not an automatic rejection based on an absent element ID.

## Migration

Catalog, preview endpoint, bootstrap listing and native pack loader expose only
the originals, even if an older installation retains imported directories.
An old saved style is cleared with a visible notice when the gallery loads;
an explicit API request for a retired style returns an error.
User skills, model weights, engine paths and existing projects are preserved.

POST /api/setup/content remains a compatibility check: complete bundled assets
succeed immediately; missing files return an actionable 409. It never downloads
a historical catalog or overwrites user files.

## Verification

- `make test-design-originals`: actual native catalog and incomplete-bundle
  behavior; Chromium/WebKit at 320/390/768/1440px, both palettes, search, form
  validation, dialogs and focus return, computed solid-color text contrast and
  200% text-only resizing. The same packs also run inside the app's opaque
  `allow-scripts allow-forms` iframe sandbox in both browser engines. No external
  requests. **No inference and not a comprehensive accessibility certification.**
- `make test-design-self`: real pack dispatcher, returned CSS/HTML bytes,
  retired-id rejection, real Chrome overflow/CSS-only repair without a vision
  model, valid sans typography, cramped-prose measurements, truncated-batch file
  preservation, inline/linked source-lint equivalence and the existing runtime
  regressions. The local-source checks include missing files, comments that
  contain example URLs, symlink escapes, oversized files and non-file inputs.
  A real-browser navigation regression covers missing fragment destinations and
  a JavaScript-only repair, while preserving valid fragment forms.
- `make test-design-tool-recovery`: the actual native agent loop receives
  deliberately truncated **simulated model frames**, preserves earlier writes
  and completes smaller retries with exact expected file bytes. No inference.
- `make test-design-archive-build`: a real build and executable startup from a
  local source archive without engine Git metadata, including isolation from a
  surrounding project's Git identity and invalidation after source edits. No
  model or network; this is not the fresh-network installation test.
- `node tests/browser/ui_agent_design_playwright_test.mjs`: app gallery,
  retired selection migration and existing workflows. Engine/catalog responses
  are **simulated**, separately from the original-pack tests.
- `make test-macos-bundle`: isolated packaged app, actual bundled catalog and
  offline setup endpoint. No model inference.

Real inference comparisons are explicit and sequential:

    node tests/live/design_originals_comparison.mjs LABEL BINARY ENGINE_DIR EXTENSION_DIR NEW_OUTPUT_DIR [DESIGN_SOURCE]
    node tests/support/design_comparison_audit.mjs NEW_OUTPUT_DIR
    node tests/support/design_comparison_report.mjs BEFORE_DIR AFTER_DIR NEW_OUTPUT_DIR

The report rejects partial or incompatible comparisons and distinguishes actual
delivery from the behavior of a partial page. `make test-design-comparison-report`
tests this accounting with synthetic receipts, not simulated claims of model
quality. Visual review of generated outputs remains a separate requirement.

The runner loads existing DeepSeek V4 Flash Chat IQ2XXS weights with Metal, fully
resident weights, 32k context, identical sampling/seed and three frozen briefs in
tests/fixtures/design_agent_originals.json. Before/after use captured binaries
linked to the same main engine revision, and separate original/retired pack trees;
never give both variants the new packs. Pass the captured old Design source for
the before receipt, rather than hashing the current source for both binaries.
Archive-based engine identities come from their source receipt, not a parent
DStudio Git checkout. An earlier Qwen attempt was interrupted without a delivered
artifact and is not quality evidence; the supported native Design path uses DS4.
Raw errors, timeouts, generated files and binary/model identity are retained.
A missing artifact is not a pass, even if partial HTML looks attractive.

## Defects found by the original-pack tests

- Enlarged mobile text could force a grid past the viewport. Shrinkable children,
  wrapping and responsive day choices now preserve content instead of clipping it.
- WebKit blocked relative CSS/JS inside the opaque preview iframe: its CSP `self`
  did not match the sandbox origin. Original-pack responses now name that pack's
  explicit resource URLs. The sandbox remains unchanged; no CDN scripts or remote
  design assets are enabled by this fix.
- The first real old-agent archive passed search/dialog and page-overflow checks,
  but its third paragraph occupied a 96px column at 1440px (17px type, 13 lines).
  A grid `order` change had put the prose in the number rail; on mobile its button
  also appeared before the title. A native real-browser regression now exercises
  cramped prose plus CSS-only repair. The comparison outputs themselves remain
  untouched; working controls alone are not counted as good composition.

Generated evidence and the recoverable retired-catalog snapshot stay under
ignored tests/.artifacts/. Do not publish claims of measured aesthetic
improvement until the actual before/after outputs have been reviewed.

Latest original-pack receipt: `tests/.artifacts/design-originals-g514nT/`:
32 aggregate checks passed, 40 screenshots, 2610 computed text-color pairs
across both engines/themes and example/component/dialog views. Desktop/light
and mobile/dark compositions were visually inspected; this is a local preview
review, not a score for the model. The app UI test (simulated engine/catalog),
build-freshness test and isolated signed macOS bundle smoke also passed.
Archive compilation/freshness passed (`tests/.artifacts/design-archive-build-20260905.log`).
Native interruption checks passed
(`tests/.artifacts/design-runtime-20260905-linked-final.log`).
Earlier native self-test and truncated-frame recovery passed
(`tests/.artifacts/design-navigation-regression-final-20260905.log`,
`tests/.artifacts/design-tool-recovery-78TRJz/`). The rebuilt isolated bundle
passed (`tests/.artifacts/design-navigation-bundle-20260905.log`).

After the generation-limit fix, the native self-test and report-accounting tests
passed (`tests/.artifacts/design-generation-limit-regression-20260905.log`),
followed by remote-frame recovery and the rebuilt isolated bundle
(`tests/.artifacts/design-generation-limit-bundle-20260905.log`). The explicit
EOS/continuation decision tests do not replace the targeted real-model replay.

`tests/live/design_generation_limit_test.mjs` provides a separate explicit
real-weight fault-injection check with a one-token per-round allowance. It tests
the native cutoff/retry/terminal boundary, not the quality of a deliberately
unfinished response. It must run sequentially, never alongside another model.

## Final verification — September 6, 2026

- `make test-design-runtime` passed, including the inline-heading regressions,
  native rendered checks, truncated-frame recovery, original packs, interruption
  and resume: `tests/.artifacts/design-final-runtime-20260906.log`.
- The app gallery test passed with simulated engine/catalog responses:
  `tests/.artifacts/design-final-ui-20260906.log`.
- The rebuilt, signed macOS bundle passed its isolated startup, actual catalog
  and offline content check: `tests/.artifacts/design-final-bundle-20260906.log`.
  Its Design source hash and all 25 original-pack files match the working tree.
  The user's open app was not restarted. Windows packaging includes the packs,
  but no Windows execution was performed on this Mac.
- The explicit real-weight cutoff test passed in
  `tests/.artifacts/design-generation-limit-live-OYRmV8/`. The captured old binary
  reproduces the silent-success bug in `design-generation-limit-live-n0LDQq/`.
  The first corrected-binary receipt (`design-generation-limit-live-BTfzdq/`)
  is retained as failed: its recovery/status checks succeeded, but the test
  incorrectly treated runtime-generated `MEMORY.MD` as model-created content.
  The final test explicitly checks that summary's idle/no-artifact state and
  still requires exact preservation of the preexisting file and no tool calls.

Final native Design source SHA-256:
`87acb241eb2f7ca4aecf2a7eb407a6ed6c37930475801081c315d1813e4e2bd9`.
These passing regression checks do not erase the mixed initial real-agent
comparison. The workshop-only replay and its limitations are documented in
[the experiment](DESIGN_AGENT_EXPERIMENT.md).
