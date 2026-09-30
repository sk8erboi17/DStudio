#!/bin/sh
set -eu

model=${Q36_TEST_MODEL:-gguf/Qwen3.6-35B-A3B-AntirezExperts-IQ2XXS-gateup-Q2K-down-Q8rest.gguf}
port=${Q36_TEST_SERVER_PORT:-$((20000 + $$ % 1000))}
tmp=$(mktemp -d /tmp/q36-server-bench.XXXXXX)
pid=

cleanup() {
    if [ -n "$pid" ]; then
        kill "$pid" 2>/dev/null || true
        wait "$pid" 2>/dev/null || true
    fi
    rm -rf "$tmp"
}
trap cleanup EXIT INT TERM

run_one() {
    label=$1
    sessions=$2
    fallback=$3
    pairs=$((sessions / 2))
    if [ "$pairs" -lt 1 ]; then pairs=1; fi
    log="$tmp/$label.log"

    batch_opt=
    if [ "$sessions" -gt 0 ]; then batch_opt="--batched-session $sessions"; fi
    if [ "$fallback" = 1 ]; then
        Q36_VK_SESSION_BATCH=0 Q36_SERVER_BATCH_LOG=1 \
        ./q36-server -m "$model" --vulkan --ctx 512 --prefill-chunk 8 \
            --tokens 24 $batch_opt --host 127.0.0.1 --port "$port" \
            >"$log" 2>&1 &
    else
        Q36_SERVER_BATCH_LOG=1 \
        ./q36-server -m "$model" --vulkan --ctx 512 --prefill-chunk 8 \
            --tokens 24 $batch_opt --host 127.0.0.1 --port "$port" \
            >"$log" 2>&1 &
    fi
    pid=$!

    ready=0
    for _ in $(seq 1 180); do
        if curl -fsS --max-time 1 "http://127.0.0.1:$port/v1/models" >/dev/null 2>&1; then
            ready=1
            break
        fi
        if ! kill -0 "$pid" 2>/dev/null; then
            cat "$log" >&2
            exit 1
        fi
        sleep 1
    done
    if [ "$ready" != 1 ]; then
        cat "$log" >&2
        exit 1
    fi

    printf '%s ' "$label"
    python3 tests/test_server_batching.py \
        --url "http://127.0.0.1:$port" --pairs "$pairs" --case short \
        --nonce "benchmark-short" --skip-continuations
    kill -TERM "$pid"
    wait "$pid"
    pid=

    printf '%s batch_distribution=' "$label"
    sed -n 's/.*decode batch count=\([0-9][0-9]*\).*/\1/p' "$log" |
        sort -n | uniq -c | awk '{printf "%s%s:%s", sep, $2, $1; sep=","} END {print ""}'
}

run_one old 0 0
run_one resident-1 1 0
run_one resident-2 2 0
run_one resident-4 4 0
run_one resident-8 8 0
run_one fallback-4 4 1
