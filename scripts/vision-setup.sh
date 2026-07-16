#!/bin/sh
# DStudio — install the local vision server (llama.cpp, cross-platform, no python).
# Called by POST /api/vision/setup. Downloads a pinned llama.cpp prebuilt release
# for this OS/arch and extracts llama-server. The model itself (Qwen2.5-VL GGUF +
# mmproj) is fetched lazily by llama-server's -hf on first run (see vision-server.sh).
#
# On Linux, when a GPU render node and the Vulkan loader are present, the Vulkan
# build is tried first (the plain ubuntu-x64 build is CPU-only) and the CPU build
# stays as fallback if that asset is missing or the download fails.
#
# Override via env:
#   DSTUDIO_LLAMA_BUILD   (default b10034)   — pinned llama.cpp release tag
#   DSTUDIO_VISION_DIR    (default $HOME/.dstudio/llama-vision)
#   DSTUDIO_LLAMA_FLAVOR  (Linux: auto|cpu|vulkan, default auto)
set -eu

BUILD="${DSTUDIO_LLAMA_BUILD:-b10034}"
DIR="${DSTUDIO_VISION_DIR:-$HOME/.dstudio/llama-vision}"
FLAVOR="${DSTUDIO_LLAMA_FLAVOR:-auto}"
BASE="https://github.com/ggml-org/llama.cpp/releases/download/$BUILD"

# Linux GPU probe: a DRM render node plus the Vulkan loader is the minimum the
# vulkan build needs to actually start; anything less falls back to CPU.
linux_has_vulkan() {
  [ -n "$(ls /dev/dri/renderD* 2>/dev/null)" ] || return 1
  { ldconfig -p 2>/dev/null || /sbin/ldconfig -p 2>/dev/null; } | grep -q 'libvulkan\.so' || return 1
  return 0
}

os="$(uname -s)"
arch="$(uname -m)"
assets=""
case "$os" in
  Darwin)
    case "$arch" in
      arm64)          assets="llama-$BUILD-bin-macos-arm64.tar.gz" ;;
      x86_64)         assets="llama-$BUILD-bin-macos-x64.tar.gz" ;;
      *) echo "vision-setup: unsupported macOS arch: $arch" >&2; exit 2 ;;
    esac ;;
  Linux)
    case "$arch" in
      x86_64|amd64)
        cpu_asset="llama-$BUILD-bin-ubuntu-x64.tar.gz"
        vk_asset="llama-$BUILD-bin-ubuntu-vulkan-x64.tar.gz"
        case "$FLAVOR" in
          cpu)    assets="$cpu_asset" ;;
          vulkan) assets="$vk_asset $cpu_asset" ;;
          *)      if linux_has_vulkan; then assets="$vk_asset $cpu_asset"; else assets="$cpu_asset"; fi ;;
        esac ;;
      *) echo "vision-setup: unsupported Linux arch: $arch (need x86_64)" >&2; exit 2 ;;
    esac ;;
  *) echo "vision-setup: $os is not supported yet (Windows: follow-up)" >&2; exit 2 ;;
esac

mkdir -p "$DIR"
tmp="$(mktemp -d)"
trap 'rm -rf "$tmp"' EXIT

got=""
for asset in $assets; do
  echo "vision-setup: downloading $asset" >&2
  if curl -fL --retry 3 -o "$tmp/llama.tgz" "$BASE/$asset"; then
    got="$asset"
    break
  fi
  echo "vision-setup: $asset unavailable, trying fallback" >&2
done
[ -n "$got" ] || { echo "vision-setup: no llama.cpp asset could be downloaded" >&2; exit 3; }

echo "vision-setup: extracting $got into $DIR" >&2
tar -xzf "$tmp/llama.tgz" -C "$DIR"

SERVER="$(find "$DIR" -name llama-server -type f 2>/dev/null | head -1 || true)"
[ -n "$SERVER" ] || { echo "vision-setup: llama-server not found after extraction" >&2; exit 3; }
chmod +x "$SERVER" 2>/dev/null || true

# macOS: strip the Gatekeeper quarantine so the downloaded binaries can run.
if [ "$os" = "Darwin" ]; then
  xattr -dr com.apple.quarantine "$DIR" 2>/dev/null || true
fi

echo "vision-setup: llama-server ready at $SERVER" >&2
