#!/bin/sh
# DStudio-owned downloader for the DeepSeek V4.1 Flash 1017 checkpoint:
#   ds41f-q2           antirez's official 1017 Q2, the file upstream ds4 5379c1c's
#                      ds41f-q2 downloads (the vendored 0aaea5a download_model.sh
#                      still names the original Q2, and 5379c1c kept that file's
#                      SHA-256, so the digest here is the published 1017 one).
#   ds41f-1017-vision  the community 1017 vision sidecar (antirez publishes none);
#                      source revision 1bae0e10, the same as the 1017 Q2.
#   ds41f-q2-original  the original V4.1 Q2 (source revision df42c109), still
#                      published in the same repository; it pairs with the
#                      original sidecar (ds41f-vision) and resumes a download
#                      started before ds41f-q2 became the 1017 file.
# Each repository is pinned to a revision and every file is checked for exact
# size + SHA-256. Run from the ds4 checkout (cwd) or set DS4_GGUF_DIR.
# Usage: download-ds41-1017.sh ds41f-q2|ds41f-q2-original|ds41f-1017-vision [--token TOKEN]
#        download-ds41-1017.sh TARGET --print-pin   (repo revision file bytes sha256; no download)
set -eu

usage() {
    echo "Usage: $0 ds41f-q2|ds41f-q2-original|ds41f-1017-vision [--token TOKEN | --print-pin]" >&2
}

[ $# -ge 1 ] || { usage; exit 1; }
TARGET=$1
shift
case "$TARGET" in
    ds41f-q2)
        REPO="antirez/deepseek-v4.1-flash-gguf"
        REVISION="9dcee51692e6540f697141fc98b097e3c96492a3"
        FILE="DeepSeek-V4.1-Flash-1017-IQ2_XXS-Q2_K-imatrix.gguf"
        EXPECTED_BYTES=365713686528
        EXPECTED_SHA="5296e85ff64b42ecb62c8d0c0c54e1caa07e3df8e93112f2365ebbaed62ce93a" ;;
    ds41f-q2-original)
        REPO="antirez/deepseek-v4.1-flash-gguf"
        REVISION="9dcee51692e6540f697141fc98b097e3c96492a3"
        FILE="DeepSeek-V4.1-Flash-Q2.gguf"
        EXPECTED_BYTES=365713686528
        EXPECTED_SHA="1ce6a8f8806205c13330d7ca287bd198331dc5ca35ccc5d8a9a92a188a6f6f42" ;;
    ds41f-1017-vision)
        REPO="nazeshinjite/DeepSeek-V4.1-Flash-1017-ds4-GGUF"
        REVISION="796f58533a0e4b7a89cb006b22aeb44e783f0323"
        FILE="DeepSeek-V4.1-Flash-1017-Vision.gguf"
        EXPECTED_BYTES=970555552
        EXPECTED_SHA="861f1097e8686111fa23dc4a6bf139fd0c4cc114db2f1b4090a267f7683c0dbf" ;;
    -h|--help) usage; exit 0 ;;
    *) echo "Unknown target: $TARGET" >&2; usage; exit 1 ;;
esac

if [ "${1:-}" = --print-pin ]; then
    printf '%s %s %s %s %s\n' "$REPO" "$REVISION" "$FILE" "$EXPECTED_BYTES" "$EXPECTED_SHA"
    exit 0
fi

# Test-only oracle override. Production values above are never read from the
# environment unless the explicit test switch is set.
if [ "${DSTUDIO_DS41_1017_TEST_MODE:-0}" = 1 ]; then
    EXPECTED_BYTES=${DSTUDIO_DS41_1017_TEST_BYTES:?}
    EXPECTED_SHA=${DSTUDIO_DS41_1017_TEST_SHA:?}
fi

TOKEN=${HF_TOKEN:-}
while [ $# -gt 0 ]; do
    case "$1" in
        --token)
            shift
            [ $# -gt 0 ] || { echo "Missing value after --token" >&2; exit 1; }
            TOKEN=$1 ;;
        *) echo "Unknown option: $1" >&2; exit 1 ;;
    esac
    shift
done
if [ -z "$TOKEN" ] && [ -s "$HOME/.cache/huggingface/token" ]; then
    TOKEN=$(cat "$HOME/.cache/huggingface/token")
fi

ROOT=$(pwd)
OUT_DIR=${DS4_GGUF_DIR:-"$ROOT/gguf"}
case "$OUT_DIR" in
    /*) ;;
    *) OUT_DIR="$ROOT/$OUT_DIR" ;;
esac
OUT="$OUT_DIR/$FILE"
STAMP="$OUT.verified"

find_hf_command() {
    if command -v hf >/dev/null 2>&1; then
        printf '%s\n' hf
        return 0
    fi
    for dir in "$HOME"/Library/Python/*/bin "$HOME"/.local/bin; do
        if [ -x "$dir/hf" ]; then
            printf '%s\n' "$dir/hf"
            return 0
        fi
    done
    return 1
}

file_size() { wc -c < "$1" | tr -d ' '; }
file_mtime() { stat -c %Y "$1" 2>/dev/null || stat -f %m "$1"; }
sha_of() {
    if command -v sha256sum >/dev/null 2>&1; then
        sum=$(sha256sum < "$1")
    else
        sum=$(shasum -a 256 < "$1")
    fi
    printf '%s\n' "${sum%% *}"
}

# Set to 1 only after THIS run's `hf download` produced $OUT. It is the only case in which a failed
# verification deletes anything: the file this script just downloaded, by its exact path. A file that
# was already there (the stock app's weights folder is shared) is never removed or renamed.
JUST_DOWNLOADED=0

reject() {
    # Never accept the file. Remove the stamp (our own marker) and, if we just downloaded the bad
    # file, delete exactly that file so no multi-hundred-GB copy lingers in the shared folder.
    rm -f "$STAMP"
    echo "$1" >&2
    if [ "$JUST_DOWNLOADED" = 1 ]; then
        rm -f -- "$OUT"
        echo "The download failed verification and was deleted: $OUT. Run the download again." >&2
    else
        echo "This file was not downloaded by this run, so it was left untouched: $OUT" >&2
        echo "Delete it yourself if it is incomplete or corrupt, then run the download again." >&2
    fi
    exit 1
}

stamp_ok() {
    [ -f "$STAMP" ] || return 1
    read -r s_size s_mtime s_sha < "$STAMP" || return 1
    [ "$s_size" = "$EXPECTED_BYTES" ] && [ "$s_sha" = "$EXPECTED_SHA" ] &&
        [ "$s_size" = "$(file_size "$OUT")" ] && [ "$s_mtime" = "$(file_mtime "$OUT")" ]
}

verify() {
    if [ "$(file_size "$OUT")" -ne "$EXPECTED_BYTES" ]; then
        reject "Incorrect file size: $OUT (expected $EXPECTED_BYTES bytes)."
    fi
    if stamp_ok; then
        return 0
    fi
    echo "Verifying SHA-256: $OUT"
    actual=$(sha_of "$OUT")
    if [ "$actual" != "$EXPECTED_SHA" ]; then
        reject "Checksum mismatch: $OUT."
    fi
    printf '%s %s %s\n' "$EXPECTED_BYTES" "$(file_mtime "$OUT")" "$EXPECTED_SHA" > "$STAMP.tmp.$$"
    mv "$STAMP.tmp.$$" "$STAMP"
}

mkdir -p "$OUT_DIR"

if [ -s "$OUT" ]; then
    verify
    echo "Already downloaded: $OUT"
    exit 0
fi

HF_CMD=$(find_hf_command || true)
if [ -z "$HF_CMD" ]; then
    echo "Large GGUF downloads require the official Hugging Face CLI." >&2
    echo "Install it with:" >&2
    echo "  python3 -m pip install -U huggingface_hub hf_xet" >&2
    exit 1
fi

echo "Downloading $FILE"
echo "from https://huggingface.co/$REPO (revision $REVISION)"
echo "using $HF_CMD download"
echo "If the download stops, run the same command again to resume it."

# The token goes to hf through the environment, never argv (visible to every local user via ps).
if [ -n "$TOKEN" ]; then
    HF_TOKEN=$TOKEN
    export HF_TOKEN
fi
"$HF_CMD" download "$REPO" "$FILE" --repo-type model --revision "$REVISION" --local-dir "$OUT_DIR" --max-workers 1
JUST_DOWNLOADED=1

if [ ! -s "$OUT" ]; then
    echo "Hugging Face download finished but expected file is missing: $OUT" >&2
    exit 1
fi
verify
echo "Verified: $OUT"
