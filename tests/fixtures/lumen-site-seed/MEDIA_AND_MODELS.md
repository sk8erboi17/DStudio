# Media and model provenance

The published page is a non-commercial fictional design study. Its generated media was produced locally and is distributed with this repository only as demonstration output. Model licenses may impose additional restrictions; this file is not a substitute for reading those terms.

## Operational summary

| Provider | Installed runtime / disk class | Use in this site run | Loading rule |
| --- | --- | --- | --- |
| DeepSeek V4 Design | local 81 GB GGUF | HTML, CSS, interaction and final composed-layout gate | Runs alone at Max; explicit expert SSD streaming is off |
| Qwen3.8-27B Q8 | `~/.dstudio/qwen38-vision`, about 28 GB cached weights | Request-correspondence inspection and edit/new-image routing only | One-shot, only when the prompt or final layout needs it |
| Ideogram 4 FP8 | `~/.dstudio/ideogram4`, about 29.5 GB model package | New images explicitly requested by the user | One-shot after Qwen exits |
| HunyuanImage 3 Instruct NF4 | `~/.dstudio/hunyuan-image`, about 48 GB | Source-dependent edits explicitly requested by the user | One-shot after Qwen exits |
| MiniMax H3 BF16 | `~/.dstudio/minimax-h3`, about 134 GiB on disk | Explicit hero motion only | Native one-shot phases; never overlaps another model |

Do not search for provider setup during layout composition. A missing optional
inspection is non-blocking after PNG signature, decode and dimensions pass; it
must not be replaced with dominant-color, histogram or brightness analysis.

## Visual routing and inspection

- Model: `mlx-community/Qwen3.8-27B-8bit`
- Revision: `815b83c0df8ffd1d1b5244cf75fd6ef14fca9ef9`
- Role: sole edit/new-generation decision, official Ideogram structured-caption authoring, and request-correspondence inspection; aesthetic quality is gated only in the composed site layout
- Default used for the release: Max reasoning, no DStudio thinking/output budget

## New still images

- Model package: `Comfy-Org/Ideogram-4`
- Revision: `bbee2ab2b14b2b5223448d12d6e31e5f9cec0546`
- Upstream node: `ideogram-oss/ComfyUI-Ideogram4` at `c05545d71e61b7ce47534a972eaeefd958a3719f`
- Runtime: ComfyUI `b78cec879b9460d5cb25228a83a942fb78d2cd24`
- Apple Silicon FP8 kernel layer: `911294ca35093eef56f7f2695414ff8810e88e50`
- Quality: official Quality-48, Euler, 45 CFG-7 steps followed by exactly three
  CFG-3 polish steps; the boundary is derived from each resolution-aware sigma
  schedule, with a maximum 2048 px edge
- Footprint decision: the four pinned FP8/encoder/VAE files total about 29.5 GB;
  this is the public full-quality Ideogram 4 path that fits beside its Metal
  activations on the 96 GB reference machine. The public open-weight release
  exposes FP8 and NF4 packages rather than a dense BF16 checkpoint; FP8 was
  selected over NF4 for the highest available precision on this hardware
- Terms: [Ideogram 4 Non-Commercial License](https://github.com/ideogram-oss/ideogram4/blob/main/model_licenses/LICENSE-IDEOGRAM-4-NON-COMMERCIAL)

## Editing benchmark

- Full Instruct quantization: `EricRollei/HunyuanImage-3.0-Instruct-NF4-v2`
- Revision: `98fda5c508c05f5407f036bca413149ca92c143b`
- Official base: `tencent/HunyuanImage-3.0-Instruct`
- Base revision: `2ec2c78bee7d4b94157341fba86c4c2c7b1858b2`
- Quality: full 50 steps, `en_unified`, `think_recaption`, source-aligned
  resolution, no routed-token dropping, and no artificial reasoning-token cap
  below the model-native context
- Precision: NF4 expert/large linear weights; BF16 critical attention, VAE, vision, embedding, and final layers
- Apple-MPS conformance: compatible Transformers 4.57.1 receives only the later
  upstream MPS skip for its optional CUDA/XPU-style monolithic allocator warm-up,
  which otherwise attempts an invalid 77.32 GB temporary buffer before loading
  weights. SigLIP mask and spatial-shape tensors are co-located with the pixel
  tensor without changing values, shape or dtype. These are source-level bug
  fixes only: checkpoint weights, routing, quantization, tokenizer, scheduler,
  prompt and sampling remain unchanged
- MoE execution: the coherent MLP/gate/MoE block comes from the pinned official
  Tencent revision and uses its eager DeepSeek implementation. Every selected
  routed token is evaluated and combined with the official top-k weights;
  DStudio installs no numerical attention or MoE forward override. The runtime
  source is rebuilt byte-for-byte from immutable upstream inputs and real MPS
  probes require finite multimodal logits and a finite Quality-50 diffusion step
- Footprint decision: full BF16 weights are about 168.7 GB and INT8 weights
  about 88.8 GB before activations, so neither can run correctly in 96 GB.
  The selected full-Instruct NF4-v2 files are about 48 GB and preserve the
  checkpoint's declared BF16 exclusions; no distilled model is substituted
- Terms: [Tencent Hunyuan Community License](https://huggingface.co/tencent/HunyuanImage-3.0/blob/main/LICENSE.txt)

## Hero motion

- Model: `MiniMaxAI/MiniMax-H3`, official FL2VA checkpoint
- Revision: `9ac0dd7aabc2c651fcf0ace4c00b2bffd9c8c8a6`
- Native engine: `antirez/h3.c` at `8974cc055ea9c02fcd14cc27dfda3e1027c05153`
- Quality: 1344×768, five seconds, 20 denoise steps, all 50 transformer blocks, no denoiser reuse
- Delivery encoding: native H.264, CRF 18, YUV 4:2:0
- Terms: [MiniMax H3 Community License](https://huggingface.co/MiniMaxAI/MiniMax-H3/blob/main/LICENSE)

## Site build

- Model: local DeepSeek V4 Flash GGUF through DStudio Design
- Release mode: true Max thinking, 393,216-token context, explicit expert SSD streaming off, normal Metal resident/lazy-mapped path, no application hidden-reasoning token cap; reasoning stops only at EOS or the native context boundary
- The final benchmark report records the exact GGUF filename and runtime evidence.
