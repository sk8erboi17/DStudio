# Faster PDF reading without dropping evidence

Previously, even a short PDF required a separate language-model request to
decide which pages to read. A specific question could also trigger embedding
and indexing, even when the entire document fitted the attachment budget.

The new path first extracts the text locally. If the complete document fits,
it goes straight to the answer: every physical page and every extracted byte
is retained. It does not summarize the source or replace numbers with a model's
transcription. Source identity and the Poppler citation/highlight viewer are
unchanged. There is no new setting to enable.

This removes the planning inference and any unnecessary retrieval/index build
for eligible attachments in Chat, Learn/Tutor and Cowork preparation. It does
not change the engine's token speed or the Cowork `read_pdf` tool protocol.

## Correctness boundaries

- The complete request uses the existing text budget: 20 KiB locally, 24 KiB
  for LAN, 48 KiB for cloud. It also reserves space for physical-page delimiters.
- Every page must have a usable extracted text layer; sparse, scanned,
  extraction-failed and over-budget documents require the existing planner.
  No incomplete result can be accepted as a successful complete read.
- At most 48 text pages are eligible. With native vision selected, every page
  must also be returned as an image, within the existing four-page limit.
  Images are not removed merely because the PDF contains embedded text.
- A rejected probe keeps the original bytes for the planned read and reuses
  the text extraction cache. Mixed uploads plan only the remaining documents.
- The model still receives the user's request. Supplying all pages does not
  authorize answering outside a requested page range.
- The regular overview path also preserves all selected text when it fits.
  Previously, independent per-page quotas could leave room unused on a short
  cover while truncating a longer following page.
- Reader cache keys are versioned to invalidate old, unnecessarily truncated
  responses. Changed document bytes retain a different source identity.

Complete *extraction* is not proof of correct interpretation, correct hidden PDF
text layers, or understanding of diagrams. Text-only models still cannot read
image-only evidence. A matching citation verifies the quotation, not the
answer's reasoning. No universal correctness or speed multiplier is claimed.

## Verification

Run `make test-pdf-complete` with Poppler, Node, Playwright and WebKit installed.
The test executes the native HTTP reader and production attachment functions:

- complete output equals independent Poppler extraction byte for byte, page
  by page, including decimals, accented text and evidence late in the document;
- a short cover plus a longer page retains all text in both complete/overview;
- changed bytes and cached rereads preserve identity and content correctly;
- scans, sparse pages, over-budget text and five-page native-vision requests
  cannot silently take the complete path;
- two-page native-vision input retains both actual rendered images;
- mixed uploads plan only the oversized PDF; an older-host incomplete reply
  preserves bytes and falls back;
- the full headless Chat UI uploads an actual PDF, makes one answer request
  with no planning request, hides internal source JSON, and opens the real
  highlighted quotation on physical page 2.

Only the browser test's engine status and answer are simulated. PDF extraction,
retained source identity, citation matching and rendering are real. The test
does not load or download models. Evidence and failed attempts remain in
ignored `tests/.artifacts/pdf-complete-*` directories.

`make test-pdf-evidence` separately verifies matching, repeated citation labels,
rotation/crop geometry, cache restoration and the viewer. Actual model latency
and answer accuracy need a separate real-inference comparison before publishing
an end-to-end speed claim.
