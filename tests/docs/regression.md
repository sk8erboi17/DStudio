# Downloads, native regression gates, documents and LAN

[All test guides](../README.md). Run commands from the repository root.
Each section retains its original scope, prerequisites, results and limitations;
a historical pass is not a pass on a newer runtime.

## Local regression suite

### DeepSeek V4.1 HTTP download and resume

`make test-ds41-1017-download` executes the production shell downloader and real
curl against a threaded loopback HTTP server with tiny independently hashed
payloads. It checks all three pinned targets, adoption of the largest matching
HF partial without copying, exact range resume after a broken connection and
Stop, exclusive per-file ownership, ignored Range rejection, size/SHA failures,
preservation of existing files, linked/oversized partial rejection, token
delivery and root CLI routing. It transfers no model weights and qualifies
neither real inference nor full-size download completion. Receipts, including
failed runs, remain under `tests/.artifacts/ds41-1017-download/`.

The November 4 14-case run passed. A separate real 1017 Q2 transfer completed
at the pinned 365,713,686,528 bytes and passed SHA-256; it validates that
download's integrity, not inference or vision. Earlier failed fixture runs are
retained. See [the reconciliation and evidence scope](../../docs/changes/2026-11-04.md).

### Automatic matching vision downloads (host fixtures)

After building `./dstudio`, run:

```sh
node tests/unit/ds41_model_test.mjs
node tests/integration/model_vision_companion_host_test.mjs ./dstudio
```

The UI unit cases execute the production model/download helpers. The host test
runs isolated HTTP, process groups and tiny fixture download scripts on macOS;
it checks correct V4.1/GLM pairing, existing encoders, text/support exclusions,
failed model downloads and Stop during either phase. Receipts remain under
`tests/.artifacts/model-vision-companion-host/`. These checks run no real
weights or inference and do not qualify a model or Windows downloads.

### DeepSeek V4.1 vision sidecar pairing (real engine, no weights)

```sh
make test-v41-vision-pairing        # patch lifecycle on copies of the pinned ds4.c
make test-v41-vision-pairing-live   # macOS; network for headers only
```

The live check builds the `ds4` CLI twice from the pinned engine with the
production runtime patch stack, without and with
`patch/ds4-v41-vision-pairing`. It fetches only the headers (metadata and
tensor table, about 5.8 MB per language model and 18 KB per sidecar) of the
original and 1017 V4.1 Q2 files and both sidecars at pinned revisions, caches
them under `tests/.artifacts/v41-vision-pairing-live/headers/`, and writes each
into a sparse file of the published size. `ds4 --inspect --vision` opens both
models and applies the pairing check before any weight is loaded. The pinned
engine accepts the 1017 Q2 with the original sidecar and refuses its own 1017
sidecar; the patched engine opens each Q2 only with its own sidecar and refuses
the two mixed pairs. Accepted pairs must print the V4.1 model summary. This
qualifies pairing admission only, not image inference or model quality.

### Laguna long-prompt prefill (patch, installer upgrade, real weights)

```sh
make test-laguna-prefill-chunk-patch     # copies of the bundled Laguna engine; build and shader compile, no model
make test-laguna-prefill-chunk-upgrade   # the Chat launch step on a pre-patch Laguna checkout; real make, no model
make test-laguna-prefill-chunk-live      # real Laguna Q4_K_M on Metal; LAGUNA_MODEL=/path/to.gguf
```

The lifecycle test applies `patch/ds4-laguna-prefill-chunk` to copies of
`src/engines/ds4-laguna-s21` (never the snapshot or an installed checkout):
check, apply, repeat apply, restore to exact bytes, drift in the Laguna graph
and in the attention kernels and partial or edited patches refused with no
file changed, unrelated local edits preserved, ds4 main skipped, and
composition after the managed runtime patch stack. It then builds the patched
`ds4-server` and `ds4`, checks the help text, compiles the whole patched Metal
library offline as ds4 assembles it at startup (`tests/support/
ds4_metal_library.mjs`; reported NOT RUN without a Metal compiler), links a
`DS4_TEST_HOOKS` build of the patched `ds4.c` and executes the engine's own
batch resolver (Metal default 4096, other backends 16384, `--prefill-chunk`
before `DS4_METAL_PREFILL_CHUNK`, 16-16384 accepted, anything else refused),
and checks that applying or restoring the patch makes the built binaries
stale for `make`. It loads no model and does no GPU work.

The upgrade test runs the production `setup_ensure_server_metrics_runtime()`
(the step every Chat launch and, since November 11, every local harness launch
takes) on a copy of the bundled engine whose `ds4-server` was built before the
patch: the patch is applied and the server rebuilt, a ready server is kept on
the next launch, and a pre-patch server copied back newer than its sources is
still detected from its contents and rebuilt (`make -B`).

The live script builds the unpatched (baseline) and the patched engine in a
new `tests/.artifacts/laguna-prefill-chunk/run-*` directory, refuses to start
beside another engine (`tests/support/heavy_preflight.mjs`), and runs the
`ds4` CLI one process at a time under a pseudo-terminal (so prefill commits
one Metal command buffer per layer, as ds4-server does), each engine from its
own directory (ds4 reads its Metal sources there). On a ~12,000-token prompt
every vocabulary logit of the patched engine (batch 16384 once, default 4096
twice) must equal the baseline's, which must reproduce itself; the greedy
continuation (top-20 ids, order and logits per step) must be identical
between patched 16384 and default 4096 and between two default runs. The
baseline's continuation is recorded but not judged, because its ring commit
races. Then ~40,000-token (ctx 49152) and ~60,000-token (ctx 65536) needle
prompts must complete with the default, without the Metal watchdog error; the
needle answer is reported separately.

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

`make test-glm53-m2max-patch` also exercises fresh apply/restore on a copy of
the bundled main sources, with dry checks, repeat apply/restore, drift and
partial-state refusal and unrelated-edit preservation. It does not migrate an
installed legacy port: the previously shipped port (wrong batch-resource bound)
must be refused as drift by check, apply and restore without touching a file.
Native readiness and the PLD builder tests verify that Metal-only
source changes invalidate old binaries. Frontend behavior tests verify that a
generic prefill failure is no longer mislabeled as an out-of-memory diagnosis.

### Model-free checks

For an explicit real-embedding benchmark of every PDF in a supplied directory,
see [PDF library benchmark](../../docs/PDF_LIBRARY_BENCHMARK.md). It retains private
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
See [the reading design and limits](../../docs/PDF_READING.md).

For PDF evidence, run `make test-pdf-evidence`, also with
`DSTUDIO_TEST_BROWSER=webkit`: each invocation runs one browser (installed
Chrome by default), and the target is explicit, not part of `check-fast`. It
also needs the local OCR helper `build/dstudio-ocr`: without it the scanned
fixture page stays OCR-pending, the host does not cache that description and
the test fails at its cache assertion before the browser starts. Until
November 11, 2026 the target did not build the helper and failed that way in a
clean worktree; the helper is now its prerequisite. This
uses real synthetic PDFs, the native HTTP
endpoint and Poppler to verify passage matching, render geometry and clickable
links. Its browser part does not open the app: it loads the app's stylesheet
and its `PdfEvidence` module into a blank page on the test host's origin, so
the app's boot code and Chat flow are not exercised here. Repeated labels
retain all distinct passages in a modal chooser; no
unattached source or ambiguous calculation is silently accepted. Choosing a
different page aborts the old request and a delayed reply cannot replace the
current image/highlights. Invalid/truncated metadata is hidden with an honest
warning. The full-app attachment browser test separately verifies streaming and
chat reload with repeated labels (simulated model answer, no inference).
The evidence suite also exercises collapsed source cards, keyboard expansion,
direct quotation-to-page navigation and narrow-screen wrapping in both themes;
the original quotation bytes still reach Poppler unchanged. Screenshots are in
`tests/.artifacts/pdf-evidence/`.

<a id="frozen-vision-corpus"></a>
**Frozen vision corpus (PDFs and images).** `tests/fixtures/vision_corpus/`
holds the public inputs that [PLAN.MD P4](../../PLAN.MD#p4) item 3 asks for,
frozen on November 11, 2026: 32 PDFs (80 pages) and 28 image items (36 PNG
files; four items are ordered sets of two to four images) with 282 questions,
5.6 MB in total. Everything is synthetic and fictional. The questions' expected
answers follow from the fixed data in `tests/support/vision_corpus_content.mjs`.
No model wrote, answered or checked any of it, so the corpus qualifies no model
yet: it is the input for the real answer checks of P4 item 4, which have not
run.

`manifest.json` (`dstudio.vision-corpus.v1`) is the authority. Per file it
records the size and SHA-256 (and the pixel size of a PNG). Per item it records
the language, the categories, and for a PDF the physical page count, the
image-only pages (`scannedPages`), the printed page labels where they differ
from the physical index (`pageLabels`), `/Rotate` (`pageRotations`) and how
the content appears when the page is displayed (`contentRotations`). Per
question it records the prompt, the expected result and the evidence:

- `expected.type` is `exact` (the answer states this value), `number` (within
  the absolute `tolerance`, zero when absent), `one-of` (any listed value),
  `all-of` (every listed value) or `unanswerable` (the answer says that the
  input does not contain it and gives no value). The grader is described
  [below](#vision-corpus-grader-and-run-loop).
- `evidence.fact` is the literal the answer rests on, on physical page
  `evidence.page` (or image `evidence.image` of a set). `pixelOnly: false`
  means it is in that page's text layer. `pixelOnly: true` means it is drawn
  only: on an image-only page, or in a picture placed on a page that also has
  text. `also` lists further facts of the same question, `visual` describes a
  property that is not a string (a colour, a count, a position), and an
  unanswerable question records what is `missing`.
- File names are opaque (`pdf/p24.pdf`, `images/s01-b.png`). Item ids such as
  `p24-scan-upside-down` describe the content: do not show them to a model.

| Coverage (items) | PDFs | Images |
| --- | --- | --- |
| English / Italian | 20 / 12 | 15 / 13 |
| Text layer on every page / image-only / mixed | 20 / 8 / 4 | — |
| Five or more pages, with physical-page and two-page questions | 7 | — |
| Charts / tables / diagrams (flowchart, floor plan, map) | 5 / 11 / 4 | 4 / 2 / 3 |
| Small text (7 pt on paper, 10 px in images) | 3 | 2 |
| Rotated (`/Rotate` 90 and 180; content shown at 90, 180 and 270) | 5 | 2 |
| Printed labels that differ from the physical index (iii, 47, 112, A-1) | 4 | — |
| UI screens / handwriting-style / stylised fonts / low contrast | — | 5 / 2 / 2 / 2 |
| Colour, shape, count and position / ordered sets | — | 6 / 4 |
| With a pixel-only fact | 22 | 28 |
| With an unanswerable question | 32 | 28 |

Questions by type: 100 `number`, 90 `exact`, 22 `one-of`, 10 `all-of` and 60
`unanswerable`. The PDFs carry 81 pixel-only facts and 67 text facts.

`make test-vision-corpus` (in `check-fast`; needs Poppler and the model-free
test host, no model, browser, OCR or network) runs
`tests/integration/vision_corpus_test.mjs`. It proves, on the committed files:

- every listed file exists with the recorded size and SHA-256, and no other
  file is present;
- every PDF goes through the production reader: `POST /api/pdf/describe` on
  `tests/.build/dstudio-server-test`, with `DSTUDIO_OCR_HELPER` pointing at a
  missing file so that only the text layer is read. The page count and the
  set of pages with a text layer must match the manifest;
- every pixel-only fact is absent from the reader's text of every page
  (case and whitespace normalised, and again with all spaces removed), from
  Poppler's own output and from the document information fields; every text
  fact is in the reader's text of its stated physical page;
- image-only pages have zero visible characters in `pdftotext`, and `/Rotate`
  matches `pdfinfo`;
- PNG files carry no metadata chunks;
- the coverage floors in `MINIMUMS` (`tests/support/vision_corpus.mjs`) hold:
  at least 30 PDFs, 20 images, 15 unanswerable questions and 12 PDFs with a
  pixel-only fact, a minimum per category, both languages, and a quarter turn
  and a half turn among the rotated items.

The same test damages private copies and requires a refusal for each: a
changed byte, a missing or unlisted file, a pixel-only fact that the page
carries as text (on a scanned page and next to a chart), a text fact on the
wrong page, a page recorded with the wrong kind, a wrong page count or
`/Rotate`, fewer than 30 PDFs, fewer than 20 images, fewer than 15 unanswerable
questions, a duplicated id, a single-question item and a missing category.
`node tests/support/vision_corpus.mjs` prints the counts of a corpus.

To regenerate, run `node tests/support/vision_corpus_build.mjs NEW_DIR`
(Playwright Chromium; macOS for the system fonts of the handwriting-style and
stylised images). It refuses a directory that is not empty. Native pages come
from `page.pdf()`; a scanned page is a page rasterised to JPEG and placed as
the only content of a PDF page; pixel-only facts and all images are SVG or HTML
rasterised to PNG. Two runs with Chromium 148.0.7778.96 on the same Mac gave
identical bytes. Another Chromium or font set will not, and then the hashes
change: replacing the committed corpus is a new freeze that needs
`make test-vision-corpus`, a look at the rendered pages and a note here.

What the corpus and its test do not establish:

- No vision checkpoint, encoder, projector or answer is qualified. Nothing has
  been shown to a model, and P4 items 1, 2 and 4 are untouched.
- "Pixel-only" is proven against the text layer. On macOS the reader also
  runs local OCR on pages with fewer than 24 visible characters, so facts on
  the 26 image-only pages can reach a model as labelled OCR text. The 37
  pixel-only facts in 11 PDFs that sit in a picture on a page with a text
  layer are never OCRed by the reader. A pixel-path run has to disable the
  helper or report the two groups separately (`scannedPages` tells them apart).
- The reader hands a native-vision model at most four rendered pages per read
  (image-only pages first, 1100 px on the long side). In a plain whole-document
  read, pixel-only facts of `p22`, `p26` and `p31` lie on pages outside that
  handoff; reaching them needs a page range or is an honest omission.
- The images are rendered scenes, not photographs, and the handwriting is a
  font. Printed page labels are printed text; no PDF has a `/PageLabels` entry.
- The absence proof covers extracted text and the information fields. The
  PDFs were generated untagged, without outline, form or XMP stream; the test
  does not look for such channels.

<a id="vision-corpus-grader-and-run-loop"></a>
**Vision corpus grader and run loop (model-free; the real runner is not
written).** `tests/support/vision_corpus_grader.mjs`
(`dstudio.vision-corpus-grader.v1`) grades one final answer against one
question. A grade is pass or fail plus a diagnostic class, never partial
credit. Its header states the exact rules. In short:

- `number`: exactly one candidate number equal to `value` within `tolerance`.
  `49,10` and `49.10` are the same number. `2.500` is read in the item's
  language. Numbers from the question and from the evidence operands are
  context, so "318 + 440 = 758" passes. "Alder 318, Birch 472 … together 758"
  fails as `value_among_others`.
- `exact`: case, whitespace, dashes, quotes and accents of the value are
  normalised. Times, dates, weekdays, months, colours, ordinals, shapes and
  compass points are compared by meaning in English and Italian, and another
  member of the same family is a competitor. A name or code given as one
  entry of a list of same-shaped guesses ("Marenka Dolvich, Petra Novak",
  "BR-6093, BR-6039") fails as `value_among_others`. "X or Y" fails as
  `hedged`.
- `one-of`: any listed value under the `exact` rule; the other listed values
  are synonyms.
- `all-of`: every listed value, with no competitor. `partial` when some are
  missing.
- `unanswerable`: the answer says, in English or Italian, that the input does
  not contain or show the thing. It passes as `honest_refusal`. It fails as
  `refused_then_guessed` when a guess follows, as `refused_but_value_asserted`
  when a clause affirms a value absent from the question and the known input,
  and as `no_refusal` otherwise.

`node tests/unit/vision_corpus_grader_test.mjs` (in `make test-vision-corpus`)
grades 217 authored answers, English and Italian. They cover accepted forms,
near-misses, hedged lists, hallucinated values and empty answers. On the
whole manifest it checks that an answer built from each `expected` passes all
282 questions, and that the answer to the next question with a different
expectation fails all 282. The answers are written by hand and prove nothing
about a model. Limit: a name elsewhere in a sentence, not listed beside the
value, is not detected as a competitor. The raw answer stays in every receipt.

`tests/support/vision_corpus_runner.mjs` is the run loop through the
production page. It attaches the item's files by their opaque names, asks the
question and reads the final answer from the persisted conversation. For each
question it records the `/v1/chat/completions` bodies the page sent (image
parts with SHA-256 matched to corpus files or rendered PDF pages, text-layer
versus OCR page blocks, any vision payload), the PDF reads and which sent
representation could carry the fact. It classifies `evidence_page_not_sent`
and `answerable-from-ocr`. Simulated only, `make test-vision-corpus-runner`
runs it against the real test host and its page in headless Chromium, with a
scripted engine behind the host's `/v1` relay and a status overlay as
launcher. Its single scenario passes 9/9 rows (Chat, `p01` and `i21`, authored
correct answers): the files are attached in order under their opaque names,
the image part is the corpus file byte for byte, the PDF fact travels in the
text layer, and no item id reaches the engine. It is unfinished and in no
broad gate. Not yet written: the real runner `tests/live/vision_corpus_live.mjs`;
the simulated scenarios for OCR on and off, `evidence_page_not_sent`,
hallucination, engine error, Stop, text-only isolation and vision → text →
vision; Agent, Cowork and Learn (their code paths have never run).

Run `node tests/browser/ui_model_picker_playwright_test.mjs` (also with
`DSTUDIO_TEST_BROWSER=webkit`) for the composer picker. This uses a simulated
launcher, not model inference. It checks the popup's actual distance from the
model button with a multiline draft, viewport bounds, keyboard/search behavior,
outside-click dismissal and light/dark layouts.

`make check-fast` runs local functional/browser/integration tests without a
large language model. `make test-cowork`, `make test-frontend-unit` and
`make test-pld` select narrower suites of it; `make test-pdf-evidence` and
`make test-pdf-complete` are separate explicit targets that `check-fast` does
not run. Stateful test
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
themes, and verifies that selecting a llama.cpp Qwen model sends one launch
request for that exact file, at full power with SSD streaming off, and no
checkout switch. The fixture lists a single main installation, so choosing
between engine checkouts is not exercised. Catalog delays/errors and
background download polling must preserve
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
18-case denominator. Since November 11, 2026 the same target also qualifies
the other seventeen scenario oracles on authored reference pages (see
[interaction oracle qualification](design.md#interaction-oracle-qualification));
native eighteen-project generation is not yet qualified; see
[Design systems](../../docs/DESIGN_SYSTEMS.md). No manual benchmark HTML repair.

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
Four more targets in `check-fast` run only test-support code, not the Design
runtime: `make test-design-controls` (the Chrome button probe of the live
Design quality runner, on an authored page with one inert button),
`make test-design-resume` (that runner's transcript-trimming and
resume-manifest helpers), `make test-design-disclosure` (its fictional-demo
disclosure grader, on authored HTML snippets) and `make test-design-release`
(the standalone Pages release-evidence script against a local server,
including a changed deployed asset). They qualify those helpers; a pass says
nothing about the app's Design controls, resume or release behavior, or about
a generated page.
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
script with an explicitly simulated compiler: 18 cases (the test requires
exactly that number) cover failed/incomplete
links, byte-bound freshness, compiler flags, untracked GPU/header changes,
complete/partial patches, concurrent Agent/Chat builds, parent/group death,
stale source rejection, directory replacement, symlink confinement and a
surrounding repository's Git identity that must not affect freshness. Failed
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
MAIN_DIR LAGUNA_DIR` (the test accepts main and, optionally, Laguna; a third
directory is refused, and Qwen3.8 uses main); add
`DSTUDIO_AGENT_BUILD_BACKEND=cpu` for CPU.
Each supplied checkout is copied into an isolated source fixture; weights are
not copied or loaded. Runtime tool frames are simulated in this gate.
See [Design systems and regression coverage](../../docs/DESIGN_SYSTEMS.md).
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

`make test-search-evidence` also covers whole-loop work budgets. Two of its
files check test-support code, not the app: `research_http_cancel_test.mjs`
exercises only the live-test harness's HTTP client
(`tests/support/real_harness.mjs`: an aborted request closes the real loopback
connection, an independent deadline is kept), and
`search_quality_grader_test.mjs` checks the live benchmark's fact grader. The
production pipeline's Stop during a blocked read is covered by
`research_entrypoints_test.mjs` below. Its model/page responses are simulated.
In contrast,
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
a blocked read cannot start a late writer. Source selection omits an application
output-token cap, allowing long URL lists and reasons to finish within the
engine's available budget; invented, duplicate and already-read URLs remain
excluded, and page-read/source-count budgets still apply. The HTTP regression
checks uncapped picker requests and long complete responses in both modes;
the research-progress browser test also verifies the actual UI request omits
the cap in WebKit and Chromium. The browser test also changes all four page/source
preferences through Settings → Web research, rejects invalid input, verifies
persistence after reload, and checks the resulting candidate and read counts.
`research_budget_test.mjs` exercises valid settings above and below the defaults,
invalid stored values, bounded admission and unchanged limits during a run.
The live harness loads the complete canonical
runtime; private helper-list omissions cannot change its behavior.
No quality scores, live inference deadlines or evaluation requirements change.

Focused regressions exercise URL-heavy page excerpts, overlapping windows,
Unicode offsets, preserved original language/length constraints, evidence-ID
selection and cancellation during synthesis. They run production functions
with synthetic source/model data, not real-model quality measurements.
`research_synthesis_runtime_test.mjs` streams long initial drafts and reviewed
repairs without an application output-token cap, retaining complete rejected
attempts and delivering the exact reviewed text. The research-progress browser
test checks that actual writer requests omit `max_tokens` in WebKit and Chromium.
Engine output limits, the 65,536 UTF-16 code-unit draft bound and Stop remain enforced.
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

The complete [pipeline report](../../extension/search/bench/PIPELINE.md) separates
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

See the [real-run report](../../docs/history/engine-acceptance-2026-09-05.md) for actual failures as well
as successes. Qwen native generation throughput is reported separately from
DStudio Chat latency and from the small cross-engine acceptance battery.


## LAN, sessions, OCR and Cowork limits (October 3, 2026)

These checks run real DStudio code. None of them loads model weights, unless
the entry says otherwise.

- `make test-http-lan` adds two tests. `http_lan_security_test.mjs` is
  described above. `http_lan_cowork_test.mjs` uses the real host and Cowork
  runtime with a simulated model, sending requests from the LAN address. It
  checks pairing (single-use code, five wrong attempts void it), token scope,
  the forced shared folder, prompts only (no commands, control frames or
  goals), pausing, revocation and restart. It needs a ds4 checkout with a
  built `ds4-cowork` (`LAN_COWORK_ENGINE`); without one it fails rather than
  passing.
- `make test-ui-lan-cowork` runs the production UI on both sides (host
  Settings, device LAN shell) in Chromium and WebKit, with the same real host,
  Cowork runtime and simulated model. It is a shorter flow than the HTTP test:
  the host shares its running Cowork folder and shows a code, the device is
  refused one wrong code, pairs, sends a prompt and reads the answer, and the
  host lists the device and revokes it (the revoked token is then refused).
  Single-use codes, the five-attempt limit, token scope, command refusal, the
  forced upload folder, pausing and restart are checked only by the HTTP test.
  It needs the same built `ds4-cowork`. On November 11, 2026 it failed in
  Chromium before its first step (in a clean worktree and in the main
  checkout): a System check dialog intercepted the Settings click. The cause
  was two product defects. The page's automatic Chat recovery treated the
  missing Chat engine beside a running Cowork session as a crash, started Chat
  (which stops the session) and opened the System check when that failed. And
  the host's `/v1` proxy retried its engine connection for about 2.5 s on the
  control loop, so the page's status reads timed out and it never learned
  that Cowork was running. Both are corrected (see
  [runtime control](runtime-control.md) and the recovery test below); the test
  now passes in Chromium and WebKit, closing no System check, and closes one
  only if the environment raises it (the receipt counts them).
- `node tests/browser/ui_recovery_keeps_session_playwright_test.mjs`
  (`make test-ui-recovery-session`, Chromium and WebKit, in `check-fast`)
  loads the production page beside a simulated host. A barrier holds every
  status reply until the Chat probe has failed. It requires that no start
  request is sent while the host runs Agent, Cowork or Design; that Chat is
  still started when nothing runs; that dropped status reads are retried and
  the running session is then shown; and that a host which never reports its
  state gets no start request, only the System check. The unfixed page sent a
  start request in all three running cases.
- `make test-remote-session` runs the real Agent, Cowork and Design runtimes in
  remote-model (llama.cpp/MLX) mode across a process restart. The restored
  conversation must be resent byte for byte. An old tool-call ID must not run
  again. A damaged session file must restore nothing.
- `make test-cowork-runtime-args` sends every `write_document` argument through
  the real runtime with structured and DSML tool calls. It retains the
  regression where `final_newline` was dropped.
- `make test-cowork-tools-unit` (in `check-fast`) runs the filter that removes
  the refused shell tools from Cowork's tool prompt, on both upstream schema
  formats. `make test-cowork-tool-prompt` checks the tools the real runtimes
  declare, with simulated model frames. Cowork's DSML prompt and structured
  list must not offer `bash`, `bash_status` or `bash_stop`; Agent's prompt
  still does. A Cowork `bash` call must still be refused. Against runtime v105
  it fails on the DSML prompt (`run-0UTqUI`, retained).
- `make test-pdf-ocr` (macOS) runs the real reader and Vision OCR on generated
  scans. It checks labels, the cache, the per-read bound, a missing helper,
  OCR-line citations and that the helper stops when its reader is gone. That
  includes a reader that exited before the helper started. An earlier
  helper missed that case and kept reading under load; the check fails on it.
- `make test-document-table-scale` builds a 5,000 × 20 table from 512 synthetic
  sources and records timings. `tests/unit/document_table_test.py` covers the
  extraction cache, the bounds, large XLSX sources, split exports and
  cancellation.
- Real weights: `make test-real-cowork-resume` stops a
  Cowork turn after a tool has returned and then resumes it. It also restarts
  the runtime, restores the saved session and grades the follow-up. Receipts
  stay in `tests/.artifacts/cowork-quality-real/run-*`.
- Real weights, long profile (`make test-real-cowork-long`, DeepSeek V4 Flash
  Vision-Exp IQ2XXS, 393,216-token context, Max thinking; October 4):
  `run-AFmGNa` passed the first 10 cases. `ambiguous-edit` failed: after
  inspecting the files the model reasoned in a loop for over 25,000 tokens
  until the one-hour turn limit. That run then stopped, because a still-running
  turn blocked the next case; the test now stops a timed-out turn and starts
  the runtime again. The second sample (`run-d1MriS`) was interrupted on
  request and is not graded. Five cases remain not run.
