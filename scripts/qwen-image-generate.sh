#!/bin/sh
set -eu

prompt_file=${1:?prompt file required}
outdir=${2:?output directory required}
status_file=${3:-${outdir}/status.json}
action=${4:-generate}
input_image=${5:-}
preserve=${6:-none}
reference_image=${7:-}
script_dir=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)

if [ "${DSTUDIO_IMAGE_TEST_MODE:-0}" = "1" ]; then
    if [ -n "$reference_image" ]; then
        exec /usr/bin/python3 "$script_dir/qwen-image-run.py" --prompt-file "$prompt_file" --outdir "$outdir" --status-file "$status_file" --action "$action" --input "$input_image" --input "$reference_image" --preserve "$preserve"
    fi
    exec /usr/bin/python3 "$script_dir/qwen-image-run.py" --prompt-file "$prompt_file" --outdir "$outdir" --status-file "$status_file" --action "$action" --input "$input_image" --preserve "$preserve"
fi

# qwen-image-mps selects MPS, CUDA/HIP or CPU itself. On NVIDIA, inspect the
# free VRAM after DS4's hot lease; if less than 24 GiB remains, hide CUDA so the
# pipeline takes its CPU path instead of crashing both models with an OOM.
if command -v nvidia-smi >/dev/null 2>&1; then
    free_mb=$(nvidia-smi --query-gpu=memory.free --format=csv,noheader,nounits 2>/dev/null | sort -nr | head -1 || true)
    case "$free_mb" in
        ''|*[!0-9]*) ;;
        *)
            if [ "$free_mb" -lt 24576 ]; then
                echo "DStudio: CUDA free VRAM ${free_mb} MiB is below Qwen reserve; using CPU fallback" >&2
                CUDA_VISIBLE_DEVICES=; export CUDA_VISIBLE_DEVICES
            else
                echo "DStudio: CUDA free VRAM ${free_mb} MiB; using CUDA" >&2
            fi
            ;;
    esac
elif [ "$(uname -s)" = "Darwin" ]; then
    echo "DStudio: using Metal/MPS unified memory with DS4 hot lease" >&2
else
    echo "DStudio: no NVIDIA probe; qwen-image-mps will choose HIP/CUDA or CPU" >&2
fi

runtime_root=${DSTUDIO_QWEN_IMAGE_HOME:-${HOME}/.dstudio/qwen-image}
venv="$runtime_root/venv"
uv_bin=$(command -v uv || true)
if [ -z "$uv_bin" ] && [ -x /opt/homebrew/bin/uv ]; then uv_bin=/opt/homebrew/bin/uv; fi
if [ -z "$uv_bin" ]; then
    echo "uv is required for qwen-image-mps (install with: brew install uv)" >&2
    exit 3
fi
mkdir -p "$runtime_root" "$outdir"
if [ ! -x "$venv/bin/python" ]; then
    "$uv_bin" venv --python 3.12 "$venv"
fi
stamp="$runtime_root/qwen-image-mps.fe70bd7"
if [ ! -f "$stamp" ]; then
    "$uv_bin" pip install --python "$venv/bin/python" \
        "git+https://github.com/ivanfioravanti/qwen-image-mps.git@fe70bd7b245307143d95cde5bc62c9aeff401e69"
    : > "$stamp"
fi
dtype_patch="$script_dir/../patch/qwen-image-mps/mps-direct-dtype.patch"
dtype_stamp="$runtime_root/qwen-image-mps.mps-direct-dtype.v1"
if [ ! -f "$dtype_stamp" ]; then
    package_dir=$("$venv/bin/python" -c 'import pathlib, qwen_image_mps; print(pathlib.Path(qwen_image_mps.__file__).parent)')
    patch -d "$package_dir" -p1 --forward < "$dtype_patch"
    : > "$dtype_stamp"
fi
if [ "$action" = "edit" ] && [ "$preserve" = "face" ] && ! "$venv/bin/python" -c 'import cv2' >/dev/null 2>&1; then
    echo "DStudio: installing the local face detector for pixel-preserving edits" >&2
    "$uv_bin" pip install --python "$venv/bin/python" "opencv-python-headless==4.12.0.88"
fi
if [ -n "$reference_image" ]; then
    exec "$venv/bin/python" "$script_dir/qwen-image-run.py" --prompt-file "$prompt_file" --outdir "$outdir" --status-file "$status_file" --action "$action" --input "$input_image" --input "$reference_image" --preserve "$preserve"
fi
exec "$venv/bin/python" "$script_dir/qwen-image-run.py" --prompt-file "$prompt_file" --outdir "$outdir" --status-file "$status_file" --action "$action" --input "$input_image" --preserve "$preserve"
