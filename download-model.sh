#!/bin/sh
# One entry point for managed engines; upstream download_model.sh stays intact.
set -eu
case "${1:---help}" in
  --help|-h|help)
    echo 'Usage: ./download-model.sh TARGET [upstream downloader options]'
    echo '  ds4f-q2, ds4f-vision-q2, glm53-q2, glm53-vision -> ds4/main'
    echo '  ds41f-q2, ds41f-q4, ds41f-vision             -> DeepSeek V4.1 Flash (Metal; Q2 365.7 GB including disk-backed Engram)'
    echo '  laguna-q4                                  -> Laguna S 2.1'
    echo '  qwen38-q2, qwen38-q4k                      -> Qwen3.8-Flash-Next on ds4/main'
    echo '  qwen36-q6                                  -> Qwen3.6-35B-A3B on bundled llama.cpp (31.8 GB)'
    echo '  qwen27-q6                                  -> Qwen3.8-27B + F16 projector on bundled llama.cpp (26.2 GB)'
    echo '  qwen36-mlx                                 -> Qwen3.6-35B-A3B MXFP8 on bundled MLX (Apple Silicon, 36.7 GB)'
    echo 'Downloads are real and resumable. Models share ds4/gguf.'
    echo 'Qwen Next: one verified GGUF with original BF16 n-grams (Q2 147.2 GB / Q4 177.3 GB).'
    echo 'Old base + Q4 PLE files are incompatible and are not deleted or converted.'
    echo 'Qwen3.6 and 27B: Chat, Agent, Cowork and Design on llama.cpp (built on first use; CMake required).'
    exit 0 ;;
  laguna-q4) engine=laguna; directory=ds4-laguna-s21 ;;
  qwen38-q2|qwen38-q4k) engine=main; directory=ds4 ;;
  qwen36-q6|qwen27-q6) engine=llama; directory=llama.cpp ;;
  qwen36-mlx) engine=mlx; directory=. ;;
  ds4f-*|ds41f-*|glm53-*|pro-*) engine=main; directory=ds4 ;;
  *) echo "Unknown target: $1 (see --help)" >&2; exit 2 ;;
esac
project_root=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
cd "$project_root"
# Incremental build also updates an existing binary that predates this CLI.
make dstudio
if [ "$engine" != main ] && [ ! -f ds4/ds4.c ]; then
  ./dstudio --install-engine main "$project_root"
fi
./dstudio --install-engine "$engine" "$project_root"
cd "$project_root/$directory"
if [ "$1" = qwen36-q6 ]; then
  shift
  exec python3 "$project_root/scripts/download-qwen35.py" --directory "$project_root/ds4/gguf" "$@"
fi
if [ "$1" = qwen36-mlx ]; then
  shift
  exec python3 "$project_root/scripts/download-mlx-qwen36.py" --directory "$project_root/ds4/mlx/Qwen3.6-35B-A3B-mxfp8" "$@"
fi
if [ "$1" = qwen27-q6 ]; then
  shift
  exec python3 "$project_root/scripts/download-qwen27.py" --directory "$project_root/ds4/gguf" "$@"
fi
exec sh ./download_model.sh "$@"
