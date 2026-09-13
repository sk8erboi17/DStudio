# Which main updates can move to the other engines?

The useful shared improvements are **continuing an unfinished Agent response
after context compaction** and **retaining the right image context across tool
calls**. Neither is a blanket decode-speed increase. V4.1's Engram/tensor work
belongs to V4.1, not to Laguna or Qwen.

This review covers the six main commits from `f62ca29a` through `bd66c402`.
It does not close the older campaign-wide source comparison or model-quality
gates. [Every commit in the newly checked engine intervals is inventoried](engine-deltas-2026-09-12.json).
“Already included” below means source integration, not qualification of every
model/backend. The exact engine tips and tested scope are in the
[update checkpoint](../DS41_UPDATE_CHECKPOINT.md).

| Main change | Main / Qwen Next | Laguna / Qwen3.6 MoE fork | q36 / q27 candidates |
| --- | --- | --- | --- |
| `6546ae5`: opt-in programming hints | Included in both. Defaults and boundary injection are retained. | Portable Agent/UI behavior, but absent from these older native Agents; not backported in this update. | Latest q36 has its own adapted implementation. q27 is a model server, not this terminal Agent; hints belong to its client. |
| `81a7658`: live image context through tools | Included in both; Qwen Next also retains its later embedding-width fix. | Their pinned native public APIs do not expose this multimodal session/identity contract. A text-KV replay is not an equivalent image continuation. Requires a separate capability implementation, not a cherry-pick. | q36's review patch retains native fingerprints/pending-call matching and moves image preparation out of the parser lock; 40 actual Qwen27B HTTP/image/tool workflows pass across three APIs, including changed tool pixels. Full app/backend qualification remains open. q27 has a separate serving/weight format and cannot inherit this implementation. |
| `e33a5b2`: continue across compaction | Included in both. DStudio's PLD hooks preserve stop detection and the native remaining-token/lookahead limits. | Backported in Agent patch v99 with native BPE/ChatML framing, verbatim tail tokens and the same output budget. Native tokenizer and scripted loop checks pass; real-model continuation acceptance remains open. | Latest q36 has Qwen-specific continuation and image boundaries. Its source update remains unpromoted pending complete patch and real-model qualification. q27 relies on the connected Agent/client to compact its conversation. |
| `74fbe54`: release checklist | Upstream checklist retained. Its real-model vision/client and compaction gates remain separate from local model-free tests. | Test scenarios can be adapted only to actual declared capabilities; no imaginary vision PASS. | Use the corresponding native protocol/client tests; do not copy another runtime's PASS receipt. |
| `6289c51`: terminal hint styling | Included in both; DStudio's structured output keeps native transcript bytes. | Only useful together with the optional hint implementation; no inference change. | q36 has the corresponding terminal renderer. q27's HTTP stream has no terminal hint renderer to replace. |
| `bd66c40`: V4.1 Flash Metal | Main updated. Qwen Next does not need DeepSeek tensor shapes, tokenizer or Engram tables to run Qwen. | Not applicable to their model architectures. | Not applicable to Qwen's recurrent attention/PLE or q27's custom artifacts. It is not a general CUDA/ROCm/Metal acceleration patch. |

## Source checks behind the decisions

- Main's new `ds4_session_vision_prefix_matches` and
  `ds4_session_rebase_vision_state` require both the historical image identity
  and an independently authenticated live continuation. Literal image markers
  or matching text alone do not establish that identity.
- Qwen Next's Git ancestry includes main's pre-V4.1 changes. Reapplying those
  commits would duplicate or overwrite its native adaptations. Its snapshot
  allocation correction is a separate [DStudio patch](../../patch/ds4-qwen38-snapshot/README.md),
  not a transplanted DeepSeek decoder.
- Laguna and the Qwen3.6 MoE fork were compared at their actual source revisions,
  including `ds4.h`, Agent generation/compaction and server continuations.
  Their text continuation support is not the newer image-session contract.
- q36's new `request_tokenize_multimodal_prompt` encodes images while holding
  the inference mutex. The review patch now queues owned encoded bytes for the
  existing inference worker and copies a private visual checkpoint, revalidating
  the job and prior session before publication. Deterministic ownership tests
  preserve prior sessions and pending tools through failed/cancelled preparation.
  The subsequent real Qwen27B run passes its 40 HTTP/image/tool workflows;
  that bounded development corpus does not qualify the whole application or
  another model/backend. Its Metal attention source
  is unchanged by all three newly reviewed commits; earlier long-context failures remain open.
- q27's own native Metal operator suite exposed a pipeline threadgroup-limit
  failure on M2 Max. The [bounded column-tiling correction](../../patch/q27-metal-delta/README.md)
  passes unchanged upstream operators, 24 independent recurrence comparisons
  and patch lifecycle tests. This is q27-specific operator evidence, not proof
  that DStudio's Qwen GGUF can be loaded by q27 or that CUDA behaves identically.

## Transfer order

The real V4.1 SSD run and scoped q36 owner/vision rebase checks are now recorded
in the update checkpoint; neither closes the full model/application campaign.
Retain their original failures and remaining qualification gaps. For Laguna
and the older MoE fork, the implemented compaction continuation now needs
real-model acceptance; optional hint styling is lower priority.
New vision support requires its own end-to-end identity,
tool-continuation and model-answer qualification.

The source review first exposed an independent publication defect in those two
older Agents: they replaced the transcript and exported `MEMORY.MD` before the
rebuild was known to succeed, and did not reject cancellation arriving after
the last prefill callback. [Patch version 98](../../patch/ds4-agent-jsonl/README.md)
fixes this prerequisite with private preparation and a short owner commit.
The actual patched functions pass 14 deterministic ASan/UBSan cases per branch;
their frozen predecessors pass 4/14 on the same harness.

Version 99 adds the continuation itself. It keeps the open native renderer and
output budget across private compaction, closes only the private summary prompt,
and preserves the original tail token IDs. The new native-vocabulary tests cover
50 Laguna / 53 Qwen framing cases. The identical scripted generation-loop gate
improves from 4/15 to 15/15 for Laguna and 3/13 to 13/13 for older MoE, including
Stop, Unicode/code output, repeated memory export and incomplete-tool recovery.
It also exposed and corrected a second-compaction boundary defect caused by
re-importing just-exported memory into the system prefix. These tests execute
actual native tokenizers, loops and workspace effects with scripted model
outputs; they do not establish real summary quality, numerical equivalence,
long-conversation quality or backend parity.

The first real MoE continuation replay passes 4/6 scenarios. Its generated
200-function C output passes compilation and an independent executable oracle
across compaction, but manual compaction announces readiness too early and
piped Stop hides its service notice. Version 100 corrects owner quiescence and
notice delivery across all seven Agent variants. The same native barrier probe
improves from 8/20 to 20/20 on each older branch; the complete four-engine
consumer rebuild passes 77 stages with frozen input identities. These fixes
pass their control checks in the subsequent real-model replays. Those remain
failed overall: MoE 5/6 (invalid generated C return types), Laguna 4/6 (earlier
facts dropped by the first summary, then an absent prior-file invariant).
Laguna's post-Stop native tools do work. V101 retains explicit future-use facts
and prior applicable durable state in its private summary instructions, with
seven exact versioned deltas and passing migration to frozen v100 predecessors.
Real summary-fidelity acceptance is still separate. Details and original
receipt identities are in the update checkpoint.

No unsupported backend is enabled, no context/precision is silently reduced,
and no unresolved candidate is promoted to claim that all engines were updated.

Sources: [main compaction change](https://github.com/antirez/ds4/commit/e33a5b25389de7f83a60cdb4d254054372f68e16),
[main vision contract](https://github.com/antirez/ds4/commit/81a76585ff44e0494053fca9101130e2535648b9),
[V4.1 implementation](https://github.com/antirez/ds4/commit/bd66c402070042bf0a79ad6ece8242de4c93680c).
