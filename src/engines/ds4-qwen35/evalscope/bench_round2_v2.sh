#!/bin/bash
# Round 2 - v2 (sostituisce bench_round2_full.sh, fasi Ornith gia' completate).
# Riordino: q35-default8 resume -> no-think x2 (verdetto in serata) ->
# experts20+thr0.8 con reasoning (overnight) -> report + restore server.
# Il marker finale e' identico a quello atteso da retry32k.sh.
cd /Users/agrilv/AI/antirez/ds4 || exit 1

PY=/Users/agrilv/venv312/bin/evalscope
QWEN=/Users/agrilv/AI/models/Qwen3.6-35B-A3B-UD-6b_XL/Qwen3.6-35B-A3B-UD-Q6_K_XL.gguf
API=http://127.0.0.1:8000/v1/chat/completions
PRO_ARGS='{"mmlu_pro": {"few_shot_num": 0}}'
GEN='{"max_tokens": 8192, "temperature": 0, "timeout": 1800}'
# reasoning off: extra_body finisce nel body top-level della request,
# il server mappa reasoning_effort "none" -> DS4_THINK_NONE (prefisso
# <think></think> vuoto nel template ChatML).
GEN_NT='{"max_tokens": 4096, "temperature": 0, "timeout": 900, "extra_body": {"reasoning_effort": "none"}}'

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
    wait_server || { echo "FATAL: server did not come up ($*)" >> ./evalscope/timeline.log; exit 1; }
}

run_pro() { # $1=model-id  $2=workdir  $3=gen-config  $4=model-path; rest = flag server
    local mid="$1" wd="$2" gen="$3" mp="$4"; shift 4
    stop_server
    start_server -m "$mp" "$@"
    echo "=== $(date '+%F %H:%M:%S') R2-RUN $mid start ===" >> ./evalscope/timeline.log
    "$PY" eval --eval-type openai_api \
        --model deepseek-v4-flash --model-id "$mid" \
        --api-url "$API" --api-key EMPTY \
        --datasets mmlu_pro --dataset-args "$PRO_ARGS" --limit 15 \
        --generation-config "$gen" --no-collect-perf --dataset-hub huggingface \
        --use-cache "$wd" \
        --work-dir "$wd" --no-timestamp >> "$wd.log" 2>&1
    echo "=== $(date '+%F %H:%M:%S') R2-RUN $mid done ===" >> ./evalscope/timeline.log
    cp server.log "$wd/server-pro2-phase.log" 2>/dev/null
}

# --- Qwen default8, reasoning ON: resume dei ~60 campioni rimasti ---
run_pro q35-default8 ./evalscope/runB-pro-full "$GEN" "$QWEN"

# --- Qwen no-think: stesse 210 domande, risposta diretta ---
run_pro q35-default8-nothink        ./evalscope/runB-pro-nothink "$GEN_NT" "$QWEN"
run_pro q35-experts20-thr08-nothink ./evalscope/runA-pro-nothink "$GEN_NT" "$QWEN" --q35-experts 20 --q35-expert-threshold 0.8

python3 ./evalscope/report_mmlupro.py ./evalscope/comparison_nothink.md \
    "MMLU-Pro Qwen3.6-35B reasoning OFF: default8 vs experts20+thr0.8 (210/cfg)" \
    q35-default8-nothink ./evalscope/runB-pro-nothink \
    q35-experts20-thr08-nothink ./evalscope/runA-pro-nothink
echo "=== $(date '+%F %H:%M:%S') R2 NOTHINK REPORT DONE ===" >> ./evalscope/timeline.log

# --- Qwen experts20+thr0.8+decay, reasoning ON (il giro lungo, overnight) ---
run_pro q35-experts20-thr08-decay ./evalscope/runA-pro-full "$GEN" "$QWEN" --q35-experts 20 --q35-expert-threshold 0.8

# --- Report finali ---
python3 ./evalscope/report_mmlupro.py ./evalscope/comparison_ornith.md \
    "MMLU-Pro Ornith-1.5-35B: default top-8 vs experts20+thr0.8 (210/cfg)" \
    ornith-default8 ./evalscope/ornithB-pro-full \
    ornith-experts20-thr08 ./evalscope/ornithA-pro-full
python3 ./evalscope/report_mmlupro.py ./evalscope/comparison_round2.md \
    "MMLU-Pro Round 2: Ornith vs Qwen3.6-35B, default8 vs experts20+thr0.8 (210/cfg)" \
    ornith-default8 ./evalscope/ornithB-pro-full \
    ornith-experts20-thr08 ./evalscope/ornithA-pro-full \
    q35-default8 ./evalscope/runB-pro-full \
    q35-experts20-thr08-decay ./evalscope/runA-pro-full
echo "=== $(date '+%F %H:%M:%S') R2 ALL DONE ===" >> ./evalscope/timeline.log

# --- Ripristino configurazione utente (Qwen + flag) ---
stop_server
start_server -m "$QWEN" --q35-experts 20 --q35-expert-threshold 0.8
echo "=== $(date '+%F %H:%M:%S') R2 server restored (Qwen experts20+thr0.8) ===" >> ./evalscope/timeline.log
