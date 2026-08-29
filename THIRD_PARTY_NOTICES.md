# Third-Party Notices

This repository includes design-system content adapted from Open Design and
integrations that download optional third-party runtimes or model weights on
demand. Downloaded runtimes and weights are not committed to this repository.

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

## Open Design

- Source: https://github.com/nexu-io/open-design
- Copyright: 2026 Open Design contributors
- Imported from commit: `8123cc69808137ff765aad782e5eabf750249ca5`
- License: Apache License 2.0
- Local license copy: `third_party/open-design/LICENSE`
- Imported locations:
  - `extension/design-systems/*` entries with `ds4_upstream: open-design/...`

The imported Markdown pack files were modified for DStudio/DS4 by adding
`ds4_*` frontmatter metadata and local-first blueprint classification where
provider-backed workflows cannot run directly inside DS4. Modified imported
files carry a `ds4_modified_notice` frontmatter field.

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
