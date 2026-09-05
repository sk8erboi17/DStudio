#!/bin/sh
# One entry point for managed engines; upstream download_model.sh stays intact.
set -eu
case "${1:---help}" in
  --help|-h|help)
    echo 'Usage: ./download-model.sh TARGET [upstream downloader options]'
    echo '  ds4f-q2, ds4f-vision-q2, glm53-q2, glm53-vision -> ds4/main'
    echo '  laguna-q4                                  -> Laguna S 2.1'
    echo '  qwen38-q4k                                 -> Qwen3.8-Flash-Next'
    echo 'Downloads are real and resumable. Models share ds4/gguf.'
    echo 'Qwen downloads and verifies base + PLE (~105.4 GB); no redundant MTP base.'
    echo 'DStudio currently supports Qwen Chat/native only.'
    exit 0 ;;
  laguna-q4) engine=laguna; directory=ds4-laguna-s21 ;;
  qwen38-q4k) engine=qwen; directory=ds4-qwen38 ;;
  ds4f-*|glm53-*|pro-*) engine=main; directory=ds4 ;;
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
if [ "$engine" = qwen ]; then
  shift
  exec python3 "$project_root/scripts/download-qwen38.py" --directory "$project_root/ds4/gguf" "$@"
fi
exec sh ./download_model.sh "$@"
