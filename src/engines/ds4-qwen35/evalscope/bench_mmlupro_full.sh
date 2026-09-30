#!/bin/bash
# Round 2: MMLU-Pro esteso (tutte le 14 materie x 15 domande = 210 per config),
# solo due configurazioni: B = originale (nessun flag), A = experts 20 + thr 0.8 + decay.
cd /Users/agrilv/AI/antirez/ds4 || exit 1

PY=/Users/agrilv/venv312/bin/evalscope
MODEL=/Users/agrilv/AI/models/Qwen3.6-35B-A3B-UD-6b_XL/Qwen3.6-35B-A3B-UD-Q6_K_XL.gguf
API=http://127.0.0.1:8000/v1/chat/completions
PRO_ARGS='{"mmlu_pro": {"few_shot_num": 0}}'
GEN='{"max_tokens": 4096, "temperature": 0, "timeout": 1200}'

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

run_pro() { # $1=model-id  $2=workdir  $3=server-args...
    local mid="$1" wd="$2"; shift 2
    stop_server
    start_server "$@"
    echo "=== $(date '+%H:%M:%S') PRO2-RUN $mid start ===" >> ./evalscope/timeline.log
    "$PY" eval --eval-type openai_api \
        --model deepseek-v4-flash --model-id "$mid" \
        --api-url "$API" --api-key EMPTY \
        --datasets mmlu_pro --dataset-args "$PRO_ARGS" --limit 15 \
        --generation-config "$GEN" --no-collect-perf --dataset-hub huggingface \
        --use-cache "$wd" \
        --work-dir "$wd" --no-timestamp >> "$wd.log" 2>&1
    echo "=== $(date '+%H:%M:%S') PRO2-RUN $mid done ===" >> ./evalscope/timeline.log
    cp server.log "$wd/server-pro2-phase.log" 2>/dev/null
}

# B: originale (default top-8)
run_pro q35-default8 ./evalscope/runB-pro-full -m "$MODEL"

# A: experts 20 + threshold 0.8 (decay attivo)
run_pro q35-experts20-thr08-decay ./evalscope/runA-pro-full -m "$MODEL" --q35-experts 20 --q35-expert-threshold 0.8

# Ripristino configurazione utente (= A)
stop_server
start_server -m "$MODEL" --q35-experts 20 --q35-expert-threshold 0.8
echo "=== $(date '+%H:%M:%S') PRO2 ALL DONE, server restored ===" >> ./evalscope/timeline.log
