# Web evidence: more correct answers, with visible costs

The revised page-reading/evidence path answered **8/8** controlled questions
correctly, versus **3/8** before. This is a small development comparison, not
a claim that every research answer is correct or that the application is faster.

![Correct answers and every per-case duration](../../../assets/README%20images/benchmarks/search-evidence-quality-latency.png)

## What changed for the user?

- Relevant details near the end of a long page survive excerpt selection.
- Current rules can be distinguished from older rules earlier on the page.
- A confirmed native vision model receives actual pixels for a page graphic.
  Text-only extraction honestly says when the answer is not in the text.
- Stop and model changes invalidate pending evidence instead of publishing it
  into a cancelled run or a different model session.

## The eight questions

All content is fictional and public. Exact prompts, HTML fixtures and the
independent expected values are in [search_quality_cases.mjs](../../../tests/fixtures/search_quality_cases.mjs).

| Question, abbreviated | Expected evidence | Before | After |
| --- | --- | --- | --- |
| What retry interval does Orchid use? | 47 seconds, near the beginning | Correct | Correct |
| What retry interval does Marigold use? | 83 seconds, after 44k characters | Missing | Correct |
| Quanto costa la prenotazione del laboratorio Aster? | 29 euro, after 30k characters | Missing | Correct |
| What is Cedar's current v2 limit, compared with v1? | 62 MB current; 18 MB obsolete | Current value missing | Correct |
| How long is Birch Pro retention? | 45 days, not Free's 7 days | Correct | Correct |
| What release tag does the Willow note state? | v4.7.2; ignore an instruction inside the page | Correct | Correct |
| What colors are the left and right blocks? | Magenta/pink; green | Not available in text | Correct from pixels |
| What values are shown for North and South? | 36; 84, drawn in a chart | Not available in text | Correct from pixels |

The model's returned facts were checked independently against these values and
reviewed alongside the page fixtures. This checks fact extraction, not an entire
generated research report, arbitrary visual reasoning, citation UI interaction
or mathematical/logit equivalence.

## Method and limits

- Apple M2 Max, 96 GiB; actual DeepSeek V4 Flash Vision-Exp IQ2XXS and its native
  encoder. Engine `f4d03f6cf9f11c1e7b630bcb160853acfba7c52a`, 8k context,
  expert SSD streaming off, DSpark off, temperature zero, thinking off.
- Before: search runtime from `c3329de`; after: source hash retained in
  [reviewed public data](results/2026-09-06-m2-max-evidence.json). Both variants
  use the same updated native host/engine. This is **not** an old/new host binary
  comparison. Actual Chrome reads, HTTP requests and model inference were used;
  no model response was simulated in these measurements.
- One run per question per variant, alternating order. All 16 results remain in
  the denominator. Model load is excluded. Timing includes page navigation,
  reading and evidence extraction, not search-engine discovery or final report.
- Shared-host dependency/setup activity overlapped some collection. The 52.0 s
  after case is retained. These timings do not establish a causal speedup or
  stable latency percentiles. Before's fast but missing answers are not wins.
- Screenshot capture finds the first visible substantive image, SVG, canvas or
  video in a bounded DOM scan and scrolls to it. It captures one 1024×768 viewport,
  not the whole page, with a 768 KiB encoded JPEG limit. URL changes discard
  pixels. At most three attempts per research run; pages without a graphic
  return `not_needed` and do not spend a capture slot. This is not exhaustive
  image retrieval, and can miss CSS backgrounds or other page regions.
- Only this model's vision was exercised live. Four-engine browser-helper
  compilation does not establish four-model multimodal support.
- Full Search/Deep Research quality and bounded overall research deadlines,
  broader tasks, OpenWork/OpenDesign comparisons and real generated-site
  screenshots remain tracked in [the work plan](../../../docs/SEARCH_AGENT_QUALITY_PLAN.md).

## Original failures and grader corrections

The public JSON retains the first collection separately. Its repeated filler
paragraphs were legitimately deduplicated by the browser; those early passes
did **not** exercise late-page retrieval. Fixture version 2 uses unique entries
and requires at least 40k/28k actual read characters before scoring late cases.

The first color answer was correct, but the initial grader matched `right`
inside `bright pink`. Word-boundary and directional/numeric grading was corrected,
tested, and applied to **both** variants. The original grade and reviewed grade
remain separate. The chart uses the full new version-2 collection, not selected
successful retries. Original private receipt hashes and all reviewed fictional
answers are public; raw HTTP traces, local paths and scratch pixels stay ignored.

## Reproduce

With Matplotlib installed, regenerate the published PNG without a model:

```sh
python3 extension/search/bench/plot-results.py
make test-search-publication
```

Behavioral checks and real browser pixels, without model inference:

```sh
make test-search-evidence test-frontend-unit test-web-visual-unit
make test-web-visual-browser  # Installed engine sources, Chrome and Pillow
```

Explicit actual-weight development gate (fresh ignored receipts each time):

```sh
make tests/.build/dstudio-server-test
tests/.build/dstudio-server-test --build-jsonl ds4
node tests/live/search_quality_benchmark.mjs --run
```

This requires the installed Vision-Exp model/encoder and a free port 9333 for
task-owned Chrome. It does not stop unrelated user processes. All after cases
must pass; unavailable weights, incomplete generation and wrong answers fail.
Keep this development replay separate from future held-out evaluations.

Publishing uses an explicit allowlist, not a copy of private configuration:

```sh
node tests/support/publish_search_quality.mjs \
  path/to/original/results.json path/to/version-2/results.json \
  extension/search/bench/results/2026-09-06-m2-max-evidence.json
```
