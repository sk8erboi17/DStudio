# Lumen Observatory — Night 04

A complete, responsive one-page site for a fictional public observatory programme. The final page is generated and audited locally at maximum reasoning/quality settings, then published as a static GitHub Pages artifact.

## View and run

Open `index.html` directly, or serve this directory with any static file server. No build step, package manager, analytics, remote font, or application backend is required. The reservation interaction is an explicit local demonstration and does not claim to create a real booking.

Published page: `__GITHUB_PAGES_URL__`

## Local generation pipeline

- DeepSeek Vision-Exp or GLM 5.3 sees source and rendered pixels through its matching native encoder. Its explicit `generate` or `edit` directive is dispatched directly; there is no secondary visual router.
- New stills use Ideogram 4 FP8 with the official Quality-48 sampler at full declared output size.
- Source-dependent edits use the full, non-distilled HunyuanImage-3.0-Instruct NF4-v2 checkpoint with BF16 critical layers, `think_recaption`, 50 diffusion steps, no routed-token dropping, and Tencent's official eager MoE implementation without a DStudio numerical forward.
- Hero motion uses the official MiniMax H3 FL2VA checkpoint through pinned native `h3.c`, at the Quality profile: all 50 transformer blocks, no denoiser reuse, 20 native steps, 1344×768, five seconds.
- The final HTML/CSS/JavaScript pass uses DeepSeek V4 Design at true Max thinking with a 393,216-token context, unlimited hidden reasoning and explicit expert SSD streaming off. Metal uses normal resident/lazy-mapped access without reducing context. Its deterministic artifact, browser, interaction, accessibility, responsive-layout, and critique gates must all pass.
- A kernel-owned lock serializes Ideogram, Hunyuan and MiniMax H3. The selected DS4 model yields residency when a separate media worker needs unified memory.

## Measured production time

All values below come from durable benchmark JSON, not UI estimates. `__PENDING__` is replaced only after the corresponding successful quality-gated run.

| Stage | Quality setting | Wall time | Peak process / accelerator memory | Result |
| --- | --- | ---: | ---: | --- |
| Native visual inspection | Selected model + matching encoder | Included in Design stage | Included in DS4 memory | __NATIVE_VISION_RESULT__ |
| Ideogram still generation | Quality-48, full resolution | __IDEOGRAM_TIME__ | __IDEOGRAM_MEMORY__ | __IDEOGRAM_RESULT__ |
| Hunyuan editing benchmark | Full Instruct, `think_recaption`, 50 steps | __HUNYUAN_TIME__ | __HUNYUAN_MEMORY__ | __HUNYUAN_RESULT__ |
| MiniMax H3 hero motion | Quality, 1344×768, 5 s | __H3_TIME__ | __H3_MEMORY__ | __H3_RESULT__ |
| DeepSeek site build and audit | Max thinking, DS4-only SSD streaming off | __DESIGN_TIME__ | __DESIGN_MEMORY__ | __DESIGN_RESULT__ |
| Complete measured pipeline | No overlapping heavyweight workers | __TOTAL_TIME__ | __TOTAL_MEMORY__ | Passed all mandatory gates |

Accepted-pipeline compute: `__ACCEPTED_COMPUTE_TIME__`. Additional compute
spent on outputs rejected or runs invalidated by a correctness gate:
`__REJECTED_COMPUTE_TIME__`. Total measured production compute including those
discarded attempts: `__ALL_COMPUTE_TIME__`. Rejected outputs are never reused in
the published page; their reasons remain in the private raw benchmark evidence.

## Benchmark hardware

- MacBook Pro (`Mac14,6`)
- Apple M2 Max
- 12-core CPU: 8 performance + 4 efficiency cores
- 38-core GPU
- 96 GB unified memory
- Local APFS storage; 1.6 TiB free at benchmark start
- macOS 26.5.2 (build 25F84)

No serial number, hardware UUID, account name, computer name, or other device identifier is included.

## Quality gates

The release gate covers pinned model/runtime revisions, full-quality profile contracts, byte-for-byte composition of the official Tencent MoE source, real finite MPS prefill/diffusion probes, no heavyweight-process overlap, native build/tests, semantic HTML, keyboard and Escape behavior, 44 px touch targets, visible focus, reduced-motion fallback, 390 px overflow, desktop/mobile renders, all visible controls, truthful local form state, media validity, native request-correspondence inspection, and a fresh Design critique of at least 8.5/10. Aesthetic acceptance is decided only in the composed site: an asset is regenerated or repaired only when it creates a concrete layout/design blocker there. Technical inference failures remain immediate blockers regardless of generation cost.

## Media and model terms

This repository is a non-commercial technical/design demonstration. Generated assets retain the terms applicable to their source models. Ideogram 4 is used under its [non-commercial model license](https://github.com/ideogram-oss/ideogram4/blob/main/model_licenses/LICENSE-IDEOGRAM-4-NON-COMMERCIAL); [HunyuanImage](https://huggingface.co/tencent/HunyuanImage-3.0/blob/main/LICENSE.txt) and [MiniMax H3](https://huggingface.co/MiniMaxAI/MiniMax-H3/blob/main/LICENSE) have their own community licenses and acceptable-use conditions. Review the upstream terms before reusing the generated media outside this demonstration.
