# Reproducible browser helper patch

[browser.patch](browser.patch) replaces the three ordered CDP, direct-navigation
and page-pixel edit stacks. The derived `ds4_web.c` is byte-identical to their
pre-migration output on every base in [bases.json](bases.json): current and
previous main, Laguna, Qwen3.8 and Qwen3.6. The five pinned source files are
identical; one complete delta covers them without model-name heuristics.

The host patches a private source copy. Original checkout files are never
modified by this adaptation. Complete exact context is required: a marker,
partial integration or approximate match is not accepted as a successful patch.
Unrelated edits outside the hunks are preserved. Repeated preparation from the
same original produces the same output; applying to a patched input is rejected.

The existing behavior remains: bounded CDP retries and HTTP tab fallback, direct
navigation, interrupt checks, aggregate fragmented-message bounds, and an optional
1024×768 image/chart viewport from the same owned tab as the extracted text.
Text-only requests do not capture pixels. Screenshots do not establish that a
model interpreted the page correctly or that the whole page was inspected.

## Verification

`make test-runtime-patch-migration` compares production output with frozen legacy
hashes and independent Git apply/reversal, including drift, partial/repeated
application, CRLF and unrelated edits. It requires the local pinned Git objects
or exact base sources; it downloads nothing implicitly.

`make test-web-visual-browser` compiles each of the four actual engine source
trees and runs isolated headless Chrome. It checks decoded JPEG colors, retained
text, text-only behavior, below-the-fold capture, message bounds and exact tab
cleanup. `make test-web-visual-unit` covers the host's same-page output adapter.
These tests use no model weights. macOS execution is not Windows/Linux/browser
or model-quality qualification.
