# Qwen — remaining implementation and qualification

Updated October 3, 2026. The full campaign remains incomplete and paused.

On October 3 the Qwen3.6 and Qwen3.8-27B engines changed: the vagrillo/ds4
fork (`ds4-qwen35`) and Ninnix/q36 were retired, and both models now run on the
bundled llama.cpp `b11371` (`99b9548`). Results below that name `q36` or
`qwen35` were measured on those retired engines and are history, not llama.cpp
results. The llama.cpp path has passed only the 10-check development gate
(`make test-llama-resident-live`) on each model.
The owner reserves the complete quality-suite rerun. This checkpoint removes
completed implementation tasks from the active backlog while retaining their
missing full-model acceptance checks.

The dated history, original failures, grader corrections, operator mistakes,
patch identities and scoped passing checks are preserved in
[the archived checkpoint](history/qwen-checkpoint-through-2026-10-01.md).
For the complete scope use [PLAN.MD](../PLAN.MD); for source/binary admission use
[engine-upstream.json](engine-upstream.json).

## Remaining work by model

| Model / recorded engine | Implementation still missing | Verification still missing |
| --- | --- | --- |
| Qwen3.8-27B / llama.cpp 99b9548 | Design on llama.cpp; persistent KV/session reuse across engine restarts. | Common-100 on llama.cpp, long context, Learn/Tutor, PDF, native desktop and multi-session/mode coverage. Chat/Agent/Cowork and one image case pass the development gate. |
| Qwen3.6-35B-A3B / llama.cpp 99b9548 | Design on llama.cpp; persistent KV/session reuse across engine restarts; the planned MLX alternative. | Common-100 on llama.cpp, long context, long-Agent continuation, Learn/Tutor, PDF/vision, native desktop and complete mode coverage. Chat/Agent/Cowork pass the development gate. |
| Qwen3.8-Flash-Next / main 0aaea5a | Independent Design and required native-vision adapters. | Learn/Tutor, PDF/vision, native desktop, complete mode/continuation quality and trusted full-model numerical references. Q2 requires its own qualification; Q4 results do not cover it. |

Complete Agent/Cowork build signatures, crash-safe pair publication and legacy
recovery through P2/P5. Preserve each engine's native session state, tokenizer,
reasoning/tool protocol and model/component identity; do not remove capability
rejection to make an unsupported path appear integrated.

## Full-model checks after the software corrections

The 27B parallel online-softmax overlay, 3.6 bounded batched-prefill overlay
and Q6_K correction belonged to the retired engines and no longer ship.
Preparation/catalog/dependency fixes, silent-prefill relay handling and removal
of automatic application work cutoffs remain implemented.

The remaining acceptance work is:

1. Verify the complete 27B and 3.6 models on llama.cpp `99b9548` using
   compatible model/quant references and the original long requests. Preserve
   the original frozen evaluation requirements and deadlines.
2. Run any invalidated complete corpus under the owner's supervision. Retain
   all original failed cases, source/weight/binary hashes and new run identity;
   do not transfer earlier scores to new inference paths or repeat an unchanged
   deterministic run as supposed evidence of improvement.
3. The retained 27B diagnostic replay targeted q36 `1305843`; it can no longer
   run. Replace it with a llama.cpp long-request check rather than reusing its result.
4. Complete Next Learn with the intended effective reasoning request. The
   retained incident generated 105,003 reasoning characters: the generator
   requested max despite an off launch. The diagnostic request harness is
   corrected, but no real off-request run establishes completion or a model loop.
5. Revalidate the v102 3.6 long-Agent timeout and partial-function overcount
   on llama.cpp. Preserve its earlier failure from the retired fork.
6. Complete native four-mode, vision/PDF, install/upgrade/recovery and desktop
   results, plus exact release receipts. Simulated UI/tool responses are separate.

## Retained complete corpus evidence — September 29

These complete receipts existed before the September 30 inference overlays.
The 27B and 3.6 rows were measured on the retired q36 and vagrillo/ds4 engines.
Scores retain wrong answers, formatting failures and context failures.

| Model | Passed / denominator | Long context | Private receipt under tests/.artifacts/engine-acceptance/ |
| --- | ---: | ---: | --- |
| 27B, q36 1305843 before online-F16 | 61/100 | 0/8 | run-LeDV72/q36-common-100/results.json |
| 3.6, original Q6_K shader comparison | 55/100 | 0/8 | run-9oQeuX/qwen35-common-100/results.json |
| 3.6, corrected Q6_K before batched prefill | 63/100 | 0/8 | run-KqWXoa/qwen35-common-100/results.json |
| Next, current-main single-file Q4 | 75/100 | 8/8 | run-l3Fevh/qwen-common-100/results.json |

The Next receipt identifies the new single-file Q4 weights, not the retired
fork/sidecar checkpoint: SHA-256
680944460a8cbe93ba8b6d7b6107213ffb7e22320bd913000e563ca0a0f25a8a.
Its corpus and eight long cases are no longer pending first execution.
The original-shader comparison also completed: its recorded shader hash matches
the pristine bundled 73434c4 source, while the corrected run records the applied
Q6_K overlay. Both use the same corpus identity; neither establishes batched-
prefill results. Incomplete/interrupted earlier runs remain separate in the
archive; their failures are not replaced by these runs.

Full source/patch/binary/model/component/settings identity remains in the
private receipts. These aggregate development/first-exposure results do not
qualify every mode, numerical equivalence, current inference overlays, Q2 or a
final release, and are not a speed comparison.

## Resume only the authorized work

Use existing commands and prerequisites in [tests/README.md](../tests/README.md)
and the exact current pins/patch stacks. Heavy runs are sequential, task-owned
and resource-bounded. The documentation cleanup does not start inference,
download weights, restart an app or resume the full campaign.
