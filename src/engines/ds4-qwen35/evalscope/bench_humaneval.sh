#!/bin/bash
# Fase 2: HumanEval per le 3 configurazioni (il dataset opencompass/humaneval e' sparito da HF;
# si usa openai/openai_humaneval via dataset_args). Attende la fine della catena MMLU principale.
cd /Users/agrilv/AI/antirez/ds4 || exit 1

PY=/Users/agrilv/venv312/bin/evalscope
MODEL=/Users/agrilv/AI/models/Qwen3.6-35B-A3B-UD-6b_XL/Qwen3.6-35B-A3B-UD-Q6_K_XL.gguf
API=http://127.0.0.1:8000/v1/chat/completions
HE_ARGS='{"humaneval": {"dataset_id": "openai/openai_humaneval"}}'
GEN='{"max_tokens": 4096, "temperature": 0, "timeout": 1200}'

# Attende la catena principale (timeout 5h)
for i in $(seq 1 600); do
    grep -q "ALL DONE, server restored" ./evalscope/timeline.log 2>/dev/null && break
    sleep 30
done
if ! grep -q "ALL DONE, server restored" ./evalscope/timeline.log 2>/dev/null; then
    echo "FATAL: main chain did not finish" >&2
    exit 1
fi

wait_server() {
    for i in $(seq 1 120); do
        curl -s -o /dev/null -w "%{http_code}" --max-time 2 http://127.0.0.1:8000/v1/models 2>/dev/null | grep -q 200 && return 0
        sleep 5
    done
    return 1
}

stop_server() { pkill -f "ds4-server -m" 2>/dev/null; sleep 3; }

start_server() {
    nohup ./ds4-server "$@" > server.log 2>&1 &
    wait_server || exit 1
}

run_he() { # $1=model-id  $2=workdir  $3=server-args...
    local mid="$1" wd="$2"; shift 2
    stop_server
    start_server "$@"
    echo "=== $(date '+%H:%M:%S') HE-RUN $mid ===" >> ./evalscope/timeline.log
    "$PY" eval --eval-type openai_api \
        --model deepseek-v4-flash --model-id "$mid" \
        --api-url "$API" --api-key EMPTY \
        --datasets humaneval --dataset-args "$HE_ARGS" --limit 30 \
        --generation-config "$GEN" --no-collect-perf --dataset-hub huggingface \
        --work-dir "$wd" --no-timestamp >> "$wd.log" 2>&1
    cp server.log "$wd/server-he-phase.log" 2>/dev/null
}

run_he q35-experts20-thr08-decay ./evalscope/runA-experts20-thr08-decay -m "$MODEL" --q35-experts 20 --q35-expert-threshold 0.8
run_he q35-default8               ./evalscope/runB-default8               -m "$MODEL"
run_he q35-experts20-thr08-nodecay ./evalscope/runC-experts20-thr08-nodecay -m "$MODEL" --q35-experts 20 --q35-expert-threshold 0.8 --q35-no-expert-decay

stop_server
start_server -m "$MODEL" --q35-experts 20 --q35-expert-threshold 0.8
echo "=== $(date '+%H:%M:%S') HE ALL DONE, server restored ===" >> ./evalscope/timeline.log
