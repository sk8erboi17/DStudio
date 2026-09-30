#!/bin/bash
# Retry nothink: rigenera a 30K i campioni nothink troncati sul cap 4096
# (stesso principio del retry32k sui think: temp 0 = il prefisso e' lo
# stesso, il limite alto lascia finire la derivazione).
# Catena: aspetta R2-RETRY32K ALL DONE (retry think) + il tempo che
# matrix_watcher scriva la prima 2x2, poi rigenera i troncati nothink e
# riscrive comparison_nothink.md + comparison_qwen_2x2.md con i numeri puliti.
cd /Users/agrilv/AI/antirez/ds4 || exit 1

PYE=/Users/agrilv/venv312/bin/evalscope
QWEN=/Users/agrilv/AI/models/Qwen3.6-35B-A3B-UD-6b_XL/Qwen3.6-35B-A3B-UD-Q6_K_XL.gguf
API=http://127.0.0.1:8000/v1/chat/completions
PRO_ARGS='{"mmlu_pro": {"few_shot_num": 0}}'
GEN_NT30K='{"max_tokens": 30000, "temperature": 0, "timeout": 2400, "extra_body": {"reasoning_effort": "none"}}'

while ! grep -q "R2-RETRY32K ALL DONE" evalscope/timeline.log; do
    sleep 300
done
sleep 300  # lascia scrivere la prima 2x2 al matrix_watcher

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
    wait_server || { echo "FATAL: server did not come up ($*)" >> evalscope/timeline.log; exit 1; }
}

strip_truncated() { # $1=wd  $2=mid — rimuove le righe troncate, backup in predictions_4096pure/
    python3 - "$1" "$2" <<'PYEOF'
import glob, json, os, re, shutil, sys
wd, mid = sys.argv[1], sys.argv[2]
base = os.path.join(wd, "predictions", mid)
backup = os.path.join(wd, "predictions_4096pure", mid)
if not os.path.isdir(base):
    print(f"{mid}: nessuna predictions, skip"); sys.exit(0)
os.makedirs(os.path.dirname(backup), exist_ok=True)
if not os.path.isdir(backup):
    shutil.copytree(base, backup)
removed = kept = 0
for f in glob.glob(os.path.join(base, "*.jsonl")):
    out = []
    for line in open(f, errors="replace"):
        s = line.strip()
        if not s:
            continue
        try:
            r = json.loads(s)
        except Exception:
            out.append(line); continue
        raw = r.get("model_output", "")
        if not isinstance(raw, str):
            raw = str(raw)
        sr = re.search(r"'stop_reason': '(\w+)'", raw)
        if sr and sr.group(1) in ("max_tokens", "length"):
            removed += 1
        else:
            out.append(line); kept += 1
    open(f, "w").write("".join(out))
print(f"{mid}: rigenero {removed} troncati (backup 4096 in predictions_4096pure), tenuti {kept}")
PYEOF
}

retry_nt() { # $1=model-id  $2=workdir; rest = flag server
    local mid="$1" wd="$2"; shift 2
    [ -d "$wd/predictions/$mid" ] || { echo "skip $mid"; return; }
    stop_server
    start_server -m "$QWEN" "$@"
    strip_truncated "$wd" "$mid" >> evalscope/retry32k.log
    echo "=== $(date '+%F %H:%M:%S') R2-NOTHINK-RETRY $mid start ===" >> evalscope/timeline.log
    "$PYE" eval --eval-type openai_api \
        --model deepseek-v4-flash --model-id "$mid" \
        --api-url "$API" --api-key EMPTY \
        --datasets mmlu_pro --dataset-args "$PRO_ARGS" --limit 15 \
        --generation-config "$GEN_NT30K" --no-collect-perf --dataset-hub huggingface \
        --use-cache "$wd" \
        --work-dir "$wd" --no-timestamp >> "$wd.log" 2>&1
    echo "=== $(date '+%F %H:%M:%S') R2-NOTHINK-RETRY $mid done ===" >> evalscope/timeline.log
    cp server.log "$wd/server-retry-nothink-phase.log" 2>/dev/null
}

retry_nt q35-default8-nothink        evalscope/runB-pro-nothink
retry_nt q35-experts20-thr08-nothink evalscope/runA-pro-nothink --q35-experts 20 --q35-expert-threshold 0.8

python3 evalscope/report_mmlupro.py evalscope/comparison_nothink.md \
    "MMLU-Pro Qwen3.6-35B reasoning OFF: default8 vs experts20+thr0.8 (210/cfg; 4096 + retry 30K sui troncati)" \
    q35-default8-nothink evalscope/runB-pro-nothink \
    q35-experts20-thr08-nothink evalscope/runA-pro-nothink
python3 evalscope/report_mmlupro.py evalscope/comparison_qwen_2x2.md \
    "MMLU-Pro Qwen3.6-35B matrice 2x2: routing (default8 vs experts20+thr0.8) x reasoning (on/off), 210/cfg (troncati rigenerati a 30K)" \
    q35-default8 evalscope/runB-pro-full \
    q35-experts20-thr08-decay evalscope/runA-pro-full \
    q35-default8-nothink evalscope/runB-pro-nothink \
    q35-experts20-thr08-nothink evalscope/runA-pro-nothink
echo "=== $(date '+%F %H:%M:%S') R2-NOTHINK-RETRY ALL DONE ===" >> evalscope/timeline.log

stop_server
start_server -m "$QWEN" --q35-experts 20 --q35-expert-threshold 0.8
echo "=== $(date '+%F %H:%M:%S') R2 server restored (Qwen experts20+thr0.8) after nothink retry ===" >> evalscope/timeline.log
