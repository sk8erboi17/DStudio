# Engine update admission

DStudio now checks an engine update before creating a macOS release archive.
A successful build alone is not enough: the proposed engine revision, its
patches, the app's actual installer pins and the required test receipts must
agree. Normal `make` / `.app` builds remain available while qualification is
in progress. This check never updates a user's engine or downloads weights.

**Current status: qualification is incomplete.** The
[machine-readable matrix](engine-upstream.json) deliberately contains missing
receipts and unresolved source reviews. It must fail admission until those
items are resolved. Its rows are requirements, not an announcement that all
models, backends or modes work.

The October 1 documentation audit counts nine macOS targets, **117 required
gate slots and zero linked receipts** in that matrix. These are missing bound
qualification records, not 117 failed tests. Existing scoped results may be
linked only after checking the exact source/patch/binary/model identity and gate
scope; no new release receipt was created by the documentation cleanup.

## Recorded sources

Main's pin was updated to upstream's September 20 revision and rechecked as
main's tip on September 29, 2026; the other recorded tips retain their
September 12 review. `recordedTip` means observed, not qualified.
The command rechecks each relevant branch over the network.

| Engine | Recorded revision | Current evidence / remaining work |
| --- | --- | --- |
| ds4 main, including Qwen3.8 Next | [`0aaea5a`](https://github.com/antirez/ds4/commit/0aaea5a238fb41a35106a551e73c8409dfb751ac) | [Unified-main migration](QWEN_NEXT_MAIN_MIGRATION.md) is implemented. New single-file Q4 has a complete 75/100 corpus receipt, including 8/8 long cases; Q2 and complete numerical/mode/desktop qualification remain open. [V4.1 evidence and remaining work](DS41_UPDATE_CHECKPOINT.md) retain the scope of each recorded revision. |
| Laguna | [`448d569`](https://github.com/antirez/ds4/commit/448d5695d1c86401a4e9447c440feb983b73e6de) | No new branch commits at the last recorded review; applicable main changes and complete macOS mode coverage remain open. Other backends are outside this campaign. |
| Qwen3.6 MoE fork | [`73434c4`](https://github.com/vagrillo/ds4/commit/73434c4bb9d8bb18425a2577edada69d25d44c47) | The upstream delta is documentation-only ([receipt](upstream/qwen35-2026-09-08.json)); DStudio separately applies the Q6_K correction and bounded prefill overlays. Native/operator and lifecycle checks pass; full-model qualification on the batched path remains open. [Current checkpoint](QWEN_CHECKPOINT.md). |
| q36 / Qwen27B | [`1305843`](https://github.com/Ninnix/q36/commit/1305843c735380f912619548b121cba8601f2f85) | Installer uses ordered runtime/monitor/owner/cache-usage/online-F16 patches. Historical real workflows on the preceding stack remain recorded separately. Current parallel-attention operators, lifecycle and fresh source/build checks pass; full-model quality, long-context deadlines and mode qualification on this overlay remain open. [Current checkpoint](QWEN_CHECKPOINT.md). |
| q27 / Qwen27B candidate | [`8cd7083`](https://github.com/signalnine/q27/commit/8cd708389f8b5a2c5a7c481237b00c8d7f570e7f) | 69 new commits since the preceding `44c6e56` candidate, including tokenizer, sampler, KV and DFlash changes. CPU fixtures and native Metal operators pass with a [tested DeltaNet correction](../patch/q27-metal-delta/README.md). Not promoted. Its only admission row was Linux CUDA, so since September 29 it is outside the macOS-only campaign and no longer an admission track; the Metal DeltaNet patch and its test remain available. |

The matrix declares nine macOS Metal targets. On September 29, 2026 the user
limited the campaign to macOS on Apple Silicon; the 23 Linux and six Windows
targets (CPU, CUDA, ROCm, Vulkan) were removed as out of scope, not qualified.
The same decision keeps only the Vision-Exp DeepSeek V4 Flash checkpoint; its
four non-Vision rows were removed. DeepSeek V4.1 and GLM 5.3 Flash are
qualified last, in a separate session.
Every receipt must still match its target's operating system as well as the
engine and patches. The full campaign
census, additional format/quantization choices
and final build freeze remain separate requirements.

The Agent patch set is now version 103, adding unified main without changing
the other variants' source output. The separate Qwen Next target is replaced by
main/Qwen Next Q2 and Q4 rows; all their full qualification gates remain open.
The version-102 real Laguna continuation
replay passes 6/6, including separate summary review. The corresponding Qwen3.6
MoE replay retains 1 PASS, 1 timeout FAIL and 4 not-run cases, plus a summary
that counts a partial function as emitted. The 77-stage native consumer build
uses simulated responses and does not close that real-model failure. See the
[current WIP status](WORK_IN_PROGRESS.md); the earlier progression below is
historical evidence, not qualification of v102.

Laguna/older-MoE retain v98's owner-only
publication and v99's native-framed continuation with unchanged output limits.
The first real Qwen MoE continuation run passed 4/6: code, facts and tools worked,
but manual compaction announced readiness early and Stop feedback was hidden.
Version 100 separates worker ownership from display status and emits explicit
service notices across all seven variants. Patch lifecycle and focused native
thread/barrier checks pass, as does the complete 77-stage four-engine consumer
rebuild (`run-YInkMT`). The v100 real replays pass 5/6 on MoE and 4/6 on Laguna:
MoE generates invalid C return types; Laguna drops remembered facts in its
summary. Both control fixes pass. V101 strengthens the private summary policy
across seven variants; migration, fresh 77-stage native consumer builds and
focused tokenizer/continuation gates pass. The model replays remain separate.
No v100 receipt is relabeled as a v101 pass. Fresh q36 `8362010` also passes 42 native/projector stages and 13 native
search-extractor fixtures in each of Chromium/WebKit; those browser fixtures
do not perform live search or language generation. The
[update checkpoint](DS41_UPDATE_CHECKPOINT.md) retains the original failures
and exact scope. Patch-set hashes are current, but no missing release/model
receipt is filled by these fixture tests.

The two new rows are V4.1 Q2/Q4 Metal candidates. Engram and expert SSD streaming
have an explicit required gate; no V4.1 CUDA/ROCm/CPU row is invented. The
[new-commit inventory](upstream/engine-deltas-2026-09-12.json) records every commit
in each displayed interval, with complete first-parent diff hashes. Source
freshness and a build PASS do not fill missing numerical or quality receipts.

For Qwen3.6, both full commit diffs affect only `dynamicmoeinference.md`.
The other 1,525 Git tree entries, including source, kernels, build rules and
test inputs, match the earlier pin. The document links to an external
implementation; no such runtime is imported or executed by this review.
This classification does not settle older main-to-fork integration questions.

## Run the checks

The model-free regression tests exercise real local Git histories, actual patch
conflicts, metadata subprocesses and the production release command with a tiny
bundle fixture:

```sh
make test-engine-upstream test-engine-pins test-engine-setup-unit
```

To inspect the compiled installer's pins without creating a window, loading a
profile or starting a model:

```sh
./dstudio --engine-pins
```

For admission, first prepare separate Git checkouts at the matrix's candidate
revisions, with the complete baseline-to-tip history. Do not point the command
at an archive directory inside another repository or repair a user's checkout
to make it pass. Each source checkout must have the expected origin and HEAD.

```sh
make check-engine-upstream \
  ENGINE_UPSTREAM_APP=./dstudio \
  ENGINE_UPSTREAM_FLAGS='--repo main=/path/to/review/main --repo laguna=/path/to/review/laguna --repo qwen35=/path/to/review/qwen35 --repo q36=/path/to/review/q36'
```

The check prints JSON and exits nonzero on failure. Use a new ignored output
path for each attempt; never replace a failed receipt with a successful retry.
`--offline` permits inspection but always rejects promotion because remote
freshness was not verified. Missing Git objects must be fetched separately into
the isolated review checkout; this checker does not fetch, apply patches,
build, reset or move HEAD.

`make dist-macos` first builds and smoke-tests the bundle, then checks its own
executable with platform `macos`, before creating the archive. It does not use
an older executable elsewhere in Applications. Every declared target is macOS,
so platforms `all` and `macos` select the same rows. A `linux` or `windows`
selection has no targets and fails with `MISSING_TARGETS`; those platforms are
outside the campaign.

## What admission verifies

- Exact remote tip, baseline ancestry and every commit in the recorded delta.
  Each target must classify changes as integrated, equivalent or not applicable,
  with a substantive rationale and hashed supporting evidence. Unresolved
  changes, rewritten history and missing objects block promotion.
- Candidate HEAD and origin. Git environment overrides cannot redirect these
  reads into another repository; archive installs cannot borrow a parent Git ID.
- SHA-256 of every declared adaptation/build input. `check: apply` also runs
  `git apply --check`; `check: reverse` verifies an actually applied patch.
  Hash-only inputs describe recipes/derived builds, not proof that a patch ran.
- Compiled installer commit and archive URL, obtained through the actual native
  metadata command. A missing Qwen27B installer cannot inherit a Qwen3.6 result.
- Required gate receipts for each target, bound to its engine revision and patch
  set. Missing, failed, unfinished, stale or modified evidence blocks admission.
  A retained failed gate cannot be hidden by adding a successful retry.
- Bounded diagnostics with complete totals and target rows, even when the list
  of individual errors is truncated. No failed target disappears from the report.

A qualification receipt has this shape; hashes below are placeholders, not
valid evidence:

```json
{
  "passed": true,
  "finished": "2026-09-08T00:00:00Z",
  "qualification": {
    "schema": "dstudio.engine-qualification.v1",
    "target": "main/macos/metal/qwen38-next-q4",
    "platform": "macos",
    "engineRevision": "<exact-40-character-commit>",
    "patchSetSHA256": "<hash-reported-by-the-checker>",
    "gate": "agent",
    "evidence": [{"path": "tests/.artifacts/example/results.json", "sha256": "<full-SHA-256>"}]
  }
}
```

New runners must emit this identity alongside the actual result. Do not rewrite
historical reports or wrap a known failure as a green result. The raw evidence
must retain requests, answers, settings, source/binary/weight identities and
failures appropriate to the gate. Reviewed public aggregates may link to hashes;
private prompts, PDFs, quotes and personal paths stay ignored.

## Limits

This is admission of **declared** changes and evidence, not an answer grader,
numerical oracle or complete build lock. It cannot establish that a source
review's judgment is correct, that an omitted combination was intentionally
excluded, or that arbitrary host/source changes outside the named inputs were
tested. The full inventory, independent graders, platform/driver and weight
identities, suite revisions, final source freeze and release review are still
required. Metal results do not qualify CUDA, ROCm or Vulkan, which are outside
the macOS-only campaign.

There is no new model-quality score or speed benchmark in this update.
