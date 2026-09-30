# Reproducible browser helper patch

For antirez/ds4 main `0aaea5a238fb41a35106a551e73c8409dfb751ac` (and the
identical `ds4_web.c` at the Qwen merge `9139e2a`),
[browser-main.patch](browser-main.patch) retains DStudio's aggregate message
bound and visual evidence while using upstream's GET `/json/list`, PUT
`/json/new` recovery and last-page retention. It does not install a duplicate
target-creation loop. Exact new-source/output hashes and a distinct oracle are
recorded in [bases.json](bases.json); no old byte-parity result is relabeled.

[browser.patch](browser.patch) replaces the three ordered CDP, direct-navigation
and page-pixel edit stacks. The derived `ds4_web.c` is byte-identical to their
pre-migration output on the historical bases in [bases.json](bases.json): older
main, Laguna, Qwen3.8 and Qwen3.6. Those five pinned source files are
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

`make test-web-visual-browser` compiles the three active ds4-family source trees
and runs isolated headless Chrome. `DSTUDIO_WEB_VISUAL_TREES` can also include
the archived Qwen fork for historical coverage. It checks decoded JPEG colors, retained
text, text-only behavior, below-the-fold capture, message bounds and exact tab
cleanup. `make test-web-visual-unit` covers the host's same-page output adapter.
These tests use no model weights. macOS execution is not Windows/Linux/browser
or model-quality qualification.
