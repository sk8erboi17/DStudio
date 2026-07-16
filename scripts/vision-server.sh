#!/bin/sh
# DStudio — local vision model server (llama.cpp, OpenAI-compatible, cross-platform).
#
# ds4 is text-only; image understanding is delegated to this sidecar, which
# dstudio.c starts on demand and proxies via /api/vision/describe. llama-server's
# -hf auto-downloads the Qwen2.5-VL GGUF + its mmproj on first run (cached after).
#
# This script runs llama-server as a CHILD and stays alive as a tiny watchdog:
# dstudio touches $DIR/.last-use on every vision request, and once the server
# has been healthy at least once, an idle period longer than IDLE_MIN shuts it
# down (a 3-7B VL model would otherwise sit on multiple GB of RAM forever, even
# after DStudio quits). With the model already cached, the next request just
# respawns it in seconds.
#
# Override via env:
#   DSTUDIO_VISION_PORT      (default 28100)
#   DSTUDIO_VISION_HOST      (default 127.0.0.1)
#   DSTUDIO_VISION_HF        (default: $DIR/.hf if present, else the 7B repo;
#                             the UI writes .hf when switching 3B <-> 7B)
#   DSTUDIO_VISION_DIR       (default $HOME/.dstudio/llama-vision)
#   DSTUDIO_VISION_CTX       (default 12288) — explicit -c: multi-image requests
#                            with --image-min-tokens 1024 need real headroom
#   DSTUDIO_VISION_NGL       (default 999)   — full GPU offload where available
#   DSTUDIO_VISION_IDLE_MIN  (default 20)    — idle minutes before auto-shutdown
#   DSTUDIO_VISION_BOOT_MAX  (default 5400)  — seconds allowed to become healthy
#                            (covers the one-time multi-GB -hf download)
set -eu

PORT="${DSTUDIO_VISION_PORT:-28100}"
HOST="${DSTUDIO_VISION_HOST:-127.0.0.1}"
DIR="${DSTUDIO_VISION_DIR:-$HOME/.dstudio/llama-vision}"
HFREPO="${DSTUDIO_VISION_HF:-$(cat "$DIR/.hf" 2>/dev/null || echo ggml-org/Qwen2.5-VL-7B-Instruct-GGUF)}"
CTX="${DSTUDIO_VISION_CTX:-12288}"
NGL="${DSTUDIO_VISION_NGL:-999}"
IDLE_MIN="${DSTUDIO_VISION_IDLE_MIN:-20}"
BOOT_MAX="${DSTUDIO_VISION_BOOT_MAX:-5400}"

SERVER="$(find "$DIR" -name llama-server -type f 2>/dev/null | head -1 || true)"
[ -n "$SERVER" ] || { echo "vision-server: llama-server not installed — run vision setup first" >&2; exit 127; }

# Single-instance guard: don't start a second llama-server (they'd fight over
# the port, and during the first-run model download the port isn't open yet so
# a bare port check wouldn't catch it). The lock holds llama-server's pid; a
# reboot can hand that pid to an unrelated process, so also verify the process
# name before trusting it.
mkdir -p "$DIR"
LOCK="$DIR/.server.pid"
STAMP="$DIR/.last-use"
if [ -f "$LOCK" ]; then
  oldpid="$(cat "$LOCK" 2>/dev/null || true)"
  if [ -n "$oldpid" ] && kill -0 "$oldpid" 2>/dev/null &&
     ps -p "$oldpid" -o comm= 2>/dev/null | grep -q "llama-server"; then
    echo "vision-server: already running (pid $oldpid)" >&2
    exit 0
  fi
  rm -f "$LOCK"
fi

# Make the bundled shared libs resolvable regardless of cwd.
BINDIR="$(dirname "$SERVER")"
export DYLD_LIBRARY_PATH="$BINDIR:${DYLD_LIBRARY_PATH:-}"
export LD_LIBRARY_PATH="$BINDIR:${LD_LIBRARY_PATH:-}"

# --image-min-tokens 1024: Qwen-VL needs >=1024 image tokens for accurate
# grounding (llama-server warns about this); raising the floor improves precision.
MINTOK="${DSTUDIO_VISION_MIN_IMG_TOKENS:-1024}"
echo "vision-server: $SERVER -hf $HFREPO --host $HOST --port $PORT -c $CTX -ngl $NGL --image-min-tokens $MINTOK (idle-stop ${IDLE_MIN}m)" >&2
"$SERVER" -hf "$HFREPO" --host "$HOST" --port "$PORT" \
          -c "$CTX" -ngl "$NGL" --image-min-tokens "$MINTOK" &
CHILD=$!
echo "$CHILD" > "$LOCK"
touch "$STAMP"

cleanup() {
  kill "$CHILD" 2>/dev/null || true
  rm -f "$LOCK"
}
trap cleanup EXIT
trap 'exit 0' TERM INT

# Watchdog: reap on idle once healthy; give up on a boot that never gets there
# (wedged download). All health probes are local and cheap.
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
      echo "vision-server: never became healthy within ${BOOT_MAX}s — giving up" >&2
      exit 0
    fi
    continue
  fi
  # Healthy at least once: reap after IDLE_MIN minutes without a vision request.
  if [ "$healthy" = 1 ] && [ -n "$(find "$STAMP" -mmin "+$IDLE_MIN" 2>/dev/null)" ]; then
    echo "vision-server: idle for ${IDLE_MIN}m — shutting down (restarts on demand)" >&2
    exit 0
  fi
done
echo "vision-server: llama-server exited" >&2
exit 0
