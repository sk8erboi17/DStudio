#!/bin/bash
# GPQA-Diamond-MC (198q) paired chain, domain-interleaved:
#   bio gate39 -> physics def8 (resumes) -> physics gate39 -> chem def8 -> chem gate39
# 8K reasoning budget, temp 0, serial decode, ctx 65536 (NOT the default 32768!).
# Biology def8 (19q) already complete; cache reuse keeps everything else intact.
cd /Users/agrilv/AI/antirez/ds4 || exit 1

PYE=/Users/agrilv/venv312/bin/python
QWEN=/Users/agrilv/AI/models/Qwen3.6-35B-A3B-UD-6b_XL/Qwen3.6-35B-A3B-UD-Q6_K_XL.gguf
LOG=evalscope/gpqa_chain.log
export DS4_METAL_QWEN35_SOURCE=metal/qwen35_lay_last.metal

wait_server() {
    for i in $(seq 1 120); do
        curl -s -o /dev/null -w "%{http_code}" --max-time 2 http://127.0.0.1:8000/v1/models 2>/dev/null | grep -q 200 && return 0
        sleep 5
    done
    return 1
}

stop_server() { pkill -f "ds4-server -m" 2>/dev/null; sleep 3; }

start_server() {
    nohup ./ds4-server "$@" > /tmp/gpqa_server.log 2>&1 &
    wait_server || { echo "FATAL: server did not come up ($*)" >> $LOG; exit 1; }
    grep -o "ctx=[0-9]*" /tmp/gpqa_server.log | head -1 >> $LOG
}

run_dom() { # $1=model-id  $2=workdir  $3=domain  $4...=extra server flags
    local mid="$1" wd="$2" dom="$3"; shift 3
    stop_server
    start_server -m "$QWEN" --ctx 65536 --port 8000 "$@"
    echo "=== $(date '+%F %H:%M:%S') GPQA $mid $dom start ===" >> $LOG
    "$PYE" evalscope/gpqa_run_one.py "$mid" "$wd" "$dom" >> "$wd.log" 2>&1
    echo "=== $(date '+%F %H:%M:%S') GPQA $mid $dom done rc=$? ===" >> $LOG
}

echo "=== GPQA INTERLEAVED CHAIN START $(date '+%F %H:%M:%S') ===" >> $LOG

# biology: def8 already done (19/19) -> gate39 first
run_dom q35-exp20-thr08-gate27-39-gpqa evalscope/gpqa-gate39 biology \
    --q35-experts 20 --q35-expert-threshold 0.8
# physics: def8 resumes from cache (11 done), then gate39
run_dom q35-default8-gpqa evalscope/gpqa-def8 physics
run_dom q35-exp20-thr08-gate27-39-gpqa evalscope/gpqa-gate39 physics \
    --q35-experts 20 --q35-expert-threshold 0.8
# chemistry
run_dom q35-default8-gpqa evalscope/gpqa-def8 chemistry
run_dom q35-exp20-thr08-gate27-39-gpqa evalscope/gpqa-gate39 chemistry \
    --q35-experts 20 --q35-expert-threshold 0.8

"$PYE" evalscope/export_gpqa_json.py >> $LOG 2>&1
echo "=== GPQA INTERLEAVED CHAIN ALL DONE $(date '+%F %H:%M:%S') ===" >> $LOG
