# Benchmark a local PDF library

This opt-in benchmark reads every PDF in an explicitly supplied directory and
tests DStudio's actual hybrid retrieval with independently prepared questions.
It does not launch a generative model, test an LLM's answers, or search a shared
cross-document index. Original PDFs are read-only. Raw text and results are
private output, not fixtures to commit.

## Published initial library run — September 5, 2026

**78 PDFs, 42,572 pages, 84 questions**, tested with real
Qwen3-Embedding-0.6B Q8_0 on llama.cpp/Metal (llama-b10034), Apple M2 Max with
96 GiB RAM. The reader binary SHA-256 and embedding binary SHA-256 are retained
in the [public aggregate JSON](benchmarks/pdf-library-2026-09-05.json).
These are historical measurements of that reader, not a new run of every
subsequent PDF fix. All 78 original file hashes were rechecked unchanged.

- The expected physical page **and** quote were retrieved in **75/84 questions**.
  Four further cases had equivalent passages on other pages, confirmed manually;
  they remain failures of the original strict criterion.
- Poppler located a unique citation with coordinates in **50/75 attempts**.
  Finding the text is not enough to guarantee that it can be highlighted.
- First text extraction and preview took **117.58 seconds summed over 78 files**.
  No document fit the complete-text budget: these were partial previews, not
  proof that an LLM read and understood 42,572 pages.
- The three initial indexing/retrieval batches took **2 h 10 min 15 s** in total,
  including checks and repeated searches, excluding later diagnostic retries.

![PDF benchmark: 75 of 84 strict retrieval checks and 50 of 75 coordinate matches; medians for extraction, first indexing, ready-index search and cached queries are separate stages.](../assets/README%20images/benchmarks/pdf-library-quality-latency.png)

The first-index timing median uses 75 files. One transport timeout has no
successful first-index measurement; a subsequent overlapping worker and a
visual-only control are excluded from independent timing, not removed from
quality counts. The visual-only control is 0/1 (no OCR); text cases are 75/83.
Ready-index search has 70 samples because the early batch did not record that
measurement. Identical-query timing has 82 samples; one timed-out case and the
visual-only control are absent. Neither warm query sample is an independent
new set of quality questions. All sample counts and timing statistics are public.

The original PDFs, names, extracted text, questions, quotations and per-file
receipts remain private. Public aggregates reproduce the Matplotlib charts,
**not** an independent audit or rerun of this private corpus:

```sh
python3 tests/support/publish_benchmark_charts.py
python3 tests/unit/published_benchmark_charts_test.py
```

No generative model answers or source-viewer modal interactions were tested
in this library run. The separate behavioral viewer regressions remain necessary.

## Run

Requirements: built native test server, Node, Poppler, Python with matplotlib,
and an already downloaded Qwen3-Embedding-0.6B Q8_0 GGUF plus llama-server.
No models are downloaded. The default embedding binary is
`$HOME/.dstudio/llama-embed/llama-b10034/llama-server`;
`DSTUDIO_PDF_EMBED_BIN` can select another existing binary. Port 28101 must be
free; the benchmark refuses to adopt an unrelated embedding process.

```sh
make tests/.build/dstudio-server-test
node tests/live/pdf_library_benchmark.mjs inventory /absolute/path/to/pdfs
```

The command prints a new ignored `tests/.artifacts/pdf-library-*` directory.
Replace `RUN` below with that exact directory:

```sh
node tests/live/pdf_library_benchmark.mjs read RUN
DSTUDIO_PDF_EMBED_MODEL=/absolute/path/to/Qwen3-Embedding-0.6B-Q8_0.gguf \
  node tests/live/pdf_library_benchmark.mjs retrieval RUN
python3 tests/support/pdf_library_report.py RUN
```

Before retrieval, create `RUN/questions.json` from independent Poppler
extraction in `RUN/reference/`. Include at least one question per document;
select the physical PDF page containing the answer and an exact source
quotation. Write questions before looking at retrieval results. For example:

```json
{
  "cases": [
    {
      "id": "001-a",
      "document": "001",
      "page": 12,
      "question": "What mechanism prevents the two workers from writing at once?",
      "quote": "A mutex serializes access to the shared record."
    }
  ]
}
```

This is a schema example, not a real benchmark result. The runner rejects a
quotation absent from its reference page. For a page with no searchable text,
render and visually inspect it; set `groundTruth: "rendered-page"`,
`referenceImage` to its run-relative PNG, and `expectedLimitation` to the
extraction limitation. Such a case must remain in the denominator even when
text retrieval cannot find its answer.

An optional final argument such as `001-012` runs a bounded document batch.
Run batches sequentially, without overlapping IDs. The report refuses missing,
duplicate, unfinished, or post-hoc changed questions. Do not drop failures to
make aggregation pass. Each batch owns and stops only its private reader and
embedding processes; unrelated applications and models are not stopped.

## What the numbers mean

- Reference extraction: independent `pdfinfo` and `pdftotext`, page counts,
  sparse pages, original SHA-256 and source samples.
- First read: actual `/api/pdf/describe` complete probe, then a bounded overview
  if the file does not fit. The overview is not a complete reading of the book.
- Cold retrieval: actual dense embeddings plus BM25, indexing every text page
  in that PDF. Up to six pages are selected for the 20 KiB attachment budget.
- Identical query: cached response latency, not new semantic work.
- Index reuse: a prefixed version of the same question bypasses the response
  cache, verifies the existing text/vector indexes are reused, and measures a
  new search. It is not a second independent quality question.
- Correctness: separately score expected physical-page recall, source-quote
  recall and the real Poppler evidence endpoint. A retrieval hit is not proof
  of correct LLM reasoning or reliable highlighting.

The benchmark uses an explicit total HTTP timeout for slow indexing requests.
The initial September 5 batch used Node `fetch`, whose independent five-minute
header timeout could fire before its longer AbortSignal deadline. Those failed
attempts are retained. `retry RUN 039-040` runs a separate, clean-cache attempt
with the corrected transport, under a `retry-*` directory; it does not replace
the initial sample or silently change its score.
Transport failures now stop the owned batch before another heavy request can
overlap a still-running detached PDF worker. A partial batch remains incomplete,
not passing. Receipt updates use atomic renames for concurrent progress readers.

Cold means a new DStudio cache, **not** an empty macOS filesystem cache.
The `path` request avoids frontend upload overhead. The private server runs in
PDF-only test mode: extraction, inference for embeddings, retrieval and evidence
matching/coordinates are real; no answer-generation request is simulated or
claimed. The benchmark does not drive the source-viewer modal. Visual-only
reference pages are rendered separately with Poppler for ground-truth inspection.

The detailed report and per-document Matplotlib PNGs stay in the private run
directory. Review failures and limitations before publishing aggregate results
and charts on GitHub. A library-wide smoke test does not cover all facts,
diagrams, equations or questions in each book. The reviewed September aggregates
above were exported with the allowlist in `tests/support/publish_benchmark_charts.py`;
it deliberately excludes private nested records rather than trying to redact
free-form source text.

Aggregation checks (no inference or performance claim):

```sh
python3 tests/unit/pdf_library_report_test.py
node tests/unit/pdf_benchmark_http_test.mjs
```
