# Complete Search and Deep Research: answer quality first

This experiment checks the final answer, not just whether a page was fetched
or a citation appeared. A correct answer must cover the requested details,
have supporting source evidence, disclose relevant conflicting definitions,
and follow the requested length. A faster wrong answer does not count as a win.

## Answer-review update

**Latest complete replay: 4/4 meets the checked requirements, versus 2/4 in the
previous focused-evidence version.** This is two Search and two Deep Research
questions; both formerly failing Research answers now pass the stated criteria.
They are known development questions reused during implementation, not held-out
evaluation or a general accuracy claim.

![All five complete versions and twenty measured durations, with unsuccessful answers hatched.](../../../assets/README%20images/benchmarks/search-answer-review.png)

| Question | Latest independent review | Words | End-to-end time |
| --- | --- | --- | --- |
| HTTP rule — Search | Correct optional header and rate-limiting meaning | 49 | 122 s |
| Python suffix — Search | Correct version and resulting value | 22 | 61 s |
| Venus periods — Deep Research | Correct periods; both conflicting source intervals disclosed | 193 | 312 s |
| Accessible controls — Deep Research | Correct dimensions, levels and inline exceptions; no invented gap | 189 | 293 s |

This is not a speed improvement. The prior failed Research answers took 247 and
255 seconds. Nor is it a perfect-prose score: the latest Venus report has one
imprecise, redundant sentence about whether intervals differ, after it already
states both endpoints correctly. Its complete answer discloses the unreconciled
definitions instead of asserting a settled daylight value. The independent
review records this limitation rather than silently editing the generated answer.

[Latest reviewed measurements](results/2026-09-06-review-definitions.json) ·
[Matplotlib plotting script](plot-answer-review.py).
The exact final runtime SHA-256 is
`8fd0ac9e24536b6948f9c37a86a9bbe5e8b4e86c68c5fbc523514c8f82e12a20`.
The per-requirement gate passes against the initial paired comparison, the prior
focused replay and the first review attempt; no previously demonstrated
requirement was traded for the aggregate score.

Deep Research now compares shared-number definitions **before seeing a draft**,
then writes a compact answer and reviews its claims against all collected
statements/excerpts, not only the sufficiency judge's selection. Referenced
counter-evidence is retained during corrections. Explicit numeric upper word
limits in supported English/Italian forms are counted, including headings and
sources. An unrecognized length instruction still relies on the model.

The app delivers the exact reviewed text without another model rewrite.
The original request and reviewed bytes are bound together; stale or altered
reports cannot inherit a passing review. An unsuccessful review remains an
incomplete draft. Source comparison, writing and at most two corrections share
a four-minute deadline. A model review is **not** the benchmark grader or a
guarantee of truth: it can inherit an extraction error or miss an unsupported claim.

Three complete rejected development attempts are retained:

- [Generic answer review](results/2026-09-06-review-generic.json): **3/4**. The
  accessibility answer became concise, but the local reviewer still approved
  the erroneous equivalence between two different intervals. Independent review
  rejects that answer despite the model's approval.
- [Definition-first review, parser failure](results/2026-09-06-review-parser-failure.json):
  **3/4**. The Venus report disclosed both source definitions. The accessibility
  run failed because a valid JSON array of comparison envelopes was passed
  through an object-only extractor. Its retained 414-word fallback is marked
  incomplete and fails the requested length. This is not a successful answer.
- [Review with an unsupported gap](results/2026-09-06-review-unsupported-gap.json):
  **3/4**. The parser completed and the accessibility answer met its 250-word
  ceiling, but it invented uncertainty about a scope the cited general rule
  already defines. The model reviewer approved this; independent review rejects
  it. Cautious wording is not automatically factual. Writer/reviewer instructions
  now explicitly check negative claims and gaps against the available rules.

The parser correction accepts a complete object or a complete list of comparison
envelopes. Both paths validate every group, fact identity and duplicate; no
comparison is dropped to obtain a passing result. Production regressions cover
this observed failure, malformed replies, omitted counter-evidence, cancelled
review and exact delivery to the persisted/rendered assistant message.
The added simulated regression also exercises rejecting and removing an invented
gap while retaining the supported general rule and the original failed draft.

## Earlier focused-evidence experiments

**Earlier final replay: 2/4 fully passing answers, versus 1/4 baseline.** The rejected
focused v1 candidate scored 1/4. The first update also scored 2/4, but had a
WCAG content regression that the final version repairs. The final version
preserves every individually demonstrated requirement from the initial
comparison; this is a non-regression result, **not** proof that all requirements
or all research questions now pass.

![Every complete answer and measured duration, including the rejected candidate and all failures.](../../../assets/README%20images/benchmarks/search-complete-pipeline.png)

| Earlier question | Independent review | End-to-end time |
| --- | --- | --- |
| HTTP rule | Correct, concise, cited | 108 s |
| Python suffix | Correct version and value, concise, cited | 52 s |
| Venus periods | Main values correct; undisclosed source-definition conflict remains | 247 s |
| Accessible controls | Correct dimensions, levels and both inline exceptions; 318 words instead of fewer than 250 | 255 s |

Those two earlier Research answers remain failures even though their observed
durations are lower than the baseline. That earlier version preserved the
language/length handoff, but lacked the bounded word checks and model evidence
review described above. No version guarantees semantic truth.

Public measurements and per-answer reviews:
[initial paired comparison](results/2026-09-06-pipeline-initial.json),
[rejected focused v1](results/2026-09-06-pipeline-focused.json), and
[final focused v2](results/2026-09-06-pipeline-reviewed.json).
[Matplotlib plotting script](plot-pipeline.py).

## What was run

Four fixed public questions, each with a real engine, actual browser/search
requests, production Search/Research orchestration and a final model answer.
The first experiment alternated baseline/update order. Each later **development
replay** runs all four questions with focused evidence; these are not additional
alternating paired experiments and do not replace any original failure.

- Apple M2 Max, 96 GiB; DeepSeek V4 Flash Chat IQ2XXS, resident weights,
  SSD streaming off, 32,768-token context, temperature 0, thinking off.
- Same engine/model, final answer limit of 2,800 tokens and 20-minute case
  deadline. Timings include planning, real search/read, extraction, sufficiency
  checks, the Research report when applicable, and the final answer. Model
  startup is outside the per-question duration.
- The original baseline runtime is `c3329de`; the first update is `1d21c29`.
  Answer-review replays use `--before b2206b8 --variants after` to record their
  previous-version reference without pretending to re-run it as a paired test.
  Each receipt records the exact runtime SHA-256 and engine revision.
- Isolated native host and task-owned headless Chrome. This executes the
  production pipeline but is **not** a macOS WebKit desktop-click E2E test.
- One sample per question/version on a shared host. Public pages, network,
  search rankings and warm caches vary; no causal speedup or general accuracy
  claim follows from these four development questions.

## Errors the first experiment exposed

Only **1/4 baseline** and **2/4 first-update** answers met every requirement.
Do not confuse these counts with the separate 8-case page-extraction result.

| Question | Baseline | First update |
| --- | --- | --- |
| HTTP 429 | Correct and concise; 137 s | Correct and concise; 129 s |
| Python suffix | Missed the version and answer; 192 s | Correct version and value; 88 s |
| Venus periods | Correct main periods, ambiguous daylight definition, undisclosed source conflict; 519 words; 469 s | Same source-conflict problem, now 229 words; 447 s |
| Accessible target sizes | Correct facts, but 784 words; 364 s | Incorrect enhanced inline exception and unsupported level citations; 263 words; 297 s |

The WCAG case is a **content regression**, even though the total pass count
improved elsewhere. It remains in the public results. The narrower excerpt
missed a relevant exception, and the model filled that gap incorrectly.

For Venus, NASA's [Facts page](https://science.nasa.gov/venus/venus-facts/)
describes 117 days as sunrise to sunset, while
[Space Place](https://spaceplace.nasa.gov/all-about-venus/en/) uses that interval
for successive sunrises. The responses repeated or mixed these meanings while
asserting no contradiction. Rotation/orbit values and citations alone are
insufficient for a pass on a question that explicitly asks about daylight.

The HTTP metadata initially recognized only the RFC-editor URL. Both variants
actually read the authoritative [IETF RFC mirror](https://datatracker.ietf.org/doc/html/rfc6585).
Independent review accepts that source; the original metadata is unchanged.

## Focused-evidence change

The first focused candidate is **rejected: 1/4** fully passing answers. It took
100/65/280/228 seconds for the four questions respectively, but lost the Python
result, still mishandled the WCAG exception and produced a 301-word Venus answer.
The per-requirement regression gate rejects it despite the shorter durations.

The next version fixes concrete boundaries exposed by those answers:

- Link destinations are masked only for ranking, before window slicing, so
  repeated URL paths cannot masquerade as relevant prose. Compound query terms
  match their parts. Literal output and the existing 5,200-character extraction
  budget are preserved.
- The source introduction retains more definition/scope context. Overlapping
  windows contribute their uncovered text instead of losing an entire rule
  near a boundary. A model-free regression exercises both excerpt passes.
- The original request, not the classifier's rewritten search question, reaches
  report synthesis and the final answer context. A deterministic test proves
  language/length constraints survive that handoff.
- Applying an explicit documented rule to supplied inputs is allowed as a
  labelled derivation, not a quotation or a claim that code was executed.
  Definition/interval disagreements are explicitly checked during judgment and
  writing. These prompt changes still require actual answer review.

A Unicode offset correction was added after the final pipeline snapshot was
captured: case folding is performed after slicing, so expanding characters do
not shift the source positions. It has a deterministic regression and is in
the subsequent real Vision-Exp replay; the full-pipeline receipts retain their
actual earlier runtime hash rather than being relabelled as a later source.
An exact-hash reconstruction and differential check confirmed identical
two-pass excerpts on all seven page reads in the measured final collection.
Frozen runtime: `f465ae25dc6306c6d80e707bfed9bc77373c4dcdebd163595d2fb8bdb2e2837c`;
offset-corrected runtime: `9e5f04cead8a0e3b89be08507cd81a4aa2f40aced3bbca20061595328457ae52`.

Extraction now treats twelve facts as a ceiling, not a quota. The question
determines which details matter; unrelated authors, background and neighbouring
features no longer fill the answer by default. The existing sufficiency call
selects evidence IDs covering the answer, including relevant limitations and
disagreements, without adding another model round.

The complete collected facts and source cards are retained. Invalid selections
fall back to the full evidence set. The report still has to cover each selected
fact, and unknown citation IDs fail its structural check. These deterministic
checks do **not** prove semantic truth or correct model selection. Cancellation
during report writing now propagates Stop instead of publishing a fallback.

## Exact prompts

### HTTP rule — Search

```text
According to RFC 6585, is Retry-After mandatory in an HTTP 429 response, and what does 429 mean? Verify the RFC on the web and answer briefly with a citation.
```

Expected: optional header and rate limiting, checked against
[RFC 6585 section 4](https://datatracker.ietf.org/doc/html/rfc6585#section-4).

### Versioned documentation — Search

```text
Read https://docs.python.org/3.14/library/pathlib.html . In which Python version did a single dot become a valid pathlib suffix, and what is PurePosixPath("report.").suffix in that version? Cite the documentation and keep the answer short.
```

Expected: Python 3.14, single dot, supported by the
[versioned pathlib documentation](https://docs.python.org/3.14/library/pathlib.html#pathlib.PurePath.suffix).

### Conflicting definitions — Deep Research

```text
Find NASA evidence for this narrow question: how long does Venus take to rotate once and to orbit the Sun, in Earth days? Which takes longer? Distinguish a full rotation from daylight duration. Give a concise cited report, at most 250 words, and state any evidence gap.
```

Expected: about 243 Earth days for rotation and 225 for orbit; rotation is
longer. Daylight is not a full rotation. The discrepancy between NASA pages
must not silently become an asserted, settled daylight duration.

### Related requirements — Deep Research

```text
Compare W3C WCAG 2.2 Target Size (Minimum), SC 2.5.8, with Target Size (Enhanced), SC 2.5.5. Read https://www.w3.org/WAI/WCAG22/Understanding/target-size-minimum.html and https://www.w3.org/WAI/WCAG22/Understanding/target-size-enhanced.html . State the CSS-pixel dimensions and conformance level of each, and whether inline links within sentences are an exception. Keep the cited report below 250 words; do not treat the enhanced value as the minimum.
```

Expected: minimum 24 × 24 CSS pixels at AA, enhanced 44 × 44 at AAA; both
have an inline exception. See the W3C
[minimum](https://www.w3.org/WAI/WCAG22/Understanding/target-size-minimum.html) and
[enhanced](https://www.w3.org/WAI/WCAG22/Understanding/target-size-enhanced.html) pages.

## Reproduce and review

```sh
# Real installed Chat weights and a free port 9333 are required.
node tests/live/research_pipeline_benchmark.mjs --run
# A separate all-question development replay, never a replacement for failures:
node tests/live/research_pipeline_benchmark.mjs --run --variants after
# The subsequent answer-review development collection:
node tests/live/research_pipeline_benchmark.mjs --run --variants after --before b2206b8

# After independently reviewing every answer and binding its unchanged row hash:
node tests/support/publish_research_pipeline.mjs \
  path/to/results.json path/to/review.json path/to/public-results.json
# Reject loss of any previously demonstrated requirement, not only total score:
node tests/support/check_research_quality.mjs \
  extension/search/bench/results/2026-09-06-pipeline-initial.json \
  extension/search/bench/results/2026-09-06-review-definitions.json
python3 extension/search/bench/plot-pipeline.py
python3 extension/search/bench/plot-answer-review.py
make test-search-evidence test-search-publication test-frontend-unit
```

Published data includes every outcome, individual durations, review criteria,
source URLs, word counts and provenance hashes. The full raw requests, browser
responses and answer transcripts stay in ignored local receipts; public
summaries are reviewed paraphrases. Charts can be regenerated from the public
data, but the raw semantic audit cannot be independently replayed from hashes
alone. Do not present these receipts as a public raw-transcript corpus.

Word counts use whitespace-separated words, including headings and source
lists. The benchmark publisher requires the complete denominator and a review
bound to each exact row; no model self-score is used.

One shell sequence accidentally started an intermediate collection after a
newly added model-free excerpt regression failed. It was stopped after starting only the HTTP question
(three model requests, 56.6 seconds); the other questions were not run. This is
an interrupted collection, not a complete four-question quality score. Its
ignored receipt is retained separately, and it is not passed to the complete-
denominator publisher. Both live runners now enforce the model-free prerequisites
before starting an engine, so a caller cannot accidentally bypass a failed gate.
All three complete collections remain in the chart/data.
