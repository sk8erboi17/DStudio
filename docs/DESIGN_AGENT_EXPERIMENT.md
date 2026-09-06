# Original Design systems — development comparison

This is a real native-agent development experiment, not a model self-score or
a claim of universal design superiority. The same three frozen briefs are sent
to the captured old and new Design agents, linked to the same DS4 main runtime
(`f4d03f6cf9f11c1e7b630bcb160853acfba7c52a`).

The old agent receives the recoverable old catalog/craft snapshot. The new agent
receives DStudio's five original systems and revised craft. DeepSeek V4 Flash
Chat IQ2XXS uses resident weights, 32k context, temperature 0.4, seed 20260905,
1536 thinking tokens and up to 8192 generated tokens per tool round, including
reasoning. Runs are
sequential. Each brief has a 15-minute startup bound and a 30-minute generation
bound. This is not a throughput benchmark; desktop load is not controlled.

Task-specific browser checks operate the generated files independently. Visual
review is separate: passing search, dialogs and overflow checks does not prove
that a composition is readable or attractive. The cases also guide development;
they do not establish generalization to unseen briefs.

Both initial full audits now exist. Their comparison can be derived without
editing the original receipts:

```sh
node tests/support/design_comparison_report.mjs BEFORE_DIR AFTER_DIR NEW_OUTPUT_DIR
make test-design-comparison-report
```

The report requires matching frozen briefs, model identity, engine source hashes,
sampling/memory settings and auditor revision. It verifies saved executable,
Design source and entry-file hashes. Missing cases, partial audits and changed
entries are rejected; completed failures remain visible. A partial HTML file
with working controls does not count as delivered. Counts of browser checks
are not converted into an aesthetic score. The report's unit tests use synthetic
receipts and do not supply additional inference or design-quality evidence.

## Completed initial comparison

The frozen initial comparison delivered **2/3 projects in each variant**.
Only **1/3 in each variant** both delivered and passed all independent browser
groups. These counts do not establish an overall quality win. The revised
archive is more readable, and the operations case now completes, but the archive
has a dead link and the revised workshop was never saved. Those failures are
retained, and the later targeted recovery run is not substituted into these
initial results.

![Initial Design comparison: both variants deliver two of three projects; one of three in each variant also passes every independent check.](../assets/README%20images/benchmarks/design-development-comparison.png)

[Public aggregate results and provenance hashes](benchmarks/design-development-2026-09-06.json).
The chart uses Matplotlib: `python3 tests/support/publish_benchmark_charts.py`.
It is reproducible from the committed aggregate JSON; the full local receipts
and generated projects are not published, so this is not a public raw-run corpus.
Model, runtime, sampling and development-set limitations are described above.

Validated full machine-readable comparison:
`tests/.artifacts/design-agent-comparison-final-20260906/comparison.json` (ignored).
Both variants were audited again with the same final auditor, including the
requirement for new confirmation feedback after the final workshop action.
The earlier comparison and audit receipts remain retained separately.

Raw baseline evidence is kept in ignored
`tests/.artifacts/design-agent-before-main-v1/`. Its three cases are terminal
and have a complete independent audit. Revised evidence is separate; partial
audits are explicitly labelled and list cases not yet audited.

| Old-agent case | Completion | Independent checks | Visual review |
|---|---|---|---|
| Reading archive | Registered in 1387 seconds including startup | 8/8 groups pass: delivery, content, three widths, in-page destinations, filtering/dialog, local export | Desktop third paragraph is squeezed into a 96px track; mobile action precedes its title |
| Repair operations | Timed out after 30 minutes of generation; partial HTML exists, no registered artifact | 7/8 groups pass; only delivery/completion fails | Clear desktop rail/table/detail hierarchy; mobile uses internal table scrolling, but compact controls remain small |
| Workshop planner | Registered in 1588 seconds including startup | 7/8 groups pass; the review step does not show the selected workshop/day | Readable desktop split; mobile inserts an overview panel before the current action and the palette is mostly cool grey |

The archive's third paragraph uses 17px type over 13 lines at 1440px. The first
two excerpts occupy roughly 605px and 459px. A CSS `order` change reorders grid
auto-placement, so the third excerpt lands in the number rail. The whole page
still fits the viewport. The original generated artifact is retained unchanged.

The same run spent extra tool calls replacing legitimate accent references after
a warning based on their count in CSS. It changed hover/focus/secondary states
to a different variable to satisfy the warning. Source-reference counts do not
measure painted emphasis or contrast; that warning has been removed.

The operations audit initially missed a valid loading skeleton exposed through
`role="status"` and its accessible name. The auditor now recognizes that standard
feedback pattern as well as text/progress bars. Re-running the actual controls
confirmed search, loading/empty/error and Retry all work in the partial page.
That initial harness false positive is not a model failure. The 1856-second
total runtime (including 56 seconds to ready), generation timeout and missing
artifact remain failures; the partial page is not counted as a delivered result.

The completed workshop has a functional defect that its own critique missed:
the visible Review step has empty workshop/day values. Only clicking Complete
demo fills those values, immediately before hiding the review and showing the
confirmation. The independent browser trace records empty visible values before
confirmation and `Bicycle care` / `Thursday` in the hidden review afterwards.
Evidence: `workshop-review-trace.json` and `workshop-review-empty.png` under the
before-run directory. The generated HTML remains unchanged.

The auditor itself was corrected to check rendered text rather than raw
`textContent` (the uppercase brand eyebrow is visibly present), and to look for
visible review values rather than a hidden earlier option with the same name.
Those harness defects are not model errors; after correction, the genuinely
empty review still fails. Earlier audit receipts are retained in audit-history
directories, and subsequent receipts record the auditor's source hash.

The rendered-text check also normalizes whitespace: a visible heading with an
explicit line break contains the same words. This correction was applied to
both variants, rather than counting the revised archive's line break as missing
copy. The additional in-page destination check runs on both variants as well;
it validates actual rendered DOM destinations, not screenshots or source phrases.

## Initial revised outputs

| Revised-agent case | Completion | Independent checks | Visual review |
|---|---|---|---|
| Reading archive | Registered in 960 seconds including startup | 7/8 groups pass; `Field notes` has no in-page destination | Readable excerpts and natural mobile title/action order; longer introductory area and repeated index |
| Repair operations | Registered in 1387 seconds including startup after recovery from a truncated write | 8/8 groups pass, including search, four states, Retry and internal destinations | Restrained green/mint, broad table with detail below; mobile text wraps and controls remain usable |
| Workshop planner | Turn returned idle after 597 seconds without any saved page or artifact | Delivery failed; browser checks not run because the page does not exist | No generated page to review |

The revised archive registered its artifact in **960 seconds including startup**.
Search, no-results feedback, the native dialog/Escape, required content, three
viewport widths and local assets work. It passes **7/8 independent groups**:
the navigation link `Field notes` targets `#notes`, which does not exist.
That is a real generated-output defect, not a completed fix or a passing result.

The actual desktop and mobile screenshots show a warm serif hierarchy, a ruled
reading index with a quieter sidebar, and a natural title/excerpt/action order
on mobile. At 1440px the three summary paragraphs each receive about 689px at
17px type. The old archive's squeezed third column does not recur. The revised
excerpts are also shorter; this is a new generated composition, not a measured
repair of identical paragraph copy. The large introduction and repeated sidebar
index make the mobile page relatively long, so this is not an unqualified claim
of superior information density.

Evidence: `archive-1440.png`, `archive-768.png`, `archive-390.png` and
`audit.json` in `tests/.artifacts/design-agent-after-main-v1/`.
The audit records the unresolved link. Original generated files are unchanged.
The elapsed time is descriptive, not a controlled performance comparison.

The revised operations run also encountered a truncated large inline write.
The model checked the workspace, found only its saved plan, and switched to
three complete writes: `repair.html`, `repair.css`, `repair.js`. It then verified,
refined and registered the result. The independent browser audit confirms search,
Loading/Empty/Error, Retry to populated, navigation and local assets all work.
This is actual recovery by the model in this case, not just the earlier simulated
protocol test. The old version timed out without delivering its partial page.

The revised desktop page has a narrower rail and a broad table with the parts
detail below; mobile uses wrapped table cells and stacked detail controls. The
old partial page had a useful side-by-side table/detail arrangement and more
sample rows. Thus the clear improvement here is completed delivery with working
requirements, not proof that the new composition is aesthetically superior.
The two actual screenshots are retained; neither page was manually repaired.
Evidence: `repair-1440.png`, `repair-768.png`, `repair-390.png`, and the complete
audit in the after-run directory.

## Generation-limit completion bug and targeted repeat

The revised workshop ended midway through a CSS draft in chat, with no todo,
saved page or artifact. Its journal nevertheless recorded `run_done/status=ok`.
The native loop had treated output-budget exhaustion like EOS whenever no DSML
call and no unfinished todo existed. The 8192-token development bound exposed
this silent completion path; making the benchmark allowance larger would not
correct that distinction.

The current local loop now tracks EOS explicitly, including the speculative
decode path. After an exhausted plain-output round it issues a concrete recovery
message and continues, at most three times per user turn. It does not raise the
per-round allowance, execute incomplete DSML, or reset this bound after an
intervening tool call. It checks space for the exact continuation message and
compacts if needed. Repeated exhaustion ends with an explicit incomplete status,
preserving saved files and leaving the process available for user input.

Native regression tests cover exhaustion before any todo, a genuine EOS at the
boundary, ordinary short answers, zero context room and the finite retry bound.
They pass in `tests/.artifacts/design-generation-limit-regression-20260905.log`.
The benchmark recorder and report also retain terminal generation-limit events
as failures even if an artifact event exists. These checks are not a claim that
the model has already completed the failing task.

A completed targeted repeat of the **same workshop brief** is retained in
`tests/.artifacts/design-agent-workshop-recovery-v2/`, with unchanged model,
engine, seed, sampling, 32k context, 8192-token round bound and 30-minute task
bound. It delivered `workshop.html` in **1319 seconds including startup** and
passed **8/8 independent groups**: delivery, three widths, required content,
in-page destinations, interactions and offline export. The browser chooses
nondefault values (`Bicycle care`, `Thursday`), verifies the visible Review,
goes Back twice, checks retained choices and requires new confirmation feedback.
No generated file was manually repaired.

The desktop page has a readable green/paper split with a single active step.
The mobile controls remain readable, but the long introduction delays the first
action; the panel's default blue focus ring is visually conspicuous. These are
remaining composition refinements, not hidden by the passing interaction checks.
Screenshots: `workshop-1440.png`, `workshop-768.png`, `workshop-390.png`;
receipt: `audit.partial.json` (explicitly workshop-only).

**No generation-limit continuation event occurred in this replay.** The model
registered its plan before reaching the cap this time, so its successful delivery
does not prove that the new continuation branch caused it. This is one development
regression replay, not a replacement three-case comparison or a held-out
generalization test. Captured Design source SHA-256:
`0a6d85367bb674810ff7aa872bd96be4d23db6ab1921ace7d9694a51540f70a4`.

The continuation branch was tested separately with actual DS4 weights and a
deliberate one-token round limit. The captured initial revised binary reproduced
the bug: no continuation, no artifact, yet journal status `ok`
(`tests/.artifacts/design-generation-limit-live-n0LDQq/`). The final executable
produced exactly three continuations, one terminal `generation_limit`, no tool
calls, preserved the existing file byte-for-byte and returned to user input
(`tests/.artifacts/design-generation-limit-live-OYRmV8/`). This is a passing
runtime fault-injection test, not a useful-answer or aesthetic-quality result.
An intermediate corrected-binary test failed only because it had not allowed
the runtime's automatic `MEMORY.MD` summary; that receipt remains retained in
`design-generation-limit-live-BTfzdq/`, and the final test checks the summary's
idle/no-artifact state explicitly.

## Inline typography without false missing-copy failures

The targeted replay spent unnecessary work removing `<em>` from a heading to
obey the earlier one-text-node instruction. The visible words were unchanged.
The current agent and exact-copy check now allow ordinary inline emphasis and
spans within a phrase. They still reject hidden-only or attribute-only copies,
changed spacing and text stitched from separate sections or controls. This is a
bounded source check, not a complete CSS visibility or HTML text-normalization
engine. The accompanying native regressions exercise actual checker decisions,
an artifact containing an emphasized heading, and its three-width rendering.
This later fix is outside the captured workshop replay; it is not retrospectively
credited with that model output.
The final native self-test and full runtime suite passed in
`tests/.artifacts/design-final-runtime-20260906.log`, using source SHA-256
`87acb241eb2f7ca4aecf2a7eb407a6ed6c37930475801081c315d1813e4e2bd9`.

## Subsequent navigation regression (outside the frozen comparison)

The current native inspector now reports visible in-page links whose targets
are absent from the rendered DOM. `inspect_layout` lists their selectors and
hrefs; `verify_artifact` emits a P1 warning. It deliberately does not infer that
a scripted hash router is broken: such navigation needs an interaction test.
This warning does not retroactively fix or pass the archived `#notes` defect.

The real Chrome self-test reproduces the missing link, checks valid named,
encoded, top and text fragments, then supplies the missing destination through
an external JavaScript-only edit. Fresh rendering clears the warning at all
three widths. Native self-tests and remote-loop recovery passed in
`tests/.artifacts/design-navigation-regression-final-20260905.log`; the isolated
rebuilt bundle passed in `design-navigation-bundle-20260905.log`. The first test
fixture had accidentally made its hidden link visible through CSS; that failed
receipt is retained separately, and the corrected fixture asserts exactly one
unresolved link rather than ignoring the additional one.

The intermediate navigation-only Design source SHA-256 was:
`11b10ddf8252836f98ea4bea5b80a5e058fc8f6e6b4bd5783b7263181400aefa`.
The completed initial comparison used the captured source and binary below, without
this later navigation warning. Its inference results must not be attributed to
the later inspector change. No user application or model was restarted for it.

## Regression derived from the observed failure

The native renderer now reports long prose confined below 12em over at least six
actual rendered lines. Its P1 finding includes selector, box, font and containing
grid/flex measurements. It is an inspection cue, not a universal layout veto.

The native self-test writes a real narrow-column page and renders it at
1280/768/390px. Desktop/tablet report the problem despite having no page overflow;
mobile does not. `inspect_layout` returns the measured 100px paragraph; changing
only its grid column clears the findings. Short notes, hidden text and explicit
verse remain accepted. This real-browser regression passed.

The complete initial results above remain mixed. These native regression checks
do not turn the model's self-ratings into independent quality evidence.

## Recovery observed during the operations case

The old agent emitted a large inline HTML write that ended before its DSML
batch closed. Streamed progress exceeded 22 KB, but no file was saved. It then
repeated substantial generation before eventually writing the entry. These
attempts remain in the raw log; progress bytes are not delivered files.

The comparison deliberately keeps its 8192-token per-round bound unchanged.
The production default has no artificial per-round cap, but end-of-response and
context boundaries can still truncate a tool call. The revised agent supports
local linked CSS/JS files and gives a specific smaller-call recovery instruction
after incomplete batches, rather than only repeating the syntax reminder.

The native self-test cuts real parsed batches inside content, between invokes
and inside the last delimiter: no partial writes execute, even when an earlier
invoke in that batch is complete. Separately, the actual native remote loop was
fed simulated truncated frames; the next model request contained the recovery
instruction, the earlier file remained intact and two complete retry rounds
saved exact expected bytes. Both tests passed. They validate recovery mechanics,
not the probability that a real model will follow the instruction.

## Preparing the revised agent

The revised input set also removes conflicting color quotas and font blacklists
from the prompt/craft material. This matters for the original systems: a colored
Pulse canvas and Forma's available sans display are intentional choices, not
automatic defects. Pixel-inspection capability is reported honestly to the model
before it starts; a text-only checkpoint should use available geometry checks,
not repeatedly retry a vision tool that cannot run.

Splitting large writes also exposed a source-lint gap. Direct local CSS/JS files
are now read for the same checks as inline code, with explicit bounds and no
network fetch. A real-file regression verifies both spellings, source-only CSS
changes, missing dependencies and out-of-project symlinks. The browser separately
renders the linked page at three widths. None of this is a substitute for the
actual generated-output comparison.

The initial revised run is complete in
`tests/.artifacts/design-agent-after-main-v1/`. Its executable, original packs,
craft files and exact Design source are captured there. No working-tree change
can alter the executable or pack inputs used by its later cases. Engine source
hashes were checked against the before receipt immediately before launch.
Two cases were delivered and reviewed above; the unsaved workshop is a failure.
The captured initial Design source SHA-256 is
`5c8d2dcb935a4d70372b067d1029ac990e1da2a7f6667d16d74b1edc77591314`.
