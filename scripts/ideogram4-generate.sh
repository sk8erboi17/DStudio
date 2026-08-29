#!/bin/sh
# Run Ideogram 4 FP8 through a pinned, local ComfyUI/Metal environment.
# Setup never loads weights; the heavyweight lock covers only the one-shot
# server that loads and releases the model.
set -eu

if [ "$#" -lt 3 ] || [ "$#" -gt 5 ]; then
    echo "usage: $0 PROMPT_FILE OUTDIR STATUS_FILE [ASPECT] [SEED]" >&2
    exit 2
fi

prompt_file=$1
outdir=$2
status_file=$3
aspect=${4:-16:9}
seed=${5:-0}

script_dir=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
runtime_root=${DSTUDIO_IDEOGRAM4_HOME:-${HOME}/.dstudio/ideogram4}
comfy_root=$runtime_root/comfyui
venv_root=$runtime_root/venv
python_bin=$venv_root/bin/python

if [ "${DSTUDIO_IDEOGRAM4_TEST_MODE:-0}" = 1 ]; then
    exec /usr/bin/python3 "$script_dir/heavy-model-lock.py" --kind ideogram4-fp8 -- \
        /usr/bin/python3 "$script_dir/ideogram4-run.py" \
        --prompt-file "$prompt_file" --outdir "$outdir" --status-file "$status_file" \
        --aspect "$aspect" --seed "$seed"
fi

comfy_repo=https://github.com/comfyanonymous/ComfyUI.git
comfy_commit=b78cec879b9460d5cb25228a83a942fb78d2cd24
fp8_repo=https://github.com/pawel-mazurkiewicz/ComfyUI-AppleSilicon-FP8.git
fp8_commit=911294ca35093eef56f7f2695414ff8810e88e50
ideogram_node_repo=https://github.com/ideogram-oss/ComfyUI-Ideogram4.git
ideogram_node_commit=c05545d71e61b7ce47534a972eaeefd958a3719f
model_repo=Comfy-Org/Ideogram-4
model_revision=bbee2ab2b14b2b5223448d12d6e31e5f9cec0546

find_cmd() {
    command -v "$1" 2>/dev/null || {
        for candidate in "/opt/homebrew/bin/$1" "/usr/local/bin/$1" "/usr/bin/$1"; do
            if [ -x "$candidate" ]; then
                echo "$candidate"
                return 0
            fi
        done
        return 1
    }
}

ensure_repo() {
    destination=$1
    repository=$2
    revision=$3
    if [ ! -d "$destination/.git" ]; then
        mkdir -p "$(dirname -- "$destination")"
        "$(find_cmd git)" clone --filter=blob:none --no-checkout "$repository" "$destination"
    fi
    current=$("$(find_cmd git)" -C "$destination" rev-parse HEAD 2>/dev/null || true)
    if [ "$current" != "$revision" ] || [ ! -f "$destination/README.md" ]; then
        "$(find_cmd git)" -C "$destination" fetch --depth=1 origin "$revision"
        "$(find_cmd git)" -C "$destination" switch --detach "$revision"
    fi
    current=$("$(find_cmd git)" -C "$destination" rev-parse HEAD 2>/dev/null || true)
    if [ "$current" != "$revision" ] || \
       ! "$(find_cmd git)" -C "$destination" diff --quiet --ignore-submodules --; then
        echo "Ideogram runtime checkout is not the clean pinned revision: $destination" >&2
        exit 3
    fi
}

mkdir -p "$runtime_root"
ensure_repo "$comfy_root" "$comfy_repo" "$comfy_commit"
ensure_repo "$comfy_root/custom_nodes/ComfyUI-AppleSilicon-FP8" "$fp8_repo" "$fp8_commit"
ensure_repo "$comfy_root/custom_nodes/ComfyUI-Ideogram4" "$ideogram_node_repo" "$ideogram_node_commit"

setup_marker=$runtime_root/.runtime-revisions-v1
expected_marker="comfy=$comfy_commit
fp8=$fp8_commit
ideogram-node=$ideogram_node_commit"
if [ ! -x "$python_bin" ] || [ ! -f "$setup_marker" ] || [ "$(cat "$setup_marker" 2>/dev/null || true)" != "$expected_marker" ]; then
    uv_bin=$(find_cmd uv) || {
        echo "uv is required for the Ideogram 4 runtime (install with: brew install uv)" >&2
        exit 127
    }
    if [ ! -x "$python_bin" ]; then
        "$uv_bin" venv --python 3.12 "$venv_root"
    fi
    "$uv_bin" pip install --python "$python_bin" -r "$comfy_root/requirements.txt"
    "$uv_bin" pip install --python "$python_bin" -r "$comfy_root/custom_nodes/ComfyUI-AppleSilicon-FP8/requirements.txt"
    "$uv_bin" pip install --python "$python_bin" -r "$comfy_root/custom_nodes/ComfyUI-Ideogram4/requirements.txt"
    "$uv_bin" pip install --python "$python_bin" ninja
    printf '%s\n' "$expected_marker" > "$setup_marker"
fi

models_root=$comfy_root/models
cond_model=$models_root/diffusion_models/ideogram4_fp8_scaled.safetensors
uncond_model=$models_root/diffusion_models/ideogram4_unconditional_fp8_scaled.safetensors
text_model=$models_root/text_encoders/qwen3vl_8b_fp8_scaled.safetensors
vae_model=$models_root/vae/flux2-vae.safetensors
model_marker=$runtime_root/.model-revision-v1
if [ ! -s "$cond_model" ] || [ ! -s "$uncond_model" ] || [ ! -s "$text_model" ] || [ ! -s "$vae_model" ]; then
    model_ready=0
else
    model_ready=1
fi
if [ "$model_ready" = 0 ] || [ ! -f "$model_marker" ] || \
   [ "$(cat "$model_marker" 2>/dev/null || true)" != "$model_revision" ]; then
    hf_bin=$(find_cmd hf) || {
        echo "Hugging Face CLI is required for the Ideogram 4 weights" >&2
        exit 127
    }
    "$hf_bin" download "$model_repo" \
        diffusion_models/ideogram4_fp8_scaled.safetensors \
        diffusion_models/ideogram4_unconditional_fp8_scaled.safetensors \
        text_encoders/qwen3vl_8b_fp8_scaled.safetensors \
        vae/flux2-vae.safetensors \
        --revision "$model_revision" --local-dir "$models_root"
    "$hf_bin" cache verify "$model_repo" --revision "$model_revision" \
        --local-dir "$models_root" --format agent
    printf '%s\n' "$model_revision" > "$model_marker"
fi

exec /usr/bin/python3 "$script_dir/heavy-model-lock.py" --kind ideogram4-fp8 -- \
    "$python_bin" "$script_dir/ideogram4-run.py" \
    --prompt-file "$prompt_file" --outdir "$outdir" --status-file "$status_file" \
    --aspect "$aspect" --seed "$seed"
