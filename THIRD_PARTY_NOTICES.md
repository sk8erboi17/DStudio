# Third-Party Notices

DStudio's locally authored design systems — Folio, Signal, Forma, Grove, Pulse,
Market, Commons, Atlas and Canvas —
are included in [`extension/design-systems/`](extension/design-systems/) under the
[repository license](LICENSE). No third-party design catalog is bundled or
downloaded. The integrations below download optional runtimes or model weights
on demand; their notices and licenses still apply. Downloaded runtimes and
weights are not committed.

## ds4 (managed local inference engine)

- Source: https://github.com/antirez/ds4
- Pinned main commit: `bd66c402070042bf0a79ad6ece8242de4c93680c`
- Source license: [MIT](https://github.com/antirez/ds4/blob/bd66c402070042bf0a79ad6ece8242de4c93680c/LICENSE)
- Copyright: 2026 The ds4.c authors; 2023–2026 The ggml authors.
- DStudio adaptations: [`patch/`](patch/README.md).

Managed installs retain the upstream license. Model weights have their own
terms; the engine's license does not replace them. Optional Laguna and Qwen
engines remain separate checkouts with independently reviewed pins.

DeepSeek V4.1 GGUFs are downloaded separately from
[`antirez/deepseek-v4.1-flash-gguf`](https://huggingface.co/antirez/deepseek-v4.1-flash-gguf/tree/dd8a266f7145edc19e2334b46e19b6821f221dc7),
revision `dd8a266f7145edc19e2334b46e19b6821f221dc7`; that pinned model card
declares MIT. The upstream engine retains the provenance of the DeepSeek
tokenizer/Engram metadata and its source notices. Engram tables and any matching
vision weights are model components, not DStudio-authored assets.

### Qwen3.6 native engine fork

- Source: [`vagrillo/ds4`](https://github.com/vagrillo/ds4/tree/73434c4bb9d8bb18425a2577edada69d25d44c47).
- Pinned revision: `73434c4bb9d8bb18425a2577edada69d25d44c47` (documentation-only change from `60fca11f`).
- Source license: MIT, retaining the ds4.c authors and ggml authors' notices.
- DStudio's model-catalog correction is shipped as a reversible
  [patch](patch/ds4-qwen35-catalog/README.md), not an unrecorded fork edit.
- Its native Agent/Cowork candidate is an explicit
  [patch](patch/ds4-agent-jsonl/qwen35.patch). The Qwen tool parser is adapted
  from the MIT-licensed `ivanfioravanti/ds4-metal` source pinned below, using
  this fork's native ChatML/server format; inference kernels are not replaced.
- Model weights are downloaded separately and retain their own terms.

### Qwen3.8-Flash-Next native engine fork

- Source: [`ivanfioravanti/ds4-metal`](https://github.com/ivanfioravanti/ds4-metal/tree/ff4f0ff4fdff70d6b7c3941ef437b91dde960e14).
- Pinned source: `ff4f0ff4fdff70d6b7c3941ef437b91dde960e14`.
- Source license: MIT, retaining upstream ds4.c and ggml notices.
- DStudio's metadata-only PLE prefetch correction is supplied as a reversible
  [patch](patch/ds4-qwen38-inspect/README.md). It does not change inference.
- The structured Agent/Cowork adaptation is an explicit
  [patch](patch/ds4-agent-jsonl/README.md), applied to private build sources.
- The native [snapshot-allocation correction](patch/ds4-qwen38-snapshot/README.md)
  retains upstream math and prevents partial speculative state after an allocation failure.
- Main weights and the separate native PLE retain their own model terms.

### q27 (separate Qwen27B engine candidate)

- Source: [`signalnine/q27`](https://github.com/signalnine/q27/tree/8cd708389f8b5a2c5a7c481237b00c8d7f570e7f).
- Reviewed revision: `8cd708389f8b5a2c5a7c481237b00c8d7f570e7f`.
- Source license: MIT; Copyright 2026 Gabe Ortiz. The complete notice is
  retained with the [Metal DeltaNet adaptation](patch/q27-metal-delta/LICENSE).
- DStudio's [versioned patch](patch/q27-metal-delta/README.md) preserves native
  recurrence math while using 256-thread column tiles on Metal. It is an
  isolated engine candidate, not a qualified DStudio model or CUDA result.
- Custom q27-format weights and tokenizer data are not included or downloaded
  by this adaptation; their model terms remain separate.

### q36 / QuarkStar (Qwen27B installation candidate)

- Source and installer candidate: [`Ninnix/q36`](https://github.com/Ninnix/q36/tree/8362010a301b3360296e435703f58ffc230a024a).
- Previous audited base: `d67687ed15ad9f52b755a9b5fdfc0214ea937555`.
- Separately reviewed candidate: `d02b6a20a7662300003c859e186ceb5bec7aa849`,
  with a [macOS terminal adaptation](patch/q36-agent-tty/README.md) and
  [optional diagnostic patch](patch/q36-metal-diagnostics/README.md).
  These are not a promoted installer update or a long-context inference fix.
  A separate [bounded F16 attention candidate](patch/q36-f16-attention/README.md)
  retains the same upstream MIT terms; operator tests are distinct from its
  still-open complete-model qualification and installer promotion.
- Current candidate: `8362010a301b3360296e435703f58ffc230a024a`.
  The installer applies `next-review.patch`, `monitor.patch`,
  `monitor-owner.patch`, then `cache-usage.patch`, recording their identities
  and order. Native and
  targeted image/tool/cache tests pass, as do fresh installation and a scoped
  DStudio Chat/Agent/Cowork run. A scoped real legacy-install upgrade also
  passes with cache reuse; complete migration/failure coverage across engines
  and full model/application qualification remain separate requirements.
  Its worker-quiescence rule also informs DStudio's versioned native Agent
  readiness patches; the existing upstream MIT notice is retained.
- Source license: MIT; Copyright 2026 Nicolo' D'Evangelista, 2026 the ds4.c
  authors, and 2023–2026 the ggml authors.
- DStudio's native Metal operators are delivered in a reproducible
  [patch](patch/q36-metal-runtime/README.md), retaining the
  [full upstream notice](patch/q36-metal-runtime/LICENSE). The explicit CLI
  installer downloads the pinned source and applies the patch; application-mode
  and cross-backend qualification remain open.
- The Q6_K_XL language-model candidate and tested F16 vision component come from
  [`unsloth/Qwen3.8-27B-GGUF`](https://huggingface.co/unsloth/Qwen3.8-27B-GGUF/blob/4ca720788d1e01f1bff70c033e0d0028fd02e502/README.md),
  revision `4ca720788d1e01f1bff70c033e0d0028fd02e502`, whose model card
  declares Apache-2.0. Both are downloaded separately, not committed; exact
  filenames, sizes and hashes are pinned in `scripts/download-qwen27.py`.
  An encoder differential test is not full language-model qualification.

## Ideogram 4 FP8 (optional image-generation runtime)

DStudio downloads Ideogram 4 and its runtime on demand; neither code nor model
weights are vendored in this repository.

- Official source: https://github.com/ideogram-oss/ideogram4
- Pinned source commit: `990fe1c4e950bb9e9dc90e01c0ad98ba434f83c2`
- Source license: Apache-2.0
- FP8 model repack: https://huggingface.co/Comfy-Org/Ideogram-4
- Pinned model revision: `bbee2ab2b14b2b5223448d12d6e31e5f9cec0546`
- Model terms: [Ideogram 4 Non-Commercial License](https://github.com/ideogram-oss/ideogram4/blob/main/model_licenses/LICENSE-IDEOGRAM-4-NON-COMMERCIAL)
- ComfyUI source/commit: https://github.com/comfyanonymous/ComfyUI/tree/b78cec879b9460d5cb25228a83a942fb78d2cd24
- Ideogram node source/commit: https://github.com/ideogram-oss/ComfyUI-Ideogram4/tree/c05545d71e61b7ce47534a972eaeefd958a3719f
- Apple-Silicon FP8 compatibility source/commit: https://github.com/pawel-mazurkiewicz/ComfyUI-AppleSilicon-FP8/tree/911294ca35093eef56f7f2695414ff8810e88e50
- Install location: `~/.dstudio/ideogram4`

The compatibility node preserves the downloaded FP8 values while using a
Metal-supported compute representation; it does not replace the model with a
lower-quality checkpoint. Users are responsible for complying with the model's
non-commercial terms.

## HunyuanImage-3.0-Instruct (optional image-editing runtime)

- Official base model: https://huggingface.co/tencent/HunyuanImage-3.0-Instruct
- Pinned base revision: `2ec2c78bee7d4b94157341fba86c4c2c7b1858b2`
- Full-Instruct NF4 v2 quantization: https://huggingface.co/EricRollei/HunyuanImage-3.0-Instruct-NF4-v2
- Pinned quantized revision: `98fda5c508c05f5407f036bca413149ca92c143b`
- Model terms: [Tencent Hunyuan Community License](https://huggingface.co/tencent/HunyuanImage-3.0/blob/main/LICENSE.txt)
- Install location: `~/.dstudio/hunyuan-image`

The NF4 v2 repository declares the official full Instruct base and keeps its
VAE, attention projections, embeddings and other quality-critical layers in
BF16. DStudio uses it because the official BF16 and INT8 checkpoints cannot fit
the 96 GB unified-memory reference machine together with inference activations;
no distilled checkpoint is substituted. Runtime setup composes the eager
DeepSeek MoE block from the pinned official Tencent source revision and applies
the later upstream Transformers MPS allocator-warmup skip to the compatible
pinned loader. DStudio does not substitute a custom numerical attention or MoE
implementation.

## MiniMax H3 and h3.c (optional video runtime)

- Native engine: https://github.com/antirez/h3.c
- Pinned engine commit: `8974cc055ea9c02fcd14cc27dfda3e1027c05153`
- Engine license: MIT
- Official model: https://huggingface.co/MiniMaxAI/MiniMax-H3
- Pinned model revision: `9ac0dd7aabc2c651fcf0ace4c00b2bffd9c8c8a6`
- Model terms: [MiniMax H3 Community License Agreement](https://huggingface.co/MiniMaxAI/MiniMax-H3/blob/main/LICENSE)
- Install location: `~/.dstudio/minimax-h3`

DStudio runs the official checkpoint through the pinned native Metal engine,
not a hosted API. Users must review the current model terms and confirm that
their territory and intended use are authorized before download or generation.
DStudio does not redistribute the downloaded weights or grant model-use rights.

## Optional GSA Recon Tools

DStudio can install command-line tools and ProjectDiscovery nuclei templates
into the user's local app-data directory for authorized GSA runs. The binaries,
package environments, vulnerability databases and template checkout are not
vendored or committed in this repository.

The authoritative current inventory and install methods are maintained in
[`extension/gsa/tools/catalog.json`](extension/gsa/tools/catalog.json); the
managed-directory layout is documented in
[`extension/gsa/tools/README.md`](extension/gsa/tools/README.md). Each optional
download remains subject to its own upstream license and terms.
