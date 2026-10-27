#!/bin/sh
# One entry point for managed engines; upstream download_model.sh stays intact.
set -eu
project_root=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
variant=0
case "${1:---help}" in
  --help|-h|help)
    echo 'Usage: ./download-model.sh TARGET [upstream downloader options]'
    echo '  ds4f-q2, ds4f-vision-q2, glm53-q2, glm53-vision -> ds4/main'
    echo '  ds41f-q2, ds41f-1017-vision                -> DeepSeek V4.1 Flash 1017 (Metal; antirez Q2 365.7 GB including disk-backed Engram + community 0.97 GB vision)'
    echo '  ds41f-q2-original, ds41f-q4, ds41f-vision  -> DeepSeek V4.1 Flash original checkpoint (Metal; Q2 365.7 GB, Q4 518.6 GB + 0.97 GB vision)'
    echo '  laguna-q4                                  -> Laguna S 2.1'
    echo '  qwen38-q2, qwen38-q4k                      -> Qwen3.8-Flash-Next on ds4/main'
    echo '  qwen36-q6                                  -> Qwen3.6-35B-A3B UD-Q6_K_XL on bundled llama.cpp (31.8 GB)'
    echo '  qwen27-q6                                  -> Qwen3.8-27B UD-Q6_K_XL + F16 projector on bundled llama.cpp (26.2 GB)'
    echo '  qwen36-mlx                                 -> Qwen3.6-35B-A3B MXFP8 on bundled MLX (Apple Silicon, 36.7 GB)'
    echo '  qwen36-*, qwen27-*                         -> every other pinned Qwen3.6-35B-A3B / Qwen3.8-27B quantization:'
    echo '                                                GGUF on llama.cpp (27B with its F16 projector) or MLX (Apple Silicon,'
    echo '                                                text only), for example qwen36-q4_k_m, qwen27-mlx-4bit'
    echo '  --list-qwen                                -> list every pinned Qwen variant, its engine and size'
    echo 'Downloads are real and resumable. Models share ds4/gguf; MLX folders live in ds4/mlx.'
    echo 'Every Qwen file is pinned to a repository revision, size and SHA-256 (scripts/qwen-variants.json).'
    echo 'Qwen Next: one verified GGUF with original BF16 n-grams (Q2 147.2 GB / Q4 177.3 GB).'
    echo 'Old base + Q4 PLE files are incompatible and are not deleted or converted.'
    echo 'Qwen3.6 and 27B: Chat, Agent, Cowork and Design on llama.cpp (built on first use; CMake required).'
    exit 0 ;;
  --list-qwen)
    exec python3 "$project_root/scripts/download-qwen-variant.py" --list ;;
  laguna-q4) engine=laguna; directory=ds4-laguna-s21 ;;
  qwen38-q2|qwen38-q4k) engine=main; directory=ds4 ;;
  qwen36-*|qwen27-*)
    # The catalog names the engine; an unknown id stops here (exit 2).
    engine=$(python3 "$project_root/scripts/download-qwen-variant.py" --variant "$1" --field engine) || exit 2
    directory=.; variant=1 ;;
  ds4f-*|ds41f-*|glm53-*|pro-*) engine=main; directory=ds4 ;;
  *) echo "Unknown target: $1 (see --help)" >&2; exit 2 ;;
esac
cd "$project_root"
# Incremental build also updates an existing binary that predates this CLI.
make dstudio
if [ "$engine" != main ] && [ ! -f ds4/ds4.c ]; then
  ./dstudio --install-engine main "$project_root"
fi
./dstudio --install-engine "$engine" "$project_root"
cd "$project_root/$directory"
if [ "$variant" = 1 ]; then
  target=$1
  shift
  exec python3 "$project_root/scripts/download-qwen-variant.py" --variant "$target" --root "$project_root/ds4" "$@"
fi
case "$1" in
  ds41f-q2|ds41f-q2-original|ds41f-1017-vision) DS4_GGUF_DIR=${DS4_GGUF_DIR:-"$project_root/ds4/gguf"}; export DS4_GGUF_DIR
    exec sh "$project_root/scripts/download-ds41-1017.sh" "$@" ;;
esac
exec sh ./download_model.sh "$@"
