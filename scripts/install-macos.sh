#!/bin/bash
# DStudio macOS installer — free distribution path (ad-hoc signed, not notarized).
#
# Downloads the release .app, verifies its SHA-256, removes the download
# quarantine (Gatekeeper "cannot verify developer" popup) and installs it into
# ~/Applications. No paid Apple Developer account required.
#
# Usage:
#   bash <(curl -fsSL https://raw.githubusercontent.com/sk8erboi17/DStudio/main/scripts/install-macos.sh)
#   # or:  bash scripts/install-macos.sh
set -euo pipefail

VERSION="${1:-v1.0.0}"
RELEASE_TAG="${VERSION#v}"
OWNER_REPO="sk8erboi17/DStudio"
BASE_URL="https://github.com/${OWNER_REPO}/releases/download/${VERSION}"
ZIP_NAME="DStudio-${RELEASE_TAG}-macOS-arm64.zip"
APP_NAME="DStudio.app"
DEST_DIR="${HOME}/Applications"

if [ "$(uname -s)" != "Darwin" ]; then
  echo "DStudio installer: this script is for macOS only." >&2
  exit 1
fi

if [ "$(uname -m)" != "arm64" ]; then
  echo "DStudio installer: this release is for Apple Silicon (arm64) only." >&2
  exit 1
fi

TMP_ROOT="$(mktemp -d "${TMPDIR:-/tmp}/dstudio-install.XXXXXX")"
cleanup() { rm -rf "$TMP_ROOT"; }
trap cleanup EXIT

echo "Downloading DStudio ${VERSION}…"
curl -fsSL "${BASE_URL}/${ZIP_NAME}" -o "${TMP_ROOT}/${ZIP_NAME}"
curl -fsSL "${BASE_URL}/${ZIP_NAME}.sha256" -o "${TMP_ROOT}/${ZIP_NAME}.sha256"

(
  cd "$TMP_ROOT"
  shasum -a 256 -c "${ZIP_NAME}.sha256"
  ditto -x -k "${ZIP_NAME}" .
)

echo "Removing the download quarantine…"
xattr -cr "${TMP_ROOT}/${APP_NAME}"

mkdir -p "$DEST_DIR"
echo "Installing to ${DEST_DIR}/${APP_NAME}…"
rm -rf "${DEST_DIR}/${APP_NAME}"
ditto "${TMP_ROOT}/${APP_NAME}" "${DEST_DIR}/${APP_NAME}"

echo "Opening DStudio…"
open "${DEST_DIR}/${APP_NAME}"
echo
echo "DStudio installed at ${DEST_DIR}/${APP_NAME}."
echo "If Gatekeeper still asks once, right-click the app -> Open -> Open."
