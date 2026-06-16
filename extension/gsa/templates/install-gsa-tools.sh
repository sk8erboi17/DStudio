#!/usr/bin/env bash
set -uo pipefail
ROOT="$(cd "$(dirname "$0")" && pwd)"
BIN="$ROOT/bin"
NUCLEI_TEMPLATES_DIR="$ROOT/nuclei-templates"
TRIVY_CACHE_DIR="$ROOT/trivy-cache"
GRYPE_DB_CACHE_DIR="$ROOT/grype/db"
WARNINGS=()
FAILURES=()
warn() { WARNINGS+=("$1"); echo "warning: $1" >&2; }
fail() { FAILURES+=("$1"); echo "error: $1" >&2; }
mkdir -p "$BIN" "$NUCLEI_TEMPLATES_DIR" "$TRIVY_CACHE_DIR" "$GRYPE_DB_CACHE_DIR" "$ROOT/go" "$ROOT/cargo/home" "$ROOT/cargo/target" "$ROOT/pipx" "$ROOT/python"
export GOBIN="$BIN"
export GOPATH="$ROOT/go"
export GOMODCACHE="$ROOT/go/pkg/mod"
export GOCACHE="$ROOT/go/cache"
export CARGO_HOME="$ROOT/cargo/home"
export CARGO_TARGET_DIR="$ROOT/cargo/target"
export PIPX_HOME="$ROOT/pipx/home"
export PIPX_BIN_DIR="$BIN"
export NUCLEI_TEMPLATES_DIR
export TRIVY_CACHE_DIR
export GRYPE_DB_CACHE_DIR
echo "Preparing optional GSA tools in $BIN"
echo "Installing Go-based GSA tools"
if command -v go >/dev/null 2>&1; then
{{GO_INSTALL_LINES}}else
  fail "Go is not installed; cannot install Go-based GSA tools. Install Go, then rerun this script."
fi
install_apt_pkg() {
  pkg="$1"
  if command -v sudo >/dev/null 2>&1; then
    sudo apt-get update && sudo apt-get install -y "$pkg"
  else
    apt-get update && apt-get install -y "$pkg"
  fi
}
ensure_system_tool() {
  label="$1"
  check="$2"
  brew_pkg="$3"
  apt_pkg="$4"
  if eval "$check" >/dev/null 2>&1; then
    echo "  - $label present"
    return
  fi
  echo "  - $label missing; installing system package"
  if command -v brew >/dev/null 2>&1; then
    brew install "$brew_pkg" || fail "$label install failed via Homebrew package $brew_pkg"
  elif command -v apt-get >/dev/null 2>&1; then
    install_apt_pkg "$apt_pkg" || fail "$label install failed via apt package $apt_pkg"
  else
    fail "$label is missing and neither Homebrew nor apt-get is available for automatic install"
  fi
  if ! eval "$check" >/dev/null 2>&1; then
    fail "$label command still unavailable after system package install"
  fi
}
echo "Installing/validating system GSA tools"
ensure_system_tool "trivy" "command -v trivy" "trivy" "trivy"
ensure_system_tool "syft" "command -v syft" "syft" "syft"
ensure_system_tool "grype" "command -v grype" "grype" "grype"
ensure_system_tool "yara" "command -v yara" "yara" "yara"
ensure_system_tool "tshark" "command -v tshark" "wireshark" "tshark"
ensure_system_tool "zeek" "command -v zeek" "zeek" "zeek"
ensure_system_tool "nmap" "command -v nmap" "nmap" "nmap"
ensure_system_tool "rizin" "command -v rizin && command -v rz-bin && command -v rz-find" "rizin" "rizin"
ensure_system_tool "radare2" "command -v radare2 || command -v r2" "radare2" "radare2"
ensure_system_tool "gdb" "command -v gdb" "gdb" "gdb"
ensure_system_tool "exiftool" "command -v exiftool" "exiftool" "libimage-exiftool-perl"
ensure_system_tool "jq" "command -v jq" "jq" "jq"
echo "Installing/updating managed GSA tool data"
if [ -x "$BIN/nuclei" ]; then
  "$BIN/nuclei" -update-templates -update-template-dir "$NUCLEI_TEMPLATES_DIR" || warn "nuclei update command failed; trying explicit template materialization"
  if [ ! -d "$NUCLEI_TEMPLATES_DIR/http" ] && [ ! -d "$NUCLEI_TEMPLATES_DIR/nuclei-templates/http" ]; then
    echo "nuclei update did not materialize templates in $NUCLEI_TEMPLATES_DIR; using explicit git/copy materialization"
    if [ -d "$HOME/nuclei-templates/http" ]; then
      cp -R "$HOME/nuclei-templates/." "$NUCLEI_TEMPLATES_DIR/" || fail "could not copy existing ~/nuclei-templates checkout"
    fi
    if [ ! -d "$NUCLEI_TEMPLATES_DIR/http" ] && command -v git >/dev/null 2>&1; then
      if [ -d "$NUCLEI_TEMPLATES_DIR/.git" ]; then
        git -C "$NUCLEI_TEMPLATES_DIR" pull --ff-only || fail "nuclei templates git pull failed"
      else
        rm -rf "$NUCLEI_TEMPLATES_DIR"
        git clone --depth 1 https://github.com/projectdiscovery/nuclei-templates "$NUCLEI_TEMPLATES_DIR" || fail "nuclei templates git clone failed"
      fi
    fi
    if [ ! -d "$NUCLEI_TEMPLATES_DIR/http" ] && [ ! -d "$NUCLEI_TEMPLATES_DIR/nuclei-templates/http" ]; then
      fail "nuclei templates were not found after update; rerun this script with git/network access"
    fi
  fi
else
  fail "nuclei binary is not available; cannot install nuclei templates. Fix nuclei install, then rerun this script."
fi
TRIVY_BIN="$(command -v trivy || true)"
if [ -n "$TRIVY_BIN" ]; then
  "$TRIVY_BIN" image --download-db-only --cache-dir "$TRIVY_CACHE_DIR" || fail "trivy vulnerability DB update failed"
  "$TRIVY_BIN" image --download-java-db-only --cache-dir "$TRIVY_CACHE_DIR" || fail "trivy Java DB update failed"
else
  fail "trivy is not installed after system tool installation; cannot prefetch vulnerability databases"
fi
GRYPE_BIN="$(command -v grype || true)"
if [ -n "$GRYPE_BIN" ]; then
  "$GRYPE_BIN" db update || fail "grype DB update failed"
else
  fail "grype is not installed after system tool installation; cannot prefetch vulnerability database"
fi
if command -v cargo >/dev/null 2>&1; then
  echo "Installing Cargo-based tools"
  cargo install binwalk --root "$ROOT" --locked --force || fail "binwalk install failed via cargo"
else
  fail "Cargo is not installed; cannot install binwalk. Install Rust/Cargo, then rerun this script."
fi
echo "Installing Node-based optional tools"
if command -v npm >/dev/null 2>&1; then
  mkdir -p "$ROOT/node"
  npm install --prefix "$ROOT/node" playwright || fail "playwright npm install failed"
  if [ -x "$ROOT/node/node_modules/.bin/playwright" ]; then
    ln -sf "$ROOT/node/node_modules/.bin/playwright" "$BIN/playwright" || fail "could not link playwright into $BIN"
    "$BIN/playwright" install chromium || fail "playwright browser install failed"
  else
    fail "playwright binary was not produced by npm install"
  fi
else
  fail "Node.js/npm is not installed; cannot install Playwright. Install Node.js, then rerun this script."
fi
echo "Installing Python-based optional tools"
PY_PKGS="plaso volatility3 semgrep sqlmap arjun uro pwntools"
if command -v pipx >/dev/null 2>&1; then
  pipx_install_managed() {
    pkg="$1"
    echo "  - $pkg"
    venv="$PIPX_HOME/venvs/$pkg"
    if [ -d "$venv" ]; then
      echo "    refreshing managed pipx venv $venv"
      rm -rf "$venv" || { fail "could not remove existing managed pipx venv for $pkg"; return; }
    fi
    pipx install --force "$pkg" || fail "$pkg install failed via pipx"
  }
  for pkg in $PY_PKGS; do pipx_install_managed "$pkg"; done
elif command -v python3 >/dev/null 2>&1; then
  rm -rf "$ROOT/python/venv" || fail "could not remove existing managed Python venv"
  if python3 -m venv "$ROOT/python/venv"; then
    "$ROOT/python/venv/bin/python" -m pip install --upgrade pip || fail "pip upgrade failed in managed Python venv"
    "$ROOT/python/venv/bin/python" -m pip install $PY_PKGS || fail "one or more Python tools failed to install in managed venv"
    find "$ROOT/python/venv/bin" -maxdepth 1 -type f -perm -111 -exec ln -sf {} "$BIN" \; || fail "could not link Python tool entrypoints into $BIN"
  else
    fail "python3 exists, but venv creation failed. Install python3-venv or use pipx, then rerun this script."
  fi
else
  fail "Python 3 or pipx is not installed; cannot install Python-based GSA tools."
fi
if [ "${#WARNINGS[@]}" -gt 0 ]; then
  echo
  echo "Completed with non-fatal warnings:"
  printf ' - %s\n' "${WARNINGS[@]}"
fi
if [ "${#FAILURES[@]}" -gt 0 ]; then
  echo
  echo "Installer failed. Missing required managed tools/data:"
  printf ' - %s\n' "${FAILURES[@]}"
  exit 1
fi
echo "All managed installer steps completed with required data present."
