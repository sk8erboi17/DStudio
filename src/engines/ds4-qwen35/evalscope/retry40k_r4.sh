#!/bin/bash
# Round-4 retry: rigenera a 40K i campioni morti per budget (stop_reason=max_tokens)
# per le due run r4 (def8 e gate39). Le risposte gia' complete restano invariate
# (temp 0). Backup delle 8192pure in predictions_8192pure/.
cd /Users/agrilv/AI/antirez/ds4 || exit 1

PYE=/Users/agrilv/venv312/bin/evalscope
QWEN=/Users/agrilv/AI/models/Qwen3.6-35B-A3B-UD-6b_XL/Qwen3.6-35B-A3B-UD-Q6_K_XL.gguf
API=http://127.0.0.1:8000/v1/chat/completions
PRO_ARGS='{"mmlu_pro": {"few_shot_num": 0}}'
GEN='{"max_tokens": 40000, "temperature": 0, "timeout": 7200}'
LOG=evalscope/retry40k.log

wait_server() {
    for i in $(seq 1 120); do
        curl -s -o /dev/null -w "%{http_code}" --max-time 2 http://127.0.0.1:8000/v1/models 2>/dev/null | grep -q 200 && return 0
        sleep 5
    done
    return 1
}

stop_server() { pkill -f "ds4-server -m" 2>/dev/null; sleep 3; }

start_server() {
    nohup ./ds4-server "$@" > /tmp/retry40k_server.log 2>&1 &
    wait_server || { echo "FATAL: server did not come up ($*)" >> $LOG; exit 1; }
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

retry_r4() { # $1=model-id  $2=workdir  $3=extra server flags...
    local mid="$1" wd="$2"; shift 2
    [ -d "$wd/predictions/$mid" ] || { echo "skip $mid"; return; }
    stop_server
    start_server -m "$QWEN" "$@"
    strip_truncated "$wd" "$mid" >> $LOG
    echo "=== $(date '+%F %H:%M:%S') R4-RETRY40K $mid start ===" >> $LOG
    "$PYE" eval --eval-type openai_api \
        --model deepseek-v4-flash --model-id "$mid" \
        --api-url "$API" --api-key EMPTY \
        --datasets mmlu_pro --dataset-args "$PRO_ARGS" --limit 51 \
        --generation-config "$GEN" --no-collect-perf --dataset-hub huggingface \
        --use-cache "$wd" --eval-batch-size 1 \
        --work-dir "$wd" --no-timestamp >> "$wd.log" 2>&1
    echo "=== $(date '+%F %H:%M:%S') R4-RETRY40K $mid done rc=$? ===" >> $LOG
}

echo "=== R4 RETRY40K START $(date '+%F %H:%M:%S') ===" >> $LOG
retry_r4 q35-default8-r4 evalscope/runD4-def8
retry_r4 q35-exp20-thr08-gate27-39-r4 evalscope/runE4-gate39 --q35-experts 20 --q35-expert-threshold 0.8

# report finale riallineato
/Users/agrilv/venv312/bin/python evalscope/export_round4_json.py >> $LOG 2>&1
echo "=== R4 RETRY40K ALL DONE $(date '+%F %H:%M:%S') ===" >> $LOG
