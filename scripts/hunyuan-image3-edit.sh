#!/bin/sh
# Full HunyuanImage-3.0-Instruct editing at the official 50-step quality path.
# The complete Instruct model is NF4 only because BF16/INT8 cannot physically
# fit in this machine's 96 GB unified memory; no distilled model is used.
set -eu

setup_only=0
if [ "${1:-}" = "--setup-only" ]; then
    setup_only=1
    shift
elif [ "$#" -lt 4 ]; then
    echo "usage: $0 PROMPT_FILE OUTDIR STATUS_FILE INPUT [INPUT ...]" >&2
    echo "       $0 --setup-only" >&2
    exit 2
fi

if [ "$setup_only" = 0 ]; then
    prompt_file=$1
    outdir=$2
    status_file=$3
    shift 3
fi

script_dir=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
runtime_root=${DSTUDIO_HUNYUAN_IMAGE3_HOME:-${HOME}/.dstudio/hunyuan-image}
venv_root=$runtime_root/venv
python_bin=$venv_root/bin/python
model_dir=$runtime_root/models/HunyuanImage-3-Instruct-NF4-v2
model_repo=EricRollei/HunyuanImage-3.0-Instruct-NF4-v2
model_revision=98fda5c508c05f5407f036bca413149ca92c143b
base_model_repo=tencent/HunyuanImage-3.0-Instruct
base_model_revision=2ec2c78bee7d4b94157341fba86c4c2c7b1858b2

if [ "$setup_only" = 0 ] && [ "${DSTUDIO_HUNYUAN_IMAGE3_TEST_MODE:-0}" = 1 ]; then
    exec /usr/bin/python3 "$script_dir/heavy-model-lock.py" --kind hunyuan-image3-instruct-nf4 -- \
        /usr/bin/python3 "$script_dir/hunyuan-image3-edit.py" \
        --prompt-file "$prompt_file" --outdir "$outdir" --status-file "$status_file" -- "$@"
fi

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

mkdir -p "$runtime_root"
setup_marker=$runtime_root/.runtime-versions-v2
expected_marker='torch=2.15.0.dev20260821
torchvision=0.30.0.dev20260825
bitsandbytes=0.50.1
transformers=4.57.1
diffusers=0.35.2'
if [ ! -x "$python_bin" ] || [ ! -f "$setup_marker" ] || [ "$(cat "$setup_marker" 2>/dev/null || true)" != "$expected_marker" ]; then
    uv_bin=$(find_cmd uv) || {
        echo "uv is required for HunyuanImage-3.0-Instruct (install with: brew install uv)" >&2
        exit 127
    }
    if [ ! -x "$python_bin" ]; then
        "$uv_bin" venv --python 3.12 "$venv_root"
    fi
    "$uv_bin" pip install --python "$python_bin" \
        --index-url https://download.pytorch.org/whl/nightly/cpu \
        torch==2.15.0.dev20260821 torchvision==0.30.0.dev20260825
    "$uv_bin" pip install --python "$python_bin" \
        bitsandbytes==0.50.1 \
        einops==0.8.1 numpy==2.2.0 pillow==12.0.0 diffusers==0.35.2 \
        safetensors==0.7.0 tokenizers==0.22.0 'transformers[accelerate,tiktoken]==4.57.1' \
        'huggingface_hub[cli]==0.36.2' 'loguru>=0.7.3'
    printf '%s\n' "$expected_marker" > "$setup_marker"
fi

"$python_bin" "$script_dir/transformers-mps-warmup-backport.py" >/dev/null

hf_bin=$(find_cmd hf) || {
    echo "Hugging Face CLI is required for HunyuanImage-3.0-Instruct" >&2
    exit 127
}
model_marker=$model_dir/.dstudio-model-revision
if [ ! -f "$model_dir/model.safetensors.index.json" ] || \
   [ ! -f "$model_marker" ] || [ "$(cat "$model_marker" 2>/dev/null || true)" != "$model_revision" ]; then
    "$hf_bin" download "$model_repo" --revision "$model_revision" --local-dir "$model_dir"
    "$hf_bin" cache verify "$model_repo" --revision "$model_revision" \
        --local-dir "$model_dir" --format agent
    printf '%s\n' "$model_revision" > "$model_marker"
fi

# Build each runtime from immutable upstream source files.  The official
# Tencent revision supplies its native eager DeepSeek MoE; the NF4 repository
# supplies only its pinned pipeline/VAE companions.  Re-copying these tiny
# sources before the portability transform prevents stale runtime monkeypatches
# or prior local edits from entering production.
source_root=$runtime_root/source
tencent_source=$source_root/tencent-$base_model_revision
community_source=$source_root/community-$model_revision
mkdir -p "$tencent_source" "$community_source"

ensure_source() {
    repo=$1
    revision=$2
    directory=$3
    filename=$4
    expected_sha=$5
    source_file=$directory/$filename
    actual_sha=$(shasum -a 256 "$source_file" 2>/dev/null | awk '{print $1}' || true)
    if [ "$actual_sha" != "$expected_sha" ]; then
        "$hf_bin" download "$repo" "$filename" --revision "$revision" --local-dir "$directory"
        actual_sha=$(shasum -a 256 "$source_file" | awk '{print $1}')
    fi
    if [ "$actual_sha" != "$expected_sha" ]; then
        echo "Pinned Hunyuan source hash mismatch for $filename" >&2
        exit 3
    fi
}

ensure_source "$base_model_repo" "$base_model_revision" "$tencent_source" \
    modeling_hunyuan_image_3.py 0dd3ec2592ab7458534a6b22eb0c16864aaee9c1869e4a1422ab5e308e02a71b
ensure_source "$model_repo" "$model_revision" "$community_source" \
    modeling_hunyuan_image_3.py 7ec462c8a5b4a21f17fbd479432213d09cf6155336671121700c52d944577986
ensure_source "$model_repo" "$model_revision" "$community_source" \
    hunyuan_image_3_pipeline.py c15de3e4bddf1e00b2eb57f75394d1a394bf224dd9bb4d407b1dbb75fc0c3601
ensure_source "$model_repo" "$model_revision" "$community_source" \
    autoencoder_kl_3d.py 661da07e99b5d188a2f119b7eb481ea54bdc35831afb66ca76a83fbce361c5f1

cp "$community_source/modeling_hunyuan_image_3.py" "$model_dir/modeling_hunyuan_image_3.py"
cp "$community_source/hunyuan_image_3_pipeline.py" "$model_dir/hunyuan_image_3_pipeline.py"
cp "$community_source/autoencoder_kl_3d.py" "$model_dir/autoencoder_kl_3d.py"
"$python_bin" "$script_dir/hunyuan-image3-mps-patch.py" "$model_dir" \
    --official-modeling "$tencent_source/modeling_hunyuan_image_3.py"

if [ "$setup_only" = 1 ]; then
    echo "HunyuanImage-3.0-Instruct NF4 runtime ready: $model_dir"
    exit 0
fi

reasoning_file=$outdir/hunyuan-max-reasoning.json

# Run uncapped Max reasoning and diffusion in two strictly sequential model
# processes.  A fresh Metal allocator for diffusion avoids retaining or
# fragmenting state from the long text-generation phase.  The second process
# validates the artifact against the exact prompt, source bytes, seed, and
# pinned model revision before using it.
/usr/bin/python3 "$script_dir/heavy-model-lock.py" --kind hunyuan-image3-instruct-nf4 -- \
    "$python_bin" "$script_dir/hunyuan-image3-edit.py" \
    --prompt-file "$prompt_file" --outdir "$outdir" --status-file "$status_file" \
    --reasoning-output "$reasoning_file" -- "$@"

exec /usr/bin/python3 "$script_dir/heavy-model-lock.py" --kind hunyuan-image3-instruct-nf4 -- \
    "$python_bin" "$script_dir/hunyuan-image3-edit.py" \
    --prompt-file "$prompt_file" --outdir "$outdir" --status-file "$status_file" \
    --reasoning-file "$reasoning_file" -- "$@"
