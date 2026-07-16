#!/bin/sh
# DStudio — local text-embedding server (llama.cpp, OpenAI-compatible).
#
# Powers SEMANTIC skill search: the DStudio server embeds skill descriptions once
# and embeds each agent/UI query, then ranks by cosine. This is a SEPARATE
# llama-server from the vision sidecar (different port, dir, model), run in
# embedding mode. Same install/watchdog pattern as scripts/vision-server.sh:
# dstudio.c touches $DIR/.last-use on every embed request and this wrapper
# self-reaps after an idle period so the model does not sit resident forever.
#
# The llama-server binary is shared with the vision runtime (same llama.cpp
# release); only a small embedding GGUF is fetched by -hf on first run.
#
# Override via env:
#   DSTUDIO_EMBED_PORT      (default 28101)
#   DSTUDIO_EMBED_HOST      (default 127.0.0.1)
#   DSTUDIO_EMBED_HF        (default: $DIR/.hf if present, else Qwen3-Embedding-0.6B;
#                            MUST be a multilingual embedding model — queries arrive
#                            in the user's own language)
#   DSTUDIO_EMBED_DIR       (default $HOME/.dstudio/llama-embed)
#   DSTUDIO_EMBED_BIN_DIR   (fallback dir to find llama-server if not in EMBED_DIR;
#                            default $HOME/.dstudio/llama-vision — reuse the vision binary)
#   DSTUDIO_EMBED_CTX       (default 8192)  — max input tokens per embed request
#   DSTUDIO_EMBED_NGL       (default 999)   — GPU offload
#   DSTUDIO_EMBED_IDLE_MIN  (default 20)    — idle minutes before auto-shutdown
#   DSTUDIO_EMBED_BOOT_MAX  (default 3600)  — seconds allowed to become healthy
set -eu

PORT="${DSTUDIO_EMBED_PORT:-28101}"
HOST="${DSTUDIO_EMBED_HOST:-127.0.0.1}"
DIR="${DSTUDIO_EMBED_DIR:-$HOME/.dstudio/llama-embed}"
BIN_DIR="${DSTUDIO_EMBED_BIN_DIR:-$HOME/.dstudio/llama-vision}"
HFREPO="${DSTUDIO_EMBED_HF:-$(cat "$DIR/.hf" 2>/dev/null || echo Qwen/Qwen3-Embedding-0.6B-GGUF:Q8_0)}"
CTX="${DSTUDIO_EMBED_CTX:-8192}"
NGL="${DSTUDIO_EMBED_NGL:-999}"
IDLE_MIN="${DSTUDIO_EMBED_IDLE_MIN:-20}"
BOOT_MAX="${DSTUDIO_EMBED_BOOT_MAX:-3600}"

# Find llama-server: prefer the embed dir, else reuse the vision runtime's binary.
SERVER="$(find "$DIR" -name llama-server -type f 2>/dev/null | head -1 || true)"
[ -n "$SERVER" ] || SERVER="$(find "$BIN_DIR" -name llama-server -type f 2>/dev/null | head -1 || true)"
[ -n "$SERVER" ] || { echo "embed-server: llama-server not installed — run embed setup first" >&2; exit 127; }

mkdir -p "$DIR"
LOCK="$DIR/.server.pid"
STAMP="$DIR/.last-use"
if [ -f "$LOCK" ]; then
  oldpid="$(cat "$LOCK" 2>/dev/null || true)"
  if [ -n "$oldpid" ] && kill -0 "$oldpid" 2>/dev/null &&
     ps -p "$oldpid" -o comm= 2>/dev/null | grep -q "llama-server"; then
    echo "embed-server: already running (pid $oldpid)" >&2
    exit 0
  fi
  rm -f "$LOCK"
fi

BINDIR="$(dirname "$SERVER")"
export DYLD_LIBRARY_PATH="$BINDIR:${DYLD_LIBRARY_PATH:-}"
export LD_LIBRARY_PATH="$BINDIR:${LD_LIBRARY_PATH:-}"

# --embeddings puts llama-server in embedding mode (serves /v1/embeddings). No
# --pooling: let the model's own default (Qwen3-Embedding uses last-token) apply.
echo "embed-server: $SERVER -hf $HFREPO --embeddings --host $HOST --port $PORT -c $CTX -ngl $NGL (idle-stop ${IDLE_MIN}m)" >&2
"$SERVER" -hf "$HFREPO" --embeddings --host "$HOST" --port "$PORT" -c "$CTX" -ngl "$NGL" &
CHILD=$!
echo "$CHILD" > "$LOCK"
touch "$STAMP"

cleanup() { kill "$CHILD" 2>/dev/null || true; rm -f "$LOCK"; }
trap cleanup EXIT
trap 'exit 0' TERM INT

started="$(date +%s)"
healthy=0
while kill -0 "$CHILD" 2>/dev/null; do
  sleep 30
  kill -0 "$CHILD" 2>/dev/null || break
  if curl -fsS -m 3 "http://$HOST:$PORT/health" >/dev/null 2>&1; then
    healthy=1
  elif [ "$healthy" = 0 ]; then
    now="$(date +%s)"
    if [ $((now - started)) -gt "$BOOT_MAX" ]; then
      echo "embed-server: never became healthy within ${BOOT_MAX}s — giving up" >&2
      exit 0
    fi
    continue
  fi
  if [ "$healthy" = 1 ] && [ -n "$(find "$STAMP" -mmin "+$IDLE_MIN" 2>/dev/null)" ]; then
    echo "embed-server: idle for ${IDLE_MIN}m — shutting down (restarts on demand)" >&2
    exit 0
  fi
done
echo "embed-server: llama-server exited" >&2
exit 0
