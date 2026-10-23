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
text layers, or understanding of diagrams. A matching citation verifies the
quotation, not the answer's reasoning. No universal correctness or speed
multiplier is claimed.

## Scanned pages (local OCR)

A page whose text layer has fewer than 24 visible characters is read with
`dstudio-ocr` ([source](../src/ocr/dstudio_ocr.m)) when it is available: the
page is rendered with PDFKit at 300 dpi and recognized with Apple's Vision
framework (accurate level, language correction, automatic language detection).
Nothing leaves the machine. The reader then treats the recognized text like a
text layer, but labels the page `(OCR: testo riconosciuto dall'immagine, può
contenere errori)` and adds a note to the reply. The JSON result reports
`ocrPages`, `ocrNewPages`, `ocrPendingPages`, `ocrFailedPages`, `ocrAvailable`
and `ocrEngine`.

- Bounded work: at most 64 new pages per read, in page order inside the
  requested range. Recognized pages are cached per document and engine (the
  helper and macOS versions are part of the key), so the next read continues
  where the previous one stopped. A read with pages still pending is not stored
  in the result cache.
- No time limit; the helper exits when the reader that started it is gone,
  including a reader that exited before the helper started (the helper then
  reads nothing).
- Evidence: a quotation on a scanned page is searched in the page's OCR lines.
  A unique match returns `ocr_matched` with whole-line boxes. Calculations
  accept only `matched` (an exact text-layer passage), never OCR text.
- The semantic index is keyed on the text it embeds, including OCR text.
- Native vision models (DeepSeek Vision-Exp, GLM 5.3) still receive the
  rendered scanned pages; OCR adds text, it does not replace the pixels.
- Not available on Linux and Windows builds: scanned pages are reported as
  unread there, as before.

Vision's confidence is not a reliable error signal: on a generated test scan
it read "Applied" as "AppLiea" at confidence 1.0. Treat OCR figures and names
as readings to check.

## Verification

Run `make test-pdf-complete` with Poppler, Node, Playwright and WebKit installed
(on macOS it also runs `make test-pdf-ocr`).
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
