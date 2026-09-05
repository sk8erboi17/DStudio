<div align="center">

<img src="assets/logo.png" width="80" alt="DStudio local AI studio for DeepSeek V4, GLM 5.3 Flash, Laguna S 2.1, Qwen3.6/3.8 and MiniMax H3">

# DStudio: Local AI Studio

**An open-source, local-first workspace for DeepSeek V4, GLM 5.3 Flash and Laguna S 2.1, with experimental Qwen3.6/3.8 Chat: private conversations, coding and knowledge-work agents, document research, visual design, images and MiniMax H3 video. A cloud account is optional.**

![license](https://img.shields.io/badge/license-BSD%203%20Clause-blue)
![platform](https://img.shields.io/badge/platform-macOS_%7C_Linux_%7C_Windows-black)
![inference](https://img.shields.io/badge/inference-local_by_default-success)
![models](https://img.shields.io/badge/models-DeepSeek_V4_%7C_GLM_5.3_%7C_Laguna_%7C_Qwen3.6%2F3.8-orange)
![ui](https://img.shields.io/badge/UI-native_C_%7C_no_Electron-brightgreen)
![agents](https://img.shields.io/badge/workspaces-chat_%7C_agent_%7C_cowork_%7C_design-purple)

</div>

## Contents

- [Latest changes](docs/changes/2026-09-05.md)
- [Install](#install-on-macos)
- [Supported models and limitations](#supported-models-and-limitations)
- [What DStudio can do](#what-you-can-do)
- [Modes](#modes)
- [Check PDF sources](#check-pdf-sources)
- [Prompt lookup: real-engine results](#prompt-lookup-real-engine-results)
- [Native Agent or Task Graph](#native-agent-or-task-graph)
- [50 diverse tasks with Pi and OpenCode](#50-diverse-task-comparison-dstudio-pi-and-opencode)
- [Why automatic checks help](#why-automatic-checks-help)
- [Requirements](#requirements)
- [Development](#development)
- [Real installation and inference checks](#real-installation-and-inference-checks)
- [Project layout](docs/PROJECT_LAYOUT.md)
- [Network access](#network-lan)
- [How it works](#how-it-works)
- [Contributing](#contributing)

DStudio turns [ds4](https://github.com/antirez/ds4), antirez's native local inference engine, into a complete desktop AI workspace. One UI combines private Chat, evidence-backed Learn paths and Tutor rooms, Agent with Plan/GSA/RSA workflows, document-focused Cowork, a gated Design studio, local image understanding/generation/editing and optional MiniMax H3 video. Model execution, project files and generated artifacts stay under the user's control by default.

Network access is still explicit and documented. Installation and model setup download source archives and weights from GitHub or Hugging Face; Web Search, Learn links and Deep Research read public websites; and the optional DeepSeek API backend sends the selected Chat, Learn, Agent, Cowork or Design requests to DeepSeek when the user supplies an API key. DStudio has no telemetry and does not require a cloud account for its local inference path.

In plain terms: DStudio is a **multi-model ds4 GUI**, a **private coding and knowledge-work environment**, and a **local research, media and design studio** packaged as one open-source project.

On macOS it ships as **DStudio.app**: double-click from Finder, no Terminal. On Windows it ships as a portable folder with `DStudio.exe` and the DS4 runtime binaries. The UI is a single vanilla `index.html` embedded in a small C launcher, so there is no Electron bundle, no framework build step, no CDN and no telemetry.

**Latest source update — September 5:** experimental Qwen3.6 Chat and verified,
resumable downloads; a searchable model picker that chooses the engine for you;
clear model-loading feedback and working Settings controls; fixes for native
vision and short prompt blocks with SSD streaming. The SSD fix does not require
reducing the configured 128k context. See the [complete change and test notes](docs/changes/2026-09-05.md),
including what has **not** been validated. A source push does not replace older
downloaded app releases.

## Install on macOS

Download the Apple Silicon zip from [GitHub Releases](https://github.com/sk8erboi17/DStudio/releases), extract it and move **DStudio.app** to Applications. The app is ad-hoc signed but not Apple-notarized (notarization requires a paid Apple Developer account), so Gatekeeper may warn that Apple cannot verify it. To open it the first time:

1. **Right-click** DStudio.app → **Open** → **Open** in the confirmation dialog, or
2. [**System Settings → Privacy & Security → Open Anyway**](https://support.apple.com/guide/mac-help/mh40616/mac), or
3. from Terminal: `xattr -cr /Applications/DStudio.app` (clears the download quarantine).

The warning appears only because the app is not notarized; the build is reproducible from this source and ad-hoc signed.

**Easiest install (no paid Apple Developer account)** — this downloads the release, verifies its SHA-256, removes the download quarantine and installs to `~/Applications`:

```sh
bash <(curl -fsSL https://raw.githubusercontent.com/sk8erboi17/DStudio/main/scripts/install-macos.sh)
```

Or use the DMG from the release: open it and drag **DStudio.app** into Applications, then open it once with right-click → Open.

The first-run screen installs the pinned `ds4` engine into `~/Library/Application Support/DStudio`, then offers the supported GGUF models with their real download sizes. The default Flash transfer can be stopped and resumed after a restart, and DStudio verifies its exact size and SHA-256 before completion. Engine source, models and optional tools stay outside the signed app bundle, so updating or moving `DStudio.app` does not delete them.

The regular `chat-v2` Flash GGUF and the similarly sized community **abliterated** Flash GGUF are separate models. DStudio does not describe the latter as universally “uncensored”: its [model card](https://huggingface.co/apetersson/DeepSeek-V4-Flash-0731-Abliterated-DS4-Headroom128) calls it an experimental refusal-direction edit and says that refusal-removal validation is still pending. Treat `abliterated` as the model variant, not as a guarantee about every response.

To build from source instead:

```sh
make
open DStudio.app        # macOS
# or: ./dstudio         # Linux/headless workflows
```

Windows users should use the portable zip and run `DStudio.exe`.

On first launch, DStudio runs a local system check for the managed engine, selected
model, Chat and Agent/Cowork/Design runtimes, Cowork Office bridge, Web Search and
network state. Missing pieces show a direct **Choose**, **Download**, **Install**,
**Start** or **Settings** action.

## Supported models and limitations

**Listed here means integrated, not equally tested.** “All four modes” means
Chat, Agent, Cowork and Design. This is the current source-tree support, not a
promise that an older downloaded release includes every integration.

| Local model | Available modes | Important limits |
| --- | --- | --- |
| DeepSeek V4 Flash | All four modes | Standard checkpoints are text-only; the optional abliterated variant is experimental. |
| DeepSeek V4 Flash Vision-Exp | All four modes, with images | Experimental; requires its matching vision encoder. |
| DeepSeek V4 Pro | Integrated in all four modes | About 430 GB of weights; not validated on the reference 96 GB Mac. |
| GLM 5.3 Flash | All four modes; images with its encoder | Uses the main engine, not a separate GLM checkout. Full-model QA for the M2 optimization remains open. |
| Laguna S 2.1 | All four modes, text only | Experimental, macOS Metal; requires resident weights and cannot force expert SSD streaming On. |
| Qwen3.8-Flash-Next | **Chat only** | Experimental. Agent, Cowork, Design and vision are not integrated. Main weights stay in RAM; its required PLE file stays on SSD. |
| Qwen3.6-35B-A3B | **Chat only** | Experimental, macOS Metal. The supported Q6_K_XL file is 31.8 GB, all in RAM; no PLE is needed. Build/integration tested, real inference not yet validated in DStudio. |

Qwen automatically uses expert SSD streaming **Off**, even if **On** was saved
for DeepSeek. This does not disable Qwen3.8's SSD-backed PLE or erase the preference
used when switching back to DeepSeek.

Separate media workers provide **Ideogram 4** image generation,
**HunyuanImage 3** image editing and **MiniMax H3** video; they are not chat models.

The latest real-model acceptance run covered Flash, Laguna and Qwen3.8, with
**11/12, 10/12 and 12/12** checks passed respectively. The failures remain
published. These are small functional checks, **not evidence that DStudio
matches or beats state-of-the-art cloud systems**. That requires a matched
end-to-end comparison using the actual local weights, runtime and tools.
See [results and limitations](docs/ENGINE_ACCEPTANCE.md).

From the project root, use one download entry point:

```sh
./download-model.sh --help
./download-model.sh ds4f-q2      # DeepSeek Flash
./download-model.sh laguna-q4   # Laguna
./download-model.sh qwen38-q4k  # Qwen base + required PLE, about 105.4 GB
./download-model.sh qwen36-q6   # Qwen3.6 Q6_K_XL, about 31.8 GB, no PLE
```

Choose one target; these commands download real, large model files. Existing
weights stay in the shared `ds4/gguf/` store.

## What You Can Do

- Run **DeepSeek V4, GLM 5.3 Flash or Laguna S 2.1 locally**, or use **Qwen3.6-35B-A3B / Qwen3.8-Flash-Next in Chat**, through the same native desktop interface and unified GGUF picker.
- Use a **private AI chat** with persistent KV cache, reasoning display, citations from optional Web Search and local history.
- Use **Learn** to build an interactive learning path from a goal, PDFs and source links, with prerequisite ordering, exercises, checkpoints and locally saved progress.
- Open a dedicated **Tutor** for any roadmap block, with that block's prerequisites, sources, exercises and conversation restored automatically.
- Run **Web Search or Deep Research** through DStudio's local browser/search helper, with read-page evidence and source cards.
- Send image pixels directly to **DeepSeek V4 Flash Vision-Exp** or **GLM 5.3 native vision** in Chat, Agent, Cowork and Design. Older DeepSeek checkpoints and **Laguna S 2.1 are strictly text-only**. Generate directly with **Ideogram 4 FP8** or edit source pixels directly with **HunyuanImage 3 NF4**.
- Generate text-to-video or image-to-video clips with synchronized audio through the optional local **MiniMax H3** pipeline.
- Use a **local coding agent** that reads, edits and verifies files inside a folder you choose.
- Let Agent **add checks automatically for workspace actions**: no Task Graph toggle is required, while ordinary questions keep the direct path.
- Use **Cowork** for source-grounded spreadsheet, PDF, document and presentation work with native Office tools and no arbitrary shell.
- Toggle **Plan** to produce a decision-ready Markdown execution plan without modifying the project.
- Create and load **Skills**: private instruction packs authored by the current user for Agent, Cowork and Design.
- Run **Guided Security Analysis (GSA)** for authorized reviews, or **Reverse Structure Analysis (RSA)** to turn public website evidence into a labeled `STRUCTURE.MD`.
- Generate and refine complete interfaces with **ds4-design**, deterministic desktop/mobile checks, visual review and export gates.
- Select an optional **DeepSeek API** backend while all Agent, Cowork, Design and security tools continue to execute locally.
- Keep the engine private while still reaching the UI from another device on your LAN.

## Modes

A sidebar switches between Chat, Agent, Cowork, Design and Learn. Plan, GSA and RSA are explicit Agent workflows; Tutor rooms live inside Learn, while image/video generation is routed from Chat and Design. Every mode has reopenable local history, and every Agent, Cowork or Design conversation owns an independent on-disk KV session.

Local DS4 launches default to explicit expert **SSD streaming Off** while DS4 is
the sole heavyweight model. Metal uses full residency when the complete launch
fits and the engine's normal lazy memory-mapped path otherwise; DStudio does
not reduce the requested context to force residency. **On** remains available
as an explicit restart-time setting for compatible models. Qwen keeps this Off
with resident weights; only Qwen3.8 has a separate SSD-backed PLE. Laguna also requires resident weights.
Ideogram, Hunyuan and H3 are one-shot
workers: DStudio evacuates DS4 before loading one and restores it only
after that worker exits.

### Chat

<div align="center">

<img src="assets/demo.gif" width="820" alt="DStudio Chat demo showing local DeepSeek V4 chat, file generation and canvas preview">

</div>

Streaming chat backed by the selected local GGUF and ds4 server KV cache: context lives server-side (prefix reuse is shown as *cached* tokens) and every message is saved locally. You get live tokens/s, collapsible reasoning, native MathML for LaTeX, syntax-highlighted code, file artifacts, image/PDF attachments and optional Web Search sources through the local browser. A configured DeepSeek API key can replace local inference without moving DStudio's workspace tools into the cloud.

The composer model picker has search, quantization/size details and a highlighted current model. Choose a model and DStudio selects its matching engine automatically — no separate engine-branch selector. Model download progress stays in Settings → Models.

With DeepSeek Vision-Exp or GLM 5.3 and the matching encoder installed, image attachments stay multimodal: DStudio sends PNG/JPEG pixels to `ds4-server`; Agent/Cowork use upstream `view_image`, and Design uses its native `see_image` implementation. There is no text-description detour or secondary visual model. Selected PDF pages can use that same active encoder; older DeepSeek checkpoints and Laguna expose no image tools and remain text-layer-only for PDFs.

### Check PDF sources

For newly read PDF attachments in local Chat, DStudio adds a source-checking workflow inspired by [NanoIndex](https://github.com/NanoNets/nanoindex):

- **See where a quotation comes from.** Click a PDF citation in the answer to open the original physical page, with the exact words highlighted. Zoom in for small text or tables.
- **Handle repeated references.** If the model uses `[P1]` for several passages, the modal lets you choose the intended passage instead of guessing. Identical entries are merged. Internal evidence JSON is hidden, including malformed output; unreadable source details show an explanation, not a verification badge. Saved replies are reparsed too.
- **Know when a source cannot be located.** Missing or repeated quotations are reported without selecting a misleading highlight. An image-only page can be opened, but this feature does not run OCR.
- **Move around the document.** The attachment preview offers recognized numbered chapter/section headings, nested section hints and explicit “see section…” links. These are text-based hints, not a complete outline or a semantic knowledge graph.
- **Check the arithmetic.** “Check passages and calculations” first locates the cited passages, then recalculates supported sums, differences, products, ratios and percentages using the quoted numbers. It shows the operands, sources, rounding and any difference from the answer. It does not verify units, whether the right numbers were chosen, or the answer’s interpretation.

The existing hybrid PDF search remains in place. No extra model or cloud OCR service is added. Citations and calculations appear when the answering model supplies the structured source information; unsupported or malformed output is not silently marked as verified.

Original PDFs are kept in a local cache, limited to **32 documents / 2 GiB**, alongside the existing PDF caches. Source identity is checked against the PDF bytes. If an original has been evicted or changed, DStudio asks you to attach it again. This first version is **host-local on macOS/Linux**, not exposed to LAN clients; Windows PDF support is unchanged. It needs Poppler and `shasum` or `sha256sum`.

Implementation checks run with **no language or embedding model loaded**: `make test-pdf-evidence` exercises real Poppler extraction/rendering, citation matching, document identity, calculations and the browser viewer. It requires Node, Playwright and Chrome (or `DSTUDIO_TEST_BROWSER=webkit` with WebKit installed). Repeated citation IDs never silently select a numeric source for arithmetic checks. These are implementation tests, **not an end-to-end model-quality benchmark**.

### Learn — interactive learning paths

<div align="center">

<img src="assets/roadmap.gif" width="820" alt="DStudio Learning Roadmap demo showing roadmap generation, editable learning blocks and focused tutor rooms">

</div>

Describe what you want to learn and optionally attach PDFs, notes or public links. Every Learn path starts with mandatory Deep Research—even when the prompt contains no link. Discovery tries Google first in DStudio's Chrome session. If Google renders an anti-bot page, that attempt is recorded as failed and discovery continues through Brave, Bing and DuckDuckGo; every search page and every selected source is opened exclusively through CDP. The Learn path never uses Bing RSS, static DuckDuckGo HTML or `curl`. DStudio filters low-value results, selects a strong and diverse set of pages, opens them in Chrome and extracts evidence from the rendered content; dynamic or lazy-loaded pages are scrolled until their text, links and content blocks stabilize before extraction. DStudio searches for authoritative curricula, official/current documentation, prerequisite evidence, practical exercises, assessment criteria and common learner pitfalls; supplied links and local PDFs are included as evidence but never treated as the entire research plan. Only after at least five substantial pages from four independent hosts and fifteen grounded curriculum facts pass the deterministic floor does a semantic judge decide whether the actual knowledge gaps are closed. Its output is not given an arbitrary token or array cap, malformed JSON is retried without shortening the verdict, and failed browser reads do not count as research progress. DStudio then passes the complete evidence bundle directly to the Thinking max curriculum generator—there is no redundant prose-report generation between research and curriculum synthesis.

The generated path records explicit cross-topic prerequisites, key concepts, effort estimates, observable outcomes, substantial practice, mastery checks, stage objectives, integrated checkpoints and a final project with concrete deliverables. It does not use a preset topic catalogue or fixed stage/topic quota. Granularity follows the researched subject and learner goal: a broad field with several independent outcomes or prerequisite chains becomes multiple stages or branches, while a narrow skill remains a compact block or path; stage sizes may differ and filler is never added to meet a count. Roadmap generation does not send an arbitrary `max_tokens` cap: Thinking max and the final JSON may use all space left in the loaded model's physical context window. A structural quality gate first rejects shallow, physically truncated or malformed drafts. DStudio then runs a separate adversarial factual audit on every stage, followed by a global pass that looks for contradictions across stages, exercises, assessments and the capstone. High-confidence findings trigger a complete repair and the entire factual audit runs again. Only a factually clean draft reaches the independent curriculum judge, which evaluates coverage, sequencing, granularity, practice, assessment, personalization, source use and capstone quality without taking over fact-checking. A curriculum repair is audited again from the factual stage; the loop ends only when both responsibilities pass or the learner presses **Stop**. The result opens directly as an editable graph inspired by [roadmap.sh](https://roadmap.sh/) rather than as a conventional assistant reply: blocks can be completed, reordered with drag-and-drop, or deleted. Adding a block sends its title, description, stage and neighboring prerequisites back to the model with Thinking max so it can create a coherent outcome and hands-on exercise instead of inserting placeholder text. Block generation uses a large output budget and automatically repairs and retries incomplete drafts until it obtains a valid block or the learner presses **Stop**. The edited graph is saved with that roadmap's history and can be exported as high-resolution PNG, PDF or JSON.

#### Study with a dedicated Tutor

<div align="center">

<img src="assets/tutor.png" width="920" alt="DStudio Tutor study room opened from a Roadmap block, with focused context, visible reasoning and the full chat composer">

</div>

Every stage, topic and final project has a **Study** button. Clicking it opens a dedicated full-screen Tutor chat for that exact block, without the Roadmap sidebar getting in the way. The Tutor already receives the roadmap goal, stage, prerequisites, learning outcome, practice task and source context, so the learner does not have to explain the subject again. It can teach from first principles, answer follow-up questions, give guided and independent exercises, run quizzes, identify gaps and correct the learner's work. **Back to roadmap** returns to the graph without losing the study conversation.

The Tutor keeps the normal Chat toolset while remaining focused on the selected learning objective: selectable and visible Thinking, drag-and-drop files, local PDF and image understanding, LaTeX, aligned ASCII diagrams, collapsible hints and generated-file canvas previews. Each block owns its transcript and attachments, so opening **Study** again resumes the same lesson and progress instead of starting a generic chat.

Learn generation and both verification roles are always locked to **Thinking: max**. Local ds4 requires at least 393,216 context tokens for Max rather than its High fallback, so DStudio temporarily launches the Learn pipeline at that threshold when the saved Chat context is smaller. This launch override is not persisted: the learner's normal Chat context setting remains unchanged and is used again by the next ordinary Chat request. Cloud inference receives the explicit Max request directly.

## Multimodal PDFs

<div align="center">

<img src="assets/pdf.gif" width="820" alt="DStudio multimodal PDF demo showing local document understanding and semantic page retrieval">

</div>

Attach a PDF and ask naturally in any language. The active model decides whether to build a bounded whole-document overview, read an exact physical page or search semantically across every page. DStudio extracts text locally and uses the small pinned **Qwen3-Embedding-0.6B only as a text embedding index**, never as a visual router. With DeepSeek Vision-Exp or GLM 5.3 active, DStudio additionally renders up to four selected physical pages and sends those pixels to that same model's native encoder. Laguna and other text-only checkpoints receive only the extracted text and explicitly report any scanned/image-only pages they could not interpret. The cached text index keeps prompts bounded even for 1,000-page books.

## Local Image Generation

<div align="center">

<img src="assets/generating.png" width="820" alt="DStudio local image-generation pipeline showing live model preparation and generation progress">

</div>

Ask for an image naturally in any language. DeepSeek Vision-Exp or GLM 5.3 interprets the request and any source pixels itself, then emits an explicit `generate` or `edit` directive. DStudio dispatches `generate` directly to Ideogram 4 FP8 with its official 48-step Quality profile, and `edit` directly to the full, non-distilled HunyuanImage-3.0-Instruct model. Text-only models cannot issue source-dependent edits. Hunyuan uses NF4 so it fits the 96 GB reference Mac while critical layers and compute remain BF16; it runs `think_recaption` and 50 diffusion steps through Tencent's official eager DeepSeek MoE implementation with no routed-token dropping or custom numerical forward.

The reply gets a placeholder immediately while DStudio reports real load, reasoning, sampling and decode phases. Quality is fixed at Ideogram Quality-48 or Hunyuan full-50: there is no Turbo, distilled or smaller-model fallback. One kernel-owned lock serializes Ideogram, Hunyuan and H3, while the media-memory lease temporarily evacuates a resident chat/Design model when required. Generated files stay local and are attached to the conversation for later edits.

## Local Video Generation (MiniMax H3)

DStudio runs the downloadable MiniMax H3 weights through a pinned [antirez/h3.c](https://github.com/antirez/h3.c) checkout: a native C/Objective-C engine built directly on Metal, MPSGraph and Accelerate. ComfyUI, PyTorch and third-party custom nodes are not part of video inference. Ask for a video in Chat; DStudio routes the request to the one-shot native executable, optionally uses a recent attached image as the first frame, reports h3.c's real phase/denoise callbacks and returns a locally streamed MP4. You can also ask DStudio to **create an opening image and then animate it**: the still goes directly to Ideogram 4, is kept in the conversation, and is then passed to h3.c. No hosted generation API is used.

> **Working in progress — two-photo H3 references.** With MiniMax H3 selected in the composer, one attached image remains an opening-frame anchor; two attached images are ordered Ref2VA inputs exposed to the model as `<Picture 1>` and `<Picture 2>`. Settings includes a separate preparation action for the official Ref2VA transformer (about **61.7 GiB / 66 GB** in addition to FL2VA) while reusing the existing encoder and VAE files. This path is currently experimental and has not yet completed end-to-end validation in DStudio.

Open **Settings → Video** before the first generation. Review the upstream terms, confirm that your territory and intended use are authorized, then select **Prepare local H3**. Setup checks out and compiles an immutable h3.c revision without loading the engine, then downloads only the official `FL2VA/` files required for text/image-to-video. That original BF16 snapshot is about **134 GiB (144 GB)** on disk; partial files resume automatically. The managed runtime lives at `~/.dstudio/minimax-h3`; prompts, source frames and generated videos stay on this Mac. Existing converted ComfyUI checkpoints are a different layout and are not reused or deleted.

H3 has its own [Community License Agreement](https://huggingface.co/MiniMaxAI/MiniMax-H3/blob/main/LICENSE), including territorial, commercial and acceptable-use conditions. DStudio does not grant authorization; it requires an explicit confirmation before downloading or generating. Native h3.c requires MiniMax H3's official BF16 Qwen-family text encoder and checkpoint layout; this is an internal H3 component, not DStudio's removed visual router. During generation DStudio releases the chat model once, runs direct Ideogram opening-frame generation when requested, then launches h3.c. The upstream engine loads and releases its encoder, transformer and decoders in separate phases.

Three render profiles expose h3.c's native controls. **Quality is the default**: it uses all 50 blocks, no denoiser reuse and documented 768p-class output sizes. **Balanced** uses the upstream validated controls `--layers 45 --reuse 2` at roughly 512-class dimensions. **Preview** keeps 20 steps but uses 40/50 DiT blocks, whole-denoiser reuse 3 and a reduced internal canvas that is upscaled to the selected output size. The user can change profiles in Settings, but DStudio never changes one automatically to save time; a lower profile is used only when the user selects it or when a reproducible engine bug is explicitly reported. Video cost grows sharply with pixel area and duration, so Quality can take substantially longer. M3 and older GPUs automatically use h3.c's portable BF16/MPS path; M5-class hardware can select its native Metal 4/TensorOps paths. The progress card remains in conditioning until h3.c emits denoise progress, then shows actual completed native steps and derives an ETA from measured step time.

## Search & Deep Research

<div align="center">

<img src="assets/search.gif" width="820" alt="DStudio Search and Deep Research demo showing live web evidence, citations and source cards">

</div>

Search runs through DStudio's local web helper, not a hosted browsing service. **Web Search** is the fast mode: it plans targeted queries, reads the best pages, extracts facts and answers with clickable citations. **Deep Research** uses the same tools with a longer evidence loop: classify the request, search, read primary sources, extract facts, judge sufficiency, synthesize a grounded report and keep the source cards attached to the answer.

### Agent

<div align="center">

<img src="assets/agent.gif" width="820" alt="DStudio Agent demo showing the local coding agent editing and validating files">

</div>

`ds4-agent` becomes a local coding agent: it reads and edits files, runs commands inside a working directory you choose, streams its answer while it works, folds private reasoning into a **Thought** disclosure and groups structured tool calls/results into a compact action timeline. Every user turn has a copy control that returns the exact visible prompt even while the transcript is updating. The session header always shows the active mode, model and working folder; `/help`, `/list`, `/save`, `/new` and `/compact` remain available below the composer. A post-edit verifier catches common syntax errors immediately, so the model can repair broken code in the same turn. The same surface exposes Plan, GSA and RSA without silently turning any of them into an unrestricted autonomous mode.

Thinking defaults to **high**. Selecting **max** below its real 384k-token engine threshold explains the required context and estimated Metal residency cost before restarting; declining changes nothing, while leaving max restores the user's previous context. Existing video-quality choices and other saved Settings are preserved during that migration.

**Prompt lookup (experimental, Chat / Agent / Cowork).** The managed runtimes can
reuse text or code already in the conversation as candidate output, checked by
the same local model. This can help when editing existing code or preserving
passages from a document; it does not invent new answers faster. The default
keeps normal generation unchanged; accelerated batching is not enabled by
default. No extra model is needed.
See [modes, limits and model-free tests](patch/ds4-agent-jsonl/PLD.md).
An opt-in [real-engine benchmark](extension/prompt-lookup/bench/README.md)
compares Chat, Agent and Cowork on matched tasks, checks the actual outputs
and records executed batches. It does not run with the fast tests.

#### Prompt lookup: real-engine results

**The clearest benefit was in Chat; it was not a general Agent speedup.**
We ran the actual DeepSeek V4 Flash engine on an M2 Max with 96 GB, with
**Minecraft left running and SSD streaming off**. These are shared-desktop
measurements, not a promise of the same speed on an idle Mac.

The suite ran **78 tasks: 13 different cases × 3 modes × 2 repetitions**.
The modes were PLD disabled, the current default, and experimental accelerated
PLD. Correctness came first: faster but incorrect results did not count as
speed wins.

| Workspace | Checks passed in each mode | Experimental PLD vs disabled, in this run |
|---|---:|---|
| Chat | 14/14 | **2.84× observed speed**, comparing the same correct outputs |
| Agent | 6/6 | **About the same overall**; long copies helped, new code did not |
| Cowork | 2/6 | No useful overall conclusion: document-fidelity failures remained |

<div align="center">
  <img src="assets/README%20images/benchmarks/prompt-lookup-minecraft-real-engine.png" width="1100" alt="Real engine tests with Minecraft running: Chat passes 14 of 14 per mode with 2.84 times observed experimental speed; Agent passes 6 of 6 with essentially unchanged speed; Cowork passes 2 of 6 in every mode. Shared-host timings are not an isolated speed guarantee.">
</div>

In practical terms, median time for copying the Chat text fell from **30.0 to
12.3 seconds**. An Agent file copy fell from **86.0 to 75.0 seconds**, but its
small edit stayed around **36.7 seconds**, and creating a new function became
slower: **21.8 to 28.3 seconds**. These are individual task examples, not a
universal acceleration claim.

**66/78 checks passed.** The 12 failures were the same Cowork copy/revision
cases in every mode: the final newline was lost. No additional failed task
or different output artifact was observed with PLD, but **correctness did not
improve**, and a small suite cannot guarantee equivalence on other requests.
Cowork's speed figure uses only two successful pairs, not its failed copies.
Batch acceleration therefore remains experimental and opt-in.

See the [full method and per-task results](extension/prompt-lookup/bench/README.md)
and [measured data](extension/prompt-lookup/bench/results/2026-09-05-m2-max-minecraft-no-ssd.json).
The speed chart shows the median of matched per-task time ratios; it is not
the ratio of the overall median times. Variable game/desktop load can affect
those ratios, including controls where no accelerated batch ran.

### Cowork

Cowork turns the same local DS4 engine into a knowledge-work partner for a folder of real files. It can inventory and read PDF, DOCX, PPTX, ODT, RTF, Markdown and text sources; inspect/read/write XLSX, CSV and TSV data; create verified documents, paginated PDFs and 16:9 presentations; and reopen its outputs before reporting completion. Its attachment flow matches Chat: dropped files appear as clean preview tiles under the user message while tool-only paths stay out of the visible transcript. Uploaded names are sanitized, macro-enabled formats are rejected, writes are atomic and native read surfaces are confined to the selected workspace, including symlink and traversal checks.

The Office bridge is a small standard-library Python helper invoked through `fork` + `exec` with a bounded JSON request—there is no command shell or arbitrary Python execution in Cowork. Its dedicated `write_pdf` operation creates a valid paginated PDF directly, so the model no longer needs to look for `bash`, LibreOffice or an external converter. Spreadsheet cell text and extracted document/PDF text are framed as untrusted source content, so embedded instructions are not treated as tasks. Cowork uses the context size selected in Settings (it no longer forces 393,216 tokens), keeps a separate SSD-friendly KV cache under `.ds4/cowork-kvcache`, and uses the same live conversation surface, streaming response, collapsed Thinking view, action timeline and session commands as Agent. Its **+** menu retains Cowork-specific actions for attaching Office/PDF files, adding or changing the source folder and selecting a local Skill.

Cowork can also turn multiple documents into a **source-backed comparison table**.
For example: “Compare these course programs by topic, duration and prerequisites”
or “Compare these product specifications by size, capacity and supported formats.”
The columns follow your request; this is general-purpose knowledge work, not a
finance-specific mode. Use **Compare documents** in the Cowork welcome screen,
or simply ask in the conversation.

Each cell can show its original excerpt, source file and page/segment. Missing
fields and conflicting values stay explicit. A source match confirms that the
quote and value occur in the document — **it does not prove the interpretation
is correct**. Sources are checked again when inspecting or exporting the table;
changed or unavailable files are flagged. Exports include an expandable HTML
table or an Excel workbook with separate data, status and evidence sheets.
Adding documents preserves existing cells; replacing a correction must be
explicit. This first version reads text-layer PDFs and Office/text sources,
not scanned-page OCR, with up to 200 rows, 32 columns and 64 source files.

The [document-table tests](tests/unit/document_table_test.py) exercise real PDF,
DOCX and XLSX files, source matching, conflicting/missing data, decimal checks,
revision conflicts and exports without loading a model. They test the extraction
infrastructure; they are not an LLM extraction-accuracy benchmark.

## Skills: local task recipes

<div align="center">

<img src="assets/skills.png" width="820" alt="DStudio Skills editor showing private user-created task recipes">

</div>

Skills turn DStudio from a general assistant into a focused specialist for the job in front of you. Create a recipe, pick it, and the next Agent, Cowork or Design turn inherits its workflow, constraints and quality bar without restarting the model.

DStudio does not ship or download a skill marketplace. Every available skill is a local Markdown instruction pack created by the current user, stored in the writable user data directory and injected only when selected. Agent, Cowork and Design use this same user-only catalog and continue normally when it is empty. GSA and RSA instead use their deterministic phase templates and managed tool catalog.

## GSA: guided security analysis

<div align="center">

<img src="assets/gsa.png" width="820" alt="DStudio GSA demo showing guided security analysis and managed tool status">

</div>

GSA gives the Agent a security-analysis operating mode instead of a loose prompt. Turn it on, describe an **authorized** mission and optionally add a target URL; DStudio turns that into a guided run with clear scope, an explicit tool inventory, target context and a paper trail of artifacts. GSA and RSA do not load skills: they route only through deterministic collectors, bounded local helpers, and enabled tools.

The experience is productized, but the mechanics stay inspectable: **selection** chooses files and hypotheses; **preflight** maps evidence, trust boundaries and safe checks; **validation** gathers concrete proof with bounded scripts or optional local tools; **report** produces a compact verdict with sources, limitations and next actions. Security profiles distinguish passive, blue-team, explicitly authorized red-team and purple-team work; the run can never infer authorization from the prompt alone. External tools are evidence helpers: DStudio shows what each one does, lets you disable it, records failed invocations and keeps a normalized evidence workbench. **Install missing** executes a supervised background installer, exposes its task/log state and refreshes the catalog automatically when it finishes.

Each GSA/RSA phase is committed through a native structured control call and validated again by the host. Partial JSON streamed as prose is held in a bounded pending card and can never advance the pipeline or leak into the final answer. If a completed turn has the right work but the wrong envelope, DStudio grants one format-only recovery turn with tools disabled; a second invalid result leaves the run explicitly incomplete. The watchdog also waits while inference or a tool is genuinely active, so a slow evidence collector is not killed as an idle phase.

The Agent timeline recognizes every command in the managed GSA catalog and keeps its complete effective parameters visible in both the running and completed action row. Long invocations wrap instead of being clipped. Parameter values are shown verbatim—including tokens, passwords, cookies, authorization headers and URL query values—and the expanded row retains the exact command and its output.

### RSA: reverse structure analysis

RSA is the non-security reverse-structure workflow. It inventories a public site's visible routes and assets, captures ordinary browser/network evidence, maps frontend, public API, product-flow, data and infrastructure clues, and writes `STRUCTURE.MD` in the selected workspace. Claims are labeled **VERIFIED**, **INFERRED** or **UNKNOWN**; an evidence audit and final review gate prevent external guesses from being presented as private implementation facts. RSA shares GSA's managed tools but never scans, fuzzes, brute-forces or calls private endpoints outside normal navigation.

## Design: a studio built **on** ds4

Design is not a chat skin. It is a separate local design agent that runs a designer's pipeline end to end. **`ds4-design` is DStudio's own extension to ds4**: it lives in this repo (`extension/design/ds4_design.c`), uses the selected ds4 model backend, and has its own system prompt, tools, staged flow and native structured events.

<div align="center">

<img src="assets/design.gif" width="820" alt="DStudio Design demo showing the brief, questions, generation progress, proposals and canvas pipeline">

</div>

The whole pipeline, from a one-line idea to laid-out screens:

- **1 · Brief and questions.** Design starts with a structured interview instead of a blank prompt: what you're making, target platform, tone, brand direction, scale and constraints.
- **2 · Generating.** It loads the right skills/design systems, writes a short plan, builds the screens and shows live progress from real runtime events instead of raw tool noise.
- **Reasoning control.** Thinking effort and context capacity are independent. Design honors the context selected in Settings (with a 32k minimum) even at Thinking Max instead of silently allocating 393,216 tokens. Max keeps hidden reasoning unlimited across tool rounds; the optional 8k, 16k and 24k caps close only the model's native `</think>` block and leave the visible/tool response unrestricted.
- **3 · Proposal.** It can offer distinct directions to compare side by side, each with a name and rationale; pick one to refine or use.
- **4 · Native visual loop.** With DeepSeek Vision-Exp or GLM 5.3, Design can generate a project-local PNG directly with Ideogram 4 or edit supplied pixels directly with HunyuanImage, then inspect the result using the same selected model and its native encoder. The composed desktop/mobile page is graded in a native multimodal turn alongside deterministic 1280/390 px DOM evidence. Text-only engines, including Laguna, do not expose this visual loop.
- **5 · Quality gate, canvas and export.** Deterministic checks (including balanced structural HTML, visible literal-copy preservation, stale-copy removal, real horizontal overflow, overlapping controls and excessively stretched sparse panels) plus a role-weighted critique (minimum 8.5) block or warn on weak HTML before artifact registration. Every accepted screen lands on the canvas for refinement and zip export; reopening its Design conversation reconstructs that canvas from the persisted artifact instead of dropping back to transcript-only history. In the full-screen preview, **Select to edit** highlights the exact DOM element and opens a contextual comment directly beside it; choose General, Layout, Text, Style, Image or Video and send the bounded selector/text/geometry evidence back to Design. The preview stays in an opaque sandbox, while Design measures the selector and inspects the rendered page before applying a targeted revision.

## Plan: from a rough goal to a Markdown execution plan

Toggle **Plan** in Agent mode, describe what you want, and DStudio writes a **Markdown planning file** into the selected workspace. It is intentionally planning-only: no scaffolding, no hidden implementation flow. The agent turns the request into a concrete `plan.md` or `<topic>-plan.md` with assumptions, milestones, tasks, risks and validation steps.

**1 · You describe the outcome.** Give it a product idea, feature, workflow, migration, research task or implementation goal.

**2 · It plans instead of building.** The agent makes reasonable assumptions, scopes the work and writes a Markdown file in your workspace.

**3 · The file is useful immediately.** The plan includes objective, assumptions, deliverables, milestones, task breakdown, technical/design decisions, risks, validation checklist and next actions.

**4 · Then you decide.** Turn Plan off and use Agent/Design to implement, or keep the Markdown file as the execution reference.

## Task Graph: what it does

Task Graph is now part of Agent automatically; it is not a mode you have to keep
turning on and off. A normal question still takes the direct native path. When
DStudio detects a request to inspect, edit, test or otherwise act on the
workspace, it starts a checked graph around the same native Agent.

The priority is correctness before speed. An action is not marked successful
just because the model stopped talking: DStudio requires evidence from a real
tool result followed by a completion receipt. A prose-only “I’ll do it” fails.
Read-only work can retry; work that may change files retries automatically only
when the structured transcript proves that no tool call ran.

You can watch the graph live, pause it, resume it and reopen its saved progress
after DStudio restarts. It also records what changed and only offers automatic
undo when it can prove exactly what will be restored. The implementation details
and local API are documented in
[`extension/task-graph/README.md`](extension/task-graph/README.md).

### Native Agent or Task Graph?

Task Graph is **not another AI model**. Both options use the same native
`ds4-agent-jsonl` runtime and the same local model. “Native Agent” below is the
unwrapped baseline used by the benchmark. In the app, DStudio chooses the path
for you.

| | Native Agent baseline | Current Agent with automatic checks |
| --- | --- | --- |
| When used | Simple questions, or explicit benchmark baseline | Workspace actions, selected automatically |
| How it works | The Agent receives the prompt and decides when it is done | The same Agent works, verifies, then passes a completion gate |
| Checks | A stopped response can look complete | Prose alone cannot complete an action; tool evidence is required |
| Rules | Normal tool permissions | Every action is checked against the graph's declared rules |
| Interruption | Continue the conversation manually | Pause, resume and recover from the saved journal |
| Undo evidence | Depends on what the Agent changed | Exact writes get checkpoints; uncertain effects are reported honestly |
| Visibility | Conversation and tool timeline | The same chat, plus an optional live graph |

### 50 diverse task comparison: DStudio, Pi and OpenCode

These are not 50 repetitions of the same three prompts. The suite contains ten
task families with five different fixtures in each family. Values, paths,
symbols, file contents and bugs change between cases. Read and search answers
are hidden inside the workspace instead of being disclosed by the completion
marker.

A task passed only when a real tool completed, the required answer followed its
result, an independent file or Python check passed, and no file outside the
declared scope changed. Every path used the same complete 86.72 GB DeepSeek V4
Flash model, 8,192-token context, power 70, thinking Off and SSD streaming Off.

| Agent path | Tasks completed | Median task time | Mean tool calls |
| --- | ---: | ---: | ---: |
| Native Agent baseline | **42/50** | **21.04 s** | **2.22** |
| DStudio Agent today | **50/50** | **33.64 s** | **2.60** |
| Pi 0.84.1 | **50/50** | **36.98 s** | **3.14** |
| OpenCode 1.18.18 | **50/50** | **29.50 s** | **2.76** |

The honest result remains a **three-way correctness tie** between DStudio, Pi
and OpenCode. DStudio does not beat either competitor on completion count in
this run. It does improve the same Native baseline by eight tasks, finishes
faster than Pi and is 4.15 seconds slower than OpenCode at the median.

<div align="center">
  <img src="assets/README%20images/benchmarks/agent-harness-diverse-comparison.png" width="1100" alt="Across 50 diverse tasks Native Agent completed 42, while DStudio checked Agent, Pi and OpenCode completed 50; median times were 21.04, 33.64, 36.98 and 29.50 seconds">
</div>

The 50 cases cover a broad local coding-agent field, but not every possible
agent workload:

| Area | Cases | What changes across the five fixtures |
| --- | ---: | --- |
| Read | 10 | Hidden facts and targets in different nested paths with decoys |
| Reason across files | 5 | Different quantities and values that must be combined |
| Write and edit | 15 | Exact output, semantic JSON changes and byte-preserving edits |
| Code | 15 | Five different bugs, missing functions and multi-file symbol refactors |
| Diagnose | 5 | Different failing tests whose source must remain unchanged |

<div align="center">
  <img src="assets/README%20images/benchmarks/agent-harness-diverse-by-capability.png" width="920" alt="Results across ten task families: DStudio, Pi and OpenCode completed five of five in every family; Native completed zero of five repairs, four of five cross-file, JSON and diagnosis cases, and five of five elsewhere">
</div>

The suite does **not** claim complete coverage. Network/browser work,
multimodal UI judgment, very long autonomous tasks, parallel agents, human
approval latency and continuation of an interrupted token stream remain outside
this four-agent comparison. DStudio's deterministic crash, undo, corrupted
output and anti-loop checks run separately after the matched tasks.

The latency optimization keeps correctness-first behavior but removes redundant
work: successful exact writes are no longer re-read solely for confirmation,
passing tests are not repeated, and supplied workspace paths are not rediscovered
by scanning the machine. Across this harder suite DStudio needed only 0.38 more
tool calls per task than Native while recovering all eight Native failures.

<details>
<summary><strong>Open the benchmark method and raw results</strong></summary>

Every variant started with a fresh conversation or non-interactive CLI session.
Native and checked DStudio alternated execution order against one continuously
loaded `ds4-agent-jsonl` process. Pi and OpenCode also alternated order against
one continuously loaded `ds4-server`; a local verifier rejected every model id
except `ds4`, and no fallback occurred.

Pi and OpenCode received read, write/edit and shell capabilities. Plugins,
external skills, LSP, formatters, MCPs, sharing and catalog updates were
disabled. Their maximum model response was 1,024 tokens. CLI process startup is
included in task time. The DStudio phase took **56 min 11 s** and the
Pi/OpenCode phase **1 h 2 min 36 s**.

The runtimes cannot own the large model simultaneously, so the two phases used
separate model loads on the same machine, model file and configuration. This is
a single Apple M2 Max/96 GB sample, not a guarantee for other prompts, versions,
models or computers.

Public results include every run and the declared exclusions:

- [Native and checked DStudio result](extension/task-graph/bench/results/2026-09-04-m2-max-diverse-reliability-no-ssd.json)
- [Four-agent comparison](extension/task-graph/bench/results/2026-09-04-m2-max-diverse-agent-comparison-no-ssd.json)

Reproduce both phases and the Matplotlib figures with:

```sh
DSTUDIO_RELIABILITY_CASES=50 make test-task-graph-reliability-real
DSTUDIO_RELIABILITY_CASES=50 make test-task-graph-cli-competitors-real
node extension/task-graph/bench/publish-reliability.mjs \
  tests/.artifacts/task-graph-reliability-real/result.json \
  extension/task-graph/bench/results/2026-09-04-m2-max-diverse-reliability-no-ssd.json
node extension/task-graph/bench/publish-cli-comparison.mjs \
  tests/.artifacts/task-graph-cli-competitors-real/result.json \
  extension/task-graph/bench/results/2026-09-04-m2-max-diverse-reliability-no-ssd.json \
  extension/task-graph/bench/results/2026-09-04-m2-max-diverse-agent-comparison-no-ssd.json
python3 extension/task-graph/bench/plot-cli-comparison.py
```

</details>

### Why automatic checks help

Both DStudio paths completed the same 42 tasks. The checked path alone completed
eight; Native alone completed **zero**. The gains were all five code repairs,
one cross-file calculation, one JSON edit and one constrained diagnosis. Every
result was scored outside the agent transcript.

The automatic path still uses one generic three-node flow: do the work, verify
real tool-backed completion, then finish. It is not customized for any benchmark
answer. Read/search attempts can retry; a mutating attempt retries automatically
only when its transcript proves that no tool ran.

After the 50 task pairs, separate injected checks confirmed path rejection,
downstream blocking after corrupted output, conflict-aware undo, the anti-loop
watchdog and graph recovery after the DStudio process was killed. No human
recovery intervention was used.

This result demonstrates a measured improvement over Native on these fixtures;
it does not guarantee 100% on every future project. The publication gate rejects
a result if the checked path scores below Native or loses any matched task that
Native completes.

## Highlights

- **Local-first & private.** Core inference runs on your machine by default, with no telemetry and a strict CSP. Model downloads, Web Research and the optional DeepSeek API backend are the documented outbound paths and activate only when the user requests or configures them.
- **Self-contained native app.** The UI is one vanilla file base64-embedded in the binary. No Electron, no asset server, no CDN.
- **Non-invasive integration.** The agent's structured output comes from a small, **reversible, build-time patch** of the engine source: DStudio backs it up, builds a separately-named binary and restores the original immediately. The current DStudio release requires this structured runtime and fails clearly if its pinned patch cannot be built.
- **Setup doctor.** First run checks the ds4 folder, GGUF model, chat engine, Agent/Cowork/Design runtimes, Cowork's Python helper, Web Search, port and LAN state, then gives a direct fix button.
- **Clear controls and startup state.** The composer **+** menu groups labelled attachment, workspace, Skill and workflow actions by mode. App boot and engine changes show real launcher phases, segmented progress, runtime/context/power instruments and deduplicated structured logs. Agent, Cowork and Design expose actual system-prefill token counters; an unknown prefill duration is labeled as such instead of presenting a false linear ETA.
- **Local tools with a remote model.** The optional DeepSeek API and LAN-host backends replace inference only; Agent, Cowork, Design, GSA and RSA tools remain on the client machine with the selected workspace.
- **Pinned and repairable runtimes.** Setup and the update center install immutable engine/media revisions, verify patch anchors, rebuild separately named runtimes and keep resumable weight transfers outside the app bundle.
- **Configurable networking.** Localhost by default; Settings can change DStudio's web/LAN port or expose the UI on trusted Wi-Fi, while the model engine still never leaves localhost (see below).

## Who It's For

DStudio is for local-AI builders who want one inspectable desktop workflow for private chat, coding, Office/document work, research, design and media generation. It is intentionally hardware-hungry: choose a GGUF that fits your machine, keep enough disk for optional media workers, or use the DeepSeek API backend while local tools and files remain on your computer.

## Requirements

This is a serious local AI setup. DStudio removes product friction, not physics:

- **OS.** One `make` builds the branded app per platform: **DStudio.app** on **macOS** (Apple Silicon is the primary tested target), a **`dstudio`** binary on **Linux** (WebKitGTK / GTK3 via `webkit2gtk-4.1`) and a portable **Windows x64** folder/zip via `make windows`. Linux and Windows are less exercised, and `ds4` itself must be built for your platform.
- Apple Command Line Tools (`xcode-select --install`) or another C compiler (`cc` / `clang`). `curl`, `tar` and `make` are used by first-run setup to download and build the pinned upstream `ds4` source archive; `node` is optional, only for `make check`.
- **[antirez's ds4](https://github.com/antirez/ds4)**: DStudio keeps the primary `./ds4` checkout pinned to upstream `main`; Laguna and experimental Qwen use managed side-by-side engine directories. Every engine shares the single physical model store at `./ds4/gguf`. Source archives receive the relevant local patch set from `patch/`; macOS builds require Apple Command Line Tools (including Git for the atomic M2 patch).
- **A supported GGUF model.** The managed menu currently offers DeepSeek V4 plus the optional model families documented below. DeepSeek variants include:
  - **Flash**: ~87 GB on disk, ~96-128 GB RAM
  - **Pro**: ~430 GB on disk, ~512 GB RAM

  Missing the weights? The first-run and Settings model menus show every
  supported DeepSeek—including Vision-Exp—GLM, Laguna and Qwen download with its quantization and size.
  GLM runs on the primary `main` engine; selecting Laguna or Qwen installs its managed
  side engine automatically. Every download—including optional model
  families—is stored in `./ds4/gguf`. For DeepSeek, GLM and Laguna, while a transfer is incomplete its bytes
  are visible there as `<model>.gguf.part`, in the same directory opened by
  **Open folder**. Stop, app restart and Resume reuse that file.
  This behavior is a reversible DStudio patch applied when an engine checkout
  is installed or selected, so the upstream `download_model.sh` stays unchanged
  in the source repository.
  Qwen3.6 also uses a visible `.gguf.part`, with size and SHA-256 verification
  before it becomes selectable. Qwen3.8 uses the pinned Hugging Face downloader instead: incomplete transfers
  stay in `ds4/gguf/.cache/huggingface/download` until finalized, then both files
  are verified in full. Its progress is currently indeterminate in the app.

> The local models are intentionally large. If the selected GGUF does not fit your hardware, the screenshots show the native workflows and the optional DeepSeek API backend can provide inference while workspace tools stay local.

`ds4-design` lives in **this** repo (`extension/design/ds4_design.c`) and is compiled into the ds4 repo automatically the first time you open Design.

### MiniMax H3 video (optional)

The local video pipeline is independent of the selected chat GGUF and currently supports **Apple Silicon macOS only**.

- Install Xcode Command Line Tools (`git`, `clang` and `make`), `python3` for the small download/launcher manager, and `ffmpeg`/`ffprobe` for MP4 output before selecting **Settings → Video → Prepare local H3**. A typical Homebrew setup for the media dependency is `brew install ffmpeg`.
- Keep at least **145 GiB free**, plus room for generated videos and any old converted checkpoints. Setup reserves 8 GiB of working headroom beyond the missing official files.
- The runtime and resumable weights are stored under `~/.dstudio/minimax-h3`, outside `DStudio.app`.
- Video generation needs substantial unified memory. h3.c separates the Qwen, transformer and decoder phases so they do not coexist, but a lower reliable minimum has not yet been established. M3 and older hardware uses the portable BF16/MPS path; newer Metal hardware may enable additional native TensorOps kernels.
- Review the current [MiniMax H3 license](https://huggingface.co/MiniMaxAI/MiniMax-H3/blob/main/LICENSE) and obtain any authorization required for your territory and use. DStudio's checkbox records the user's confirmation; it is not a license grant.

### DeepSeek V4 Flash Vision Experimental (optional)

Upstream [`ds4/main`](https://github.com/antirez/ds4#deepseek-v4-flash-vision-experimental) now supports DeepSeek V4 Flash Vision-Exp directly. **Vision-Exp is a separate language checkpoint**, not an encoder upgrade for the older 0731 text GGUF shown in the original download menu.

- **Recommended model**: select **DeepSeek V4 Flash Vision-Exp · IQ2_XXS** in the unified download menu, or run `./download-model.sh ds4f-vision-q2` from the project root. The target downloads the ~86.7 GB / 81 GiB language GGUF and its matching 932,857,760-byte encoder together. Mixed Q2/Q4 (~97.6 GB / 91 GiB) and MXFP4 (~156 GB / 145 GiB) variants are also listed.
- **Existing language model**: if the matching Vision-Exp GGUF is already present, **Settings → Vision** can download only `DeepSeek-V4-Flash-Vision-Encoder.gguf` with `./download-model.sh ds4f-vision-encoder`.
- **Native image path**: DStudio supplies `--vision gguf/DeepSeek-V4-Flash-Vision-Encoder.gguf` automatically. Chat sends PNG/JPEG image blocks directly; Agent and Cowork use ds4's built-in `view_image` tool, and Design uses native multimodal inspection. No secondary visual model is inserted.
- **DSpark**: Vision-Exp has its own `DeepSeek-V4-Flash-Vision-Exp-DSpark-support.gguf`, downloadable as `ds4f-vision-dspark`. It is not compatible with the older 0731 DSpark support file, and DStudio selects the matching file from the active language checkpoint. When the main model, DSpark support model and requested context exceed the estimated Metal memory budget, DStudio explains the memory-pressure risk and asks before launch; confirming starts the requested DSpark configuration instead of silently disabling it.

### GLM 5.3 Flash (optional)

**GLM 5.3 Flash is merged into upstream [`ds4/main`](https://github.com/antirez/ds4#glm-53-flash).** DStudio pins that main revision for the primary `./ds4` runtime; there is no separate GLM source checkout, setup endpoint or branch switch anymore. DeepSeek and GLM share the same binaries and `./ds4/gguf` store.

- **Model**: the unified menu exposes GLM 5.3 Flash Q2 (~96.5 GB / 90 GiB).
  Its GGUF is stored at `./ds4/gguf/GLM-5.3-Flash-Q2.gguf`; the equivalent CLI
  command from the project root is `./download-model.sh glm53-q2`.
- **Native vision**: **Settings → Vision → Download native encoder** installs
  `GLM-5.3-Flash-Vision-Encoder.gguf` (1,127,280,960 bytes, about 1.13 GB) in
  the same model store. The equivalent CLI command is
  `./download-model.sh glm53-vision`. DStudio then starts Chat, Agent and Cowork
  with `--vision` automatically. Chat sends inline image blocks directly to
  GLM; Agent and Cowork use ds4's built-in `view_image` observation instead of
  DStudio's `see_image` text-description detour.
- **Use**: pick the GLM GGUF from the model list. The primary `./ds4` runtime
  drops `--power` (unsupported by GLM). If the user enables SSD streaming,
  DStudio uses the GLM full-layer prefill path and a 32 GB expert-cache budget.
- **Memory notice, not a forced profile**: the Q2 file is about 90 GiB, so its
  selection shows a warning on memory-constrained Macs. DStudio does not clamp
  context or force SSD streaming for GLM. The managed main patch removes the
  fixed pre-launch host-memory rejection and leaves real Metal allocation errors
  authoritative; users can enable SSD streaming explicitly if needed.
- **M2 Max native decode port**: the macOS build includes the managed
  [GLM Q2 optimization patch](patch/ds4-glm53-m2max/README.md). Its top-8
  cache-backed fast path requires Apple M2 Max and SSD streaming; it does not
  switch model modes, enable MTP or reduce context. DeepSeek's fixed top-6
  kernels remain independent. The port's build/focused-test evidence and
  outstanding full-model QA are documented separately from historical speed
  measurements.

### Laguna S 2.1 (experimental, optional)

DStudio supports Poolside **Laguna S 2.1** through ds4's
[`laguna-s2.1` branch](https://github.com/antirez/ds4/tree/laguna-s2.1), pinned
and installed beside the main engine:

- **Install and model**: select **Laguna S 2.1 · Q4_K_M** in the unified model
  download menu. DStudio installs and selects the pinned `laguna-s2.1` engine
  in `./ds4-laguna-s21`, links its model folder to `./ds4/gguf`, then starts the
  GGUF download automatically. The
  equivalent manual controls are the Doctor **Install** action,
  `POST /api/laguna/setup`, and `./download-model.sh laguna-q4` from the project root. The official
  imatrix GGUF is about 68 GB. The download row shows percentage and transferred
  GB, supports **Stop/Resume** through one stable resumable partial, and offers
  **Delete partial** with confirmation while paused; completed GGUFs are never
  removed by that cleanup action.
- **Use**: select `laguna-s-2.1-Q4_K_M.gguf` in the model menu. DStudio passes
  the Laguna Metal source path automatically and labels the model correctly in
  conversations.
- **Requirements**: the current upstream implementation is macOS Metal-only
  and requires full model residency. DStudio disables automatic SSD streaming
  for Laguna and rejects attempts to force it on.
- **Vision**: Laguna is exposed as a text-only runtime. DStudio does not route
  its image attachments through another model, does not inject `see_image`/`view_image`,
  rejects Agent/Cowork/Design image drops and reads only PDF text layers.

### Windows notes

For normal use, download/extract the Windows portable zip and run `DStudio.exe`. Keep the files together: `DStudio.exe`, `ds4-server.exe`, `ds4-agent-jsonl.exe`, `ds4-cowork.exe`, `ds4-agent-jsonl.ver`, `ds4-design.exe` and the packaged `extension/cowork` helper are meant to live in the same portable folder. Cowork currently also requires a reachable Python 3 runtime.

If you build DStudio or use Agent/Cowork/Design from a LAN client with your own local DS4 checkout, install:

- **Microsoft Edge WebView2 Runtime** if your Windows install does not already have it.
- **MSYS2 POSIX** build tools: `pacman -S make patch gcc`.
- **Visual Studio Build Tools** or `clang-cl` for building the native Windows wrapper.

The error `msys-gcc_s-seh-1.dll was not found` means Windows found `ds4-agent-jsonl.exe` but not the MSYS2 runtime it was built with. Install MSYS2 in `C:\msys64`; DStudio adds its runtime directories to `PATH` before launching Agent/Cowork/Design. Do not copy `msys-2.0.dll` or Cygwin/MSYS DLLs next to the DS4 binaries: that can make MSYS detect the wrong root and break `/tmp`, `fork()` and shell tools. LAN Agent/Cowork/Design model calls use DStudio's internal bridge; Agent/Design tools stay on the client, while Cowork uses its bounded Office bridge. First-run setup uses Windows `curl` and `tar` to download the pinned ds4 source archive; Git is not required.

## Development

For local development and headless runs, keep the web server explicit:

```sh
make run        # build + start on http://127.0.0.1:5500
make check-fast # deterministic unit, HTTP, UI and fixture checks; no model
make test-ui-live-vision DSTUDIO_LIVE_URL=http://127.0.0.1:5999
                # isolated Playwright E2E over the running saved Vision model:
                # Chat, Agent, Cowork, Design, Learn and Settings; no H3/image job
make test-task-graph-unit test-task-graph-http test-task-graph-bench-validate
make test-task-graph-real  # explicit real Agent + GGUF SSD-streaming smoke test
make check      # check-fast plus explicitly configured real-model suites
make test-image-runtime  # Ideogram/Hunyuan workflow, scheduler and runtime behavior; no image generation
make test-video-open-weight  # H3 pinning, local-only contract and checkout repair
make dist-macos VERSION=1.1.0  # signed .app smoke test + release zip/checksum
```

Optional parameters:

```sh
make run PORT=8080 DS4_DIR=/path/to/ds4
# or directly:
./dstudio [web_port] [ds4_dir]
```

Dev loop: `DS4UI_PAGE_FROM_DISK=1 ./dstudio` serves `web/index.html` from disk (hot editing) instead of the embedded copy. `DS4UI_NO_WINDOW=1` runs headless (server only).

### Qwen3.8-Flash-Next (experimental Chat/native)

DStudio includes the pinned [Qwen branch of ds4-metal](https://github.com/ivanfioravanti/ds4-metal/tree/qwen3.8-flash-next)
in `ds4-qwen38`, separate from main and Laguna. Select **Qwen3.8-Flash-Next** in
the model download menu, or run:

```sh
./download-model.sh qwen38-q4k
```

Requires the Hugging Face `hf` CLI (`huggingface_hub` with `hf_xet`).

This downloads the 73.4 GB native base and its required 32.0 GB PLE file,
verifying both SHA-256 checksums at a pinned model revision. The PLE is always
read from SSD by the model architecture; the backbone uses resident Metal.
The optional second full MTP checkpoint is not downloaded. Model files remain
in `ds4/gguf`, shared with the other engines.

Qwen currently works through **Chat/native inference only**. Its structured
Agent, Cowork and Design integration is not implemented; those modes report
this explicitly. Do not interpret the repository download or successful build
as proof of model quality or support for every DStudio mode.

If a previous version failed with “expert streaming is not validated”, rebuild
and reopen DStudio. The loading screen and model picker now apply Qwen's
compatible streaming configuration without changing the saved DeepSeek choice.

### Qwen3.6-35B-A3B (experimental Chat/native)

The separate [vagrillo Qwen branch](https://github.com/vagrillo/ds4/tree/qwen35moe-support)
is pinned at `60fca11f0c8b16ca50c757324dddd717ba043098` in `ds4-qwen35`.
Select **Qwen3.6-35B-A3B** under Settings → Models → Download, or run
`./download-model.sh qwen36-q6`. Python 3 and curl are required.

This downloads the exact **Unsloth Q6_K_XL** file (31.8 GB), checks its size and
SHA-256, and shares `ds4/gguf` with the existing engines. Interrupted transfers
can resume. It does not download Qwen3.8, a PLE, or a vision encoder.

Chat is text-only and uses native full power; the other models' power preference
is kept. Expert SSD streaming, DSpark, prompt lookup and the structured
Agent/Cowork/Design adapter are not enabled. The native expert count is unchanged;
experimental expert pruning is not enabled. Disk context checkpoints are disabled
because this fork does not serialize Qwen's complete recurrent state. Chat history
is still saved, and the running model can reuse its live context.

Verified: fresh source download, native compilation, executable startup, model
selection, launch parameters and resumable-download integrity with small test files.
**No real Qwen3.6 answer-quality or tokens/s result is claimed yet.**

### Real installation and inference checks

The important distinction is simple: **can a clean installation download and
build the engines, and can a real loaded model answer checked questions?**

```sh
make test-setup-live        # Downloads and builds main, Laguna, Qwen3.8 and Qwen3.6 from scratch
make test-inference-live    # Loads real DeepSeek/Laguna weights and checks answers
make test-inference-live ENGINES=qwen
make test-qwen-chat-live    # Starts Qwen through DStudio and checks the real Chat path
make benchmark-qwen-decode  # Three real, checked native Qwen responses + generation tok/s
```

These tests retain actual requests, answers, failures and timings. Wrong answers,
failed downloads, missing weights and interrupted output are not passes. They
exercise arithmetic, JSON extraction, recall, ordering, Unicode and streaming;
they are acceptance checks, not proof that every possible inference is correct.
See [test scope and commands](tests/README.md). Browser tests with a simulated
model are reported separately; source-string “contract tests” were removed.

Measured on **5 September 2026, M2 Max / 96 GB**:

| What was actually checked | DeepSeek Flash | Laguna S 2.1 | Qwen3.8-Flash-Next |
| --- | --- | --- | --- |
| Fresh source download, real build and executable startup | Passed | Passed | Passed |
| Checked answers and protocol behavior | 11/12 | 10/12 | 12/12 |

DeepSeek missed one strict output-format check; Laguna missed that check and
returned one wrong value from context. Those runs remain failures, not hidden
passes. Qwen's 12 checks went through DStudio's real launch API and Chat proxy;
the other two used the native server directly. This is not a general model ranking.

**Qwen generation: 26.44 tokens/s median** across three exact 32-line CSV copies
(25.98–27.15 tokens/s), with Minecraft running. This native CLI measurement
excludes model loading and prompt processing; it is not end-to-end Chat speed.
All three copies were correct. [Plain-language results, limits and raw evidence](docs/ENGINE_ACCEPTANCE.md).

## Network (LAN)

DStudio is **localhost-only by default**. The web/LAN port can be changed live in **Settings → Network → DStudio port** and is reused on later launches. To use it from a phone, tablet or another Mac on the same Wi-Fi, choose **Settings → Network access → Enable on the LAN**. The app shows the exact address to open, e.g. `http://192.168.1.207:5500`.

<div align="center">
  <img src="assets/README%20images/LAN/LAN%20SETTINGS.png" height="340" alt="Settings: enable on the LAN">
  &nbsp;&nbsp;&nbsp;
  <img src="assets/README%20images/LAN/telephone.jpg" height="340" alt="Chat over the LAN, on a phone">
</div>

<p align="center"><sub>One toggle in Settings (left) → open the address on your phone (right). The model streams over the network, with no app to install on the device.</sub></p>

Behind the scenes DStudio **reverse-proxies the engine API** (`/v1`) to the local engine, so the engine itself never leaves `127.0.0.1`: a LAN client only ever talks to DStudio, and there's **nothing to configure**.

> ⚠️ With LAN enabled, anyone on that network can reach the shared chat/model proxy. Workspace, settings, store and Agent/Cowork/Design tool APIs remain local-only, but you should still use trusted networks and turn LAN access off when finished.

## How it works

- **C launcher, not a script.** `dstudio.c` is both the local HTTP server and the engine supervisor: it starts/stops `ds4-server` for chat, `ds4-agent-jsonl` for coding, `ds4-cowork` for Office work and `ds4-design` for design, manages working directories, runs the setup doctor, proxies `/v1`, serves Web Search and exposes a small local API.
- **Native window.** `app.cc` forks the server and opens a WKWebView (macOS) / WebKitGTK (Linux) window via `webview.h`; the page is base64-embedded (`page_data.h`).
- **Same-origin proxy.** The page calls DStudio for `/v1`; DStudio forwards streaming requests to the local engine, which is why LAN works with no engine exposure and no settings.
- **Durable native Task Graph runtime.** Multi-step work can use real Agent/tool/check/approval executors, loop detection, exact-write undo receipts and a live graph with pause/resume. The explicit `test-task-graph-reliability-real` target compares 50 real tasks using the full GGUF with SSD streaming off and remains outside `check-fast`.
- **Native vision only.** DeepSeek Vision-Exp and GLM 5.3 Chat/Agent/Cowork/Design use their ds4 native encoders directly. Every other engine is text-only; no secondary VLM, visual router or fallback is installed. Ideogram 4 FP8 Quality-48 creates new images and full HunyuanImage-3.0-Instruct NF4/50-step edits source pixels directly.
- **Text-first, native-vision PDF acceleration.** Poppler extraction, chunking and BM25 stay on the CPU. Qwen3-Embedding-0.6B ranks multilingual text only; it is not a router. DeepSeek Vision-Exp or GLM 5.3 can inspect a bounded selection of rendered pages through the currently loaded native encoder, while Laguna reports and skips image-only pages.

### The agent patch: building on ds4 without forking

ds4's agent is a separate, fast-moving codebase that can't be modified permanently. To get **structured output** with clean tool calls, folded reasoning and KV-session slash-commands over the pipe, DStudio applies a small, **additive and fully reversible** patch at build time:

1. it backs up the targeted upstream sources,
2. applies anchored edits for gated JSONL output and event emitters,
3. builds **separately named** Agent/Cowork runtimes while reusing compatible engine objects,
4. **restores the original upstream source immediately.**

The canonical `ds4-agent` source is restored after the JSONL build; the build is idempotent (a version stamp forces a rebuild only when the patch itself changes), and it self-heals on the next launch even after a crash. A patch mismatch is a startup error: DStudio does not maintain a second raw-output parser or silently downgrade the Agent. The managed runtime patches add multimodal hot-memory coordination, expose ds4's measured decode throughput, and correct GLM 5.3 streaming/catalog behavior; they are reversed/reapplied automatically around upstream pulls. Chat also checks the actual `ds4-server` executable before launch and repairs/rebuilds it if a later plain upstream `make` removed the exact-throughput extension, so `tok/s` cannot silently disappear while the app itself remains current. (`ds4-design` is *our* code, in this repo, so it emits these events natively with no patch needed.)

#### ⚠️ The patch targets DStudio's pinned ds4 commit

The structured runtime is built against the **unmodified, pinned [ds4](https://github.com/antirez/ds4)** source: the patch finds its insertion points by exact anchors in `ds4_agent.c`. DStudio updates that pin and the patch together as one breaking release boundary.

Forks that change those anchors are unsupported by that release and the Agent refuses to start instead of running with partial behavior. This keeps one protocol, one renderer and one test surface while leaving the upstream checkout pristine.

### KV cache: how context is kept

The selected local model keeps conversation state in ds4-server's **KV cache** instead of re-encoding it from scratch every turn:

- **Chat** re-sends its history behind a **stable prefix**, so the server reuses the cached prefix automatically, shown as the blue *cached* token count under each reply. The KV cache is also written **to disk**, so context survives engine restarts.
- **Agent, Cowork & Design** get independent named KV sessions, autosaved every turn. Reopening a conversation restores its exact engine state, so threads do not share accidental context. Design also keeps an exact-text, model-validated cache of its bootstrap prompt: the first cold launch reports real prefill progress, while later launches restore that prefix without recomputing it. Selected Design systems and Skills are loaded by their native tools on the first user turn rather than copied wholesale into every startup prompt.

## Security

- **Localhost by default** (`DS4UI_HOST` overrides the boot host); the page is served from a fixed path: no client path ever touches the filesystem.
- Engine spawned with `fork`+`execv` (argument array, **no shell**): no command injection. Model from a fixed enum, integer parameters range-checked, working dir passed as a single argument.
- Mutating local APIs require the anti-CSRF header `X-Requested-With: ds4web`.
- Outbound traffic is feature-scoped: setup downloads from pinned GitHub/Hugging Face revisions, Web Research reads requested public sources, and the optional DeepSeek cloud backend contacts `api.deepseek.com` only after the user supplies a key and selects it.

> ⚠️ **Agent and Design** can run commands autonomously. Use a trusted project folder. Their workspace APIs remain local even when LAN chat is enabled. **Cowork** intentionally has no arbitrary shell and confines its native file/Office tools to the selected workspace.

## Project Roadmap

Where DStudio is headed (ideas, not promises):

- **Sharper Design studio**: broaden the visual-diversity corpus and add a second independent local render judge.
- **Sharper Plan mode**: richer Markdown plans with better assumptions, acceptance criteria and execution clarity.
- **MCP**: Model Context Protocol support so the agent can plug into external tools and data sources beyond the working directory.

## Contributing

DStudio is early, hardware-hungry and built for the local-AI crowd. The most useful contributions right now are setup reports, hardware reports, reproducible agent failures, design-output examples and small PRs that reduce first-run friction. If you want open-source local AI tools to exist outside cloud subscriptions, a ⭐ helps the project reach the right testers.

## License

[BSD 3-Clause](LICENSE) © 2026 Giuseppe Perrotta
