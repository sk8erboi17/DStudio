#!/bin/bash
# Benchmark q35 con evalscope: 3 configurazioni server, MMLU + HumanEval via OpenAI API locale.
cd /Users/agrilv/AI/antirez/ds4 || exit 1

PY=/Users/agrilv/venv312/bin/evalscope
MODEL=/Users/agrilv/AI/models/Qwen3.6-35B-A3B-UD-6b_XL/Qwen3.6-35B-A3B-UD-Q6_K_XL.gguf
API=http://127.0.0.1:8000/v1/chat/completions
MMLU_ARGS='{"mmlu": {"few_shot_num": 0, "subset_list": ["abstract_algebra","machine_learning","conceptual_physics","formal_logic","philosophy","econometrics","high_school_psychology","nutrition"]}}'
GEN='{"max_tokens": 4096, "temperature": 0, "timeout": 1200}'

wait_server() {
    for i in $(seq 1 120); do
        curl -s -o /dev/null -w "%{http_code}" --max-time 2 http://127.0.0.1:8000/v1/models 2>/dev/null | grep -q 200 && return 0
        sleep 5
    done
    echo "FATAL: server did not come up" >&2
    return 1
}

stop_server() { pkill -f "ds4-server -m" 2>/dev/null; sleep 3; }

start_server() {
    nohup ./ds4-server "$@" > server.log 2>&1 &
    wait_server || exit 1
}

run_suite() { # $1=model-id  $2=workdir-base
    local mid="$1" wd="$2"
    mkdir -p "$wd"
    echo "=== $(date '+%H:%M:%S') RUN $mid : mmlu ===" >> ./evalscope/timeline.log
    "$PY" eval --eval-type openai_api \
        --model deepseek-v4-flash --model-id "$mid" \
        --api-url "$API" --api-key EMPTY \
        --datasets mmlu --dataset-args "$MMLU_ARGS" --limit 4 \
        --generation-config "$GEN" --no-collect-perf --dataset-hub huggingface \
        --work-dir "$wd" --no-timestamp >> "$wd.log" 2>&1
    echo "=== $(date '+%H:%M:%S') RUN $mid : humaneval ===" >> ./evalscope/timeline.log
    "$PY" eval --eval-type openai_api \
        --model deepseek-v4-flash --model-id "$mid" \
        --api-url "$API" --api-key EMPTY \
        --datasets humaneval --limit 30 \
        --generation-config "$GEN" --no-collect-perf --dataset-hub huggingface \
        --work-dir "$wd" --no-timestamp >> "$wd.log" 2>&1
    cp server.log "$wd/server-phase.log" 2>/dev/null
}

# ---- Run A: configurazione attuale (experts 20 + threshold 0.8 + decay 99-50)
stop_server
start_server -m "$MODEL" --q35-experts 20 --q35-expert-threshold 0.8
run_suite q35-experts20-thr08-decay ./evalscope/runA-experts20-thr08-decay

# ---- Run B: default (8 esperti, nessun flag)
stop_server
start_server -m "$MODEL"
run_suite q35-default8 ./evalscope/runB-default8

# ---- Run C: experts 20 + threshold 0.8 senza decay
stop_server
start_server -m "$MODEL" --q35-experts 20 --q35-expert-threshold 0.8 --q35-no-expert-decay
run_suite q35-experts20-thr08-nodecay ./evalscope/runC-experts20-thr08-nodecay

# ---- Ripristino configurazione utente
stop_server
start_server -m "$MODEL" --q35-experts 20 --q35-expert-threshold 0.8
echo "=== $(date '+%H:%M:%S') ALL DONE, server restored ===" >> ./evalscope/timeline.log
