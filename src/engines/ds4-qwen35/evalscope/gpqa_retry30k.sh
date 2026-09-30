#!/bin/bash
# GPQA retry: bump reasoning budget 8K -> 30K for the two r4 configs.
# 1) strip max_tokens/length rows (backup in predictions_8k/) for FINISHED domains
# 2) re-run those domains at 30K
# 3) continue chemistry (def8 48/93 done, gate39 not started) directly at 30K
# Order keeps domains interleaved: def8 chemistry finish -> gate39 chemistry ->
# then retries domain by domain, both configs, alternating.
cd /Users/agrilv/AI/antirez/ds4 || exit 1

PYE=/Users/agrilv/venv312/bin/python
QWEN=/Users/agrilv/AI/models/Qwen3.6-35B-A3B-UD-6b_XL/Qwen3.6-35B-A3B-UD-Q6_K_XL.gguf
LOG=evalscope/gpqa_retry30k.log
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

strip_truncated() { # $1=wd  $2=mid  $3=domain — remove budget-dead rows, backup once
    python3 - "$1" "$2" "$3" <<'PYEOF'
import json, os, shutil, sys
wd, mid, dom = sys.argv[1], sys.argv[2], sys.argv[3]
base = os.path.join("evalscope", wd, "predictions", mid, f"gpqa_mc_{dom}.jsonl")
backup = os.path.join("evalscope", wd, "predictions_8k", mid)
if not os.path.isfile(base):
    print(f"{mid}/{dom}: no file, skip"); sys.exit(0)
os.makedirs(backup, exist_ok=True)
bk = os.path.join(backup, f"gpqa_mc_{dom}.jsonl")
if not os.path.exists(bk):
    shutil.copy2(base, bk)
out, removed, kept = [], 0, 0
for line in open(base, errors="replace"):
    s = line.strip()
    if not s:
        continue
    try:
        raw = str(json.loads(s).get("model_output", ""))
    except Exception:
        out.append(line); kept += 1; continue
    import re
    sr = re.search(r"'stop_reason': '(\w+)'", raw)
    if sr and sr.group(1) in ("max_tokens", "length"):
        removed += 1
    else:
        out.append(line); kept += 1
open(base, "w").write("".join(out) + ("\n" if out and not out[-1].endswith("\n") else ""))
print(f"{mid}/{dom}: retry {removed} at 30K (8K copies in predictions_8k), kept {kept}")
PYEOF
}

run_dom() { # $1=model-id  $2=workdir  $3=domain  $4...=extra server flags
    local mid="$1" wd="$2" dom="$3"; shift 3
    stop_server
    start_server -m "$QWEN" --ctx 65536 --port 8000 "$@"
    echo "=== $(date '+%F %H:%M:%S') GPQA30K $mid $dom start ===" >> $LOG
    "$PYE" evalscope/gpqa_run_one.py "$mid" "evalscope/$wd" "$dom" >> "evalscope/$wd.log" 2>&1
    echo "=== $(date '+%F %H:%M:%S') GPQA30K $mid $dom done rc=$? ===" >> $LOG
}

GATE_FLAGS=(--q35-experts 20 --q35-expert-threshold 0.8)

echo "=== GPQA 30K PLAN START $(date '+%F %H:%M:%S') ===" >> $LOG

# --- chemistry first (def8 48 done at 8K stay; rest of chemistry at 30K) ---
run_dom q35-default8-gpqa gpqa-def8 chemistry
run_dom q35-exp20-thr08-gate27-39-gpqa gpqa-gate39 chemistry "${GATE_FLAGS[@]}"

# --- retries at 30K for domains finished at 8K ---
run_dom q35-default8-gpqa gpqa-def8 biology
run_dom q35-exp20-thr08-gate27-39-gpqa gpqa-gate39 biology "${GATE_FLAGS[@]}"
run_dom q35-default8-gpqa gpqa-def8 physics
run_dom q35-exp20-thr08-gate27-39-gpqa gpqa-gate39 physics "${GATE_FLAGS[@]}"

"$PYE" evalscope/export_gpqa_json.py >> $LOG 2>&1
echo "=== GPQA 30K PLAN ALL DONE $(date '+%F %H:%M:%S') ===" >> $LOG
