#!/bin/bash
# Pass di retry: rigenera a 30K effettivi i campioni morti per budget
# (stop_reason=max_tokens) e riallinea i report. I campioni già completati
# restano quelli a 8192 (con temp 0 sono identici a come li avrebbe generati
# il limite alto). Uso: ./evalscope/retry32k.sh [--wait]
#   --wait  attende che bench_round2_full.sh finisca (marker nel timeline).
cd /Users/agrilv/AI/antirez/ds4 || exit 1

PYE=/Users/agrilv/venv312/bin/evalscope
QWEN=/Users/agrilv/AI/models/Qwen3.6-35B-A3B-UD-6b_XL/Qwen3.6-35B-A3B-UD-Q6_K_XL.gguf
ORN=/Users/agrilv/AI/models/Ornith-1.5-35B-Q6_K.gguf
API=http://127.0.0.1:8000/v1/chat/completions
PRO_ARGS='{"mmlu_pro": {"few_shot_num": 0}}'
GEN='{"max_tokens": 30000, "temperature": 0, "timeout": 5400}'

if [ "$1" = "--wait" ]; then
    while ! grep -q "R2 server restored (Qwen experts20+thr0.8)" evalscope/timeline.log; do
        sleep 300
    done
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
    wait_server || { echo "FATAL: server did not come up ($*)" >> evalscope/timeline.log; exit 1; }
}

strip_truncated() { # $1=wd  $2=mid — rimuove le righe troncate, backup in predictions_8192pure/
    python3 - "$1" "$2" <<'PYEOF'
import glob, json, os, re, shutil, sys
wd, mid = sys.argv[1], sys.argv[2]
base = os.path.join(wd, "predictions", mid)
backup = os.path.join(wd, "predictions_8192pure", mid)
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
print(f"{mid}: rigenero {removed} troncati (backup 8192 in predictions_8192pure), tenuti {kept}")
PYEOF
}

retry_pro() { # $1=model-id  $2=workdir  $3=model-path; rest = flag server
    local mid="$1" wd="$2" mp="$3"; shift 3
    [ -d "$wd/predictions/$mid" ] || { echo "skip $mid"; return; }
    stop_server
    start_server -m "$mp" "$@"
    strip_truncated "$wd" "$mid" >> evalscope/retry32k.log
    echo "=== $(date '+%F %H:%M:%S') R2-RETRY32K $mid start ===" >> evalscope/timeline.log
    "$PYE" eval --eval-type openai_api \
        --model deepseek-v4-flash --model-id "$mid" \
        --api-url "$API" --api-key EMPTY \
        --datasets mmlu_pro --dataset-args "$PRO_ARGS" --limit 15 \
        --generation-config "$GEN" --no-collect-perf --dataset-hub huggingface \
        --use-cache "$wd" \
        --work-dir "$wd" --no-timestamp >> "$wd.log" 2>&1
    echo "=== $(date '+%F %H:%M:%S') R2-RETRY32K $mid done ===" >> evalscope/timeline.log
    cp server.log "$wd/server-retry32k-phase.log" 2>/dev/null
}

retry_pro q35-default8               evalscope/runB-pro-full "$QWEN"
retry_pro q35-experts20-thr08-decay  evalscope/runA-pro-full "$QWEN" --q35-experts 20 --q35-expert-threshold 0.8

python3 evalscope/report_mmlupro.py evalscope/comparison_round2.md \
    "MMLU-Pro Round 2 Qwen3.6-35B: default8 vs experts20+thr0.8+decay (210/cfg; 8192 + retry 30K sui troncati)" \
    q35-default8 evalscope/runB-pro-full \
    q35-experts20-thr08-decay evalscope/runA-pro-full

stop_server
start_server -m "$QWEN" --q35-experts 20 --q35-expert-threshold 0.8
echo "=== $(date '+%F %H:%M:%S') R2-RETRY32K ALL DONE, server restored ===" >> evalscope/timeline.log
