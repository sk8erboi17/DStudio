#!/bin/sh
set -eu

ds4_dir=${DS4_DIR:-}
if [ -z "$ds4_dir" ] || [ ! -f "$ds4_dir/download_model.sh" ]; then
    echo "DStudio visible downloads patch: invalid DS4_DIR" >&2
    exit 2
fi

script_dir=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
patch_file="$script_dir/../patch/ds4-visible-downloads/visible-partials.patch"
marker='Every transfer is written as a visible <filename>.part file'
action=${1:-apply}

# The current main downloader contains these native DeepSeek Vision and GLM 5.3
# targets. Optional/older engine checkouts keep their own downloader unchanged.
if grep -q 'qwen38-q4k' "$ds4_dir/download_model.sh" ||
   ! grep -q 'ds4f-vision-q2' "$ds4_dir/download_model.sh" ||
   ! grep -q 'glm53-q2' "$ds4_dir/download_model.sh"; then
    echo "DStudio visible downloads patch: non-main checkout skipped"
    exit 0
fi

if [ "$action" = "restore" ]; then
    if ! grep -Fq "$marker" "$ds4_dir/download_model.sh"; then
        echo "DStudio visible downloads patch: already restored"
        exit 0
    fi
    patch -d "$ds4_dir" -p1 --reverse --batch < "$patch_file"
    echo "DStudio visible downloads patch: restored"
    exit 0
fi

if [ "$action" != "apply" ] && [ "$action" != "build" ]; then
    echo "DStudio visible downloads patch: expected apply, build, or restore" >&2
    exit 2
fi

if grep -Fq "$marker" "$ds4_dir/download_model.sh"; then
    echo "DStudio visible downloads patch: already applied"
    exit 0
fi

if ! patch -d "$ds4_dir" -p1 --forward --batch < "$patch_file"; then
    echo "DStudio visible downloads patch: source anchors no longer match upstream" >&2
    exit 1
fi
echo "DStudio visible downloads patch: applied"
