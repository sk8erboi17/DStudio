# Project layout

- `src/`: native desktop host and domain-specific C modules.
- `web/`: interface and loading screen.
- `extension/`: feature implementations and their assets.
- `patch/`: versioned engine adaptations, separate from upstream checkouts.
- `scripts/`: installation, model downloads, packaging and runtime helpers.
- `tests/`: unit, browser, integration and live suites; see [tests](../tests/README.md).
- `docs/`: contributor documentation and verification reports. Superseded
  snapshots live in `docs/history/`, clearly separated from current results.
- `assets/`: shipped icons, images and bundle metadata.
- `extension/design-systems/`: original DStudio visual systems, included offline.
- `src/harness/`: agent loops. Native Cowork, Design, GSA and RSA sources; the
  pinned third-party pi, OpenCode and pi-ds4 snapshots with their manifest; the
  DStudio bridge that runs pi/OpenCode as the Agent runtime. See
  [HARNESSES.md](HARNESSES.md). Installed builds go to the ignored `harness/`.
- `build/`, `tests/.build/`, `tests/.artifacts/`, `dist/`: ignored generated outputs.

`ds4/`, `ds4-laguna-s21/` and `llama.cpp/` are ignored managed engines. Their
paths are intentionally stable for saved settings and existing workspaces. A
leftover `ds4-qwen35/` or `q36/` from the retired Qwen side engines is ignored
and left untouched.
`ds4/gguf/` remains the single physical model store; optional engines link to it.
Qwen Next uses `ds4/`; the retired `ds4-qwen38/` checkout is unnecessary for the
application and default patch tests. Exact historical regression inputs live in
[`tests/fixtures/retired-qwen-next/`](../tests/fixtures/retired-qwen-next/).
Generated Design workspaces, exports, the private Discord archive and existing
local app bundles are not relocated, since persisted user paths can refer to them.

Root entry points: `Makefile`, `download-model.sh`, `README.md`, `AGENTS.md` and
licensing. `dstudio` and `DStudio.app` remain the familiar built launch targets.
