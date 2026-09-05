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
- `third_party/`: attributed vendored dependencies.
- `build/`, `tests/.build/`, `tests/.artifacts/`, `dist/`: ignored generated outputs.

`ds4/`, `ds4-laguna-s21/`, `ds4-qwen38/` and `ds4-qwen35/` are ignored managed engines. Their
paths are intentionally stable for saved settings and existing workspaces.
`ds4/gguf/` remains the single physical model store; optional engines link to it.
Generated Design workspaces, exports, the private Discord archive and existing
local app bundles are not relocated, since persisted user paths can refer to them.

Root entry points: `Makefile`, `download-model.sh`, `README.md`, `AGENTS.md` and
licensing. `dstudio` and `DStudio.app` remain the familiar built launch targets.
