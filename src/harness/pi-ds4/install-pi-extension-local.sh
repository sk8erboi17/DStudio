#!/bin/sh
set -eu

usage() {
    echo "usage: $0 [--force] /path/to/ds4-server-checkout" >&2
}

copy_file_cow() {
    src=$1
    dst=$2
    tmp="$dst.tmp.$$"

    rm -f "$tmp"
    if [ "$(uname -s)" = "Darwin" ] && cp -c -p "$src" "$tmp" 2>/dev/null; then
        mv -f "$tmp" "$dst"
        return 0
    fi

    rm -f "$tmp"
    cp -p "$src" "$tmp"
    mv -f "$tmp" "$dst"
}

copy_existing_models() {
    src_root=$1
    dst_root=$2
    src_gguf="$src_root/gguf"
    dst_gguf="$dst_root/gguf"
    copied=0
    skipped=0

    if [ ! -d "$src_gguf" ]; then
        return 0
    fi

    mkdir -p "$dst_gguf"

    for src in "$src_gguf"/*.gguf "$src_gguf"/*.gguf.part; do
        [ -f "$src" ] || continue
        name=$(basename -- "$src")
        dst="$dst_gguf/$name"
        if [ -e "$dst" ] || [ -L "$dst" ]; then
            skipped=$((skipped + 1))
            continue
        fi
        echo "Copying existing model with APFS clone/copy fallback:"
        echo "  $src"
        echo "  -> $dst"
        copy_file_cow "$src" "$dst"
        copied=$((copied + 1))
    done

    if [ ! -e "$dst_root/ds4flash.gguf" ] && [ ! -L "$dst_root/ds4flash.gguf" ]; then
        if [ -L "$src_root/ds4flash.gguf" ]; then
            link_target=$(readlink "$src_root/ds4flash.gguf")
            ln -s "$link_target" "$dst_root/ds4flash.gguf"
        elif [ -f "$src_root/ds4flash.gguf" ]; then
            copy_file_cow "$src_root/ds4flash.gguf" "$dst_root/ds4flash.gguf"
            copied=$((copied + 1))
        fi
    fi

    if [ "$copied" -gt 0 ] || [ "$skipped" -gt 0 ]; then
        echo "Preserved existing model files from old support checkout: copied $copied, skipped $skipped."
    fi
}

FORCE=0
if [ "${1:-}" = "--force" ]; then
    FORCE=1
    shift
fi

if [ "$#" -ne 1 ] || [ "${1:-}" = "-h" ] || [ "${1:-}" = "--help" ]; then
    usage
    exit 1
fi

ROOT=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
PI_AGENT_DIR=${PI_CODING_AGENT_DIR:-"$HOME/.pi/agent"}
EXTENSION_DIR="$PI_AGENT_DIR/extensions"
EXTENSION_LINK="$EXTENSION_DIR/pi-ds4"
SKILL_DIR="$PI_AGENT_DIR/skills"
SKILL_LINK="$SKILL_DIR/pi-ds4-config"
DS4_DIR="$HOME/.pi/ds4"
SUPPORT_LINK="$DS4_DIR/support"

DS4_CHECKOUT_INPUT=$1
if [ ! -d "$DS4_CHECKOUT_INPUT" ]; then
    echo "error: ds4 checkout does not exist: $DS4_CHECKOUT_INPUT" >&2
    exit 1
fi
DS4_CHECKOUT=$(CDPATH= cd -- "$DS4_CHECKOUT_INPUT" && pwd)

if [ ! -f "$ROOT/index.ts" ]; then
    echo "error: $ROOT/index.ts not found" >&2
    exit 1
fi

if [ ! -f "$ROOT/ds4-watchdog.sh" ]; then
    echo "error: $ROOT/ds4-watchdog.sh not found" >&2
    exit 1
fi

if [ ! -f "$ROOT/pi-ds4-config/SKILL.md" ]; then
    echo "error: $ROOT/pi-ds4-config/SKILL.md not found" >&2
    exit 1
fi

for file in download_model.sh Makefile ds4_server.c; do
    if [ ! -f "$DS4_CHECKOUT/$file" ]; then
        echo "error: $DS4_CHECKOUT does not look like a ds4 server checkout (missing $file)" >&2
        exit 1
    fi
done

mkdir -p "$EXTENSION_DIR" "$SKILL_DIR" "$DS4_DIR"
ln -sfn "$ROOT" "$EXTENSION_LINK"
ln -sfn "$ROOT/pi-ds4-config" "$SKILL_LINK"

installed_support=0
if [ -L "$SUPPORT_LINK" ]; then
    current=$(CDPATH= cd -- "$SUPPORT_LINK" 2>/dev/null && pwd || true)
    if [ "$current" = "$DS4_CHECKOUT" ]; then
        installed_support=1
    else
        if [ "$FORCE" -eq 1 ]; then
            copy_existing_models "$SUPPORT_LINK" "$DS4_CHECKOUT"
        fi
        rm -f "$SUPPORT_LINK"
        ln -s "$DS4_CHECKOUT" "$SUPPORT_LINK"
        installed_support=1
    fi
elif [ -e "$SUPPORT_LINK" ]; then
    current=$(CDPATH= cd -- "$SUPPORT_LINK" 2>/dev/null && pwd || true)
    if [ "$current" = "$DS4_CHECKOUT" ]; then
        installed_support=1
    elif [ "$FORCE" -eq 1 ]; then
        copy_existing_models "$SUPPORT_LINK" "$DS4_CHECKOUT"
        backup="$SUPPORT_LINK.backup.$(date +%Y%m%d%H%M%S)"
        mv "$SUPPORT_LINK" "$backup"
        ln -s "$DS4_CHECKOUT" "$SUPPORT_LINK"
        installed_support=1
        echo "Moved existing ds4 support checkout aside:"
        echo "  $backup"
    else
        echo "error: $SUPPORT_LINK already exists and is not this checkout" >&2
        echo "       rerun with --force to move it aside and install a symlink" >&2
        exit 1
    fi
else
    ln -s "$DS4_CHECKOUT" "$SUPPORT_LINK"
    installed_support=1
fi

if [ "$installed_support" -ne 1 ]; then
    echo "error: failed to install ds4 support checkout symlink" >&2
    exit 1
fi

echo "Installed pi extension package symlink:"
echo "  $EXTENSION_LINK -> $ROOT"
echo
echo "Installed pi skill symlink:"
echo "  $SKILL_LINK -> $ROOT/pi-ds4-config"
echo
echo "Installed ds4 runtime checkout symlink:"
echo "  $SUPPORT_LINK -> $DS4_CHECKOUT"
echo
echo "Reload pi with /reload or start pi normally; the extension is auto-discovered."
