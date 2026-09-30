#!/bin/bash
# Follower: waits for the running gpqa_retry30k.sh to finish, then
# 1) retries the 26 chemistry def8 rows truncated at 8K (missed by the 30K plan) at 30K
# 2) classifies ALL still-truncated rows as loop vs clean (repeated-sentence score)
# 3) re-runs every non-loop truncated row at 60K budget
# 4) exports the final gpqa_results.json
cd /Users/agrilv/AI/antirez/ds4 || exit 1

PYE=/Users/agrilv/venv312/bin/python
QWEN=/Users/agrilv/AI/models/Qwen3.6-35B-A3B-UD-6b_XL/Qwen3.6-35B-A3B-UD-Q6_K_XL.gguf
LOG=evalscope/gpqa_60k.log
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

# strip rows whose stop_reason is in $3 (comma list); backup once into predictions_<tag>/
strip_rows() { # $1=wd $2=mid $3=reason1,reason2 $4=tag $5=domain(optional, else all)
    python3 - "$@" <<'PYEOF'
import json, os, re, shutil, sys
wd, mid, reasons, tag, dom = sys.argv[1], sys.argv[2], sys.argv[3].split(","), sys.argv[4], sys.argv[5] if len(sys.argv) > 5 else None
import glob
base_dir = os.path.join("evalscope", wd, "predictions", mid)
backup = os.path.join("evalscope", wd, f"predictions_{tag}", mid)
os.makedirs(backup, exist_ok=True)
total_removed = 0
for f in glob.glob(os.path.join(base_dir, "*.jsonl")):
    d = os.path.basename(f)[len("gpqa_mc_"):-len(".jsonl")]
    if dom and d != dom:
        continue
    bk = os.path.join(backup, os.path.basename(f))
    if not os.path.exists(bk):
        shutil.copy2(f, bk)
    out, removed = [], 0
    for line in open(f, errors="replace"):
        s = line.strip()
        if not s:
            continue
        try:
            raw = str(json.loads(s).get("model_output", ""))
        except Exception:
            out.append(line); continue
        sr = re.search(r"'stop_reason': '(\w+)'", raw)
        if sr and sr.group(1) in reasons:
            removed += 1
        else:
            out.append(line)
    open(f, "w").write("".join(out))
    total_removed += removed
print(f"{mid} [{dom or 'all'}]: stripped {total_removed} rows (reasons={reasons}, backup=predictions_{tag})")
PYEOF
}

run_dom() { # $1=model-id $2=workdir $3=budget-tokens $4=domain $5...=server flags
    local mid="$1" wd="$2" budget="$3" dom="$4"; shift 4
    stop_server
    start_server -m "$QWEN" --ctx 65536 --port 8000 "$@"
    echo "=== $(date '+%F %H:%M:%S') $mid $dom budget=$budget start ===" >> $LOG
    BUDGET=$budget "$PYE" - "$mid" "evalscope/$wd" "$dom" <<'PYEOF' >> "evalscope/$wd.log" 2>&1
import os, sys
sys.path.insert(0, "evalscope")
import gpqa_adapter_local  # noqa: F401
from evalscope.run import run_task
mid, wd, dom = sys.argv[1], sys.argv[2], sys.argv[3]
budget = int(os.environ["BUDGET"])
run_task(dict(
    model='deepseek-v4-flash', model_id=mid,
    api_url='http://127.0.0.1:8000/v1/chat/completions', api_key='EMPTY',
    eval_type='openai_api', datasets=['gpqa_mc'],
    dataset_args={'gpqa_mc': {'few_shot_num': 0, 'subset_list': [dom]}},
    generation_config={'max_tokens': budget, 'temperature': 0, 'timeout': 21600},
    collect_perf=False, dataset_hub='huggingface', eval_batch_size=1,
    use_cache=wd, work_dir=wd, no_timestamp=True,
))
PYEOF
    echo "=== $(date '+%F %H:%M:%S') $mid $dom budget=$budget done rc=$? ===" >> $LOG
}

GATE=(--q35-experts 20 --q35-expert-threshold 0.8)

echo "=== 60K FOLLOWER START $(date '+%F %H:%M:%S') — waiting for retry30k to finish ===" >> $LOG
while pgrep -f gpqa_retry30k.sh > /dev/null; do sleep 60; done
echo "=== retry30k finished $(date '+%F %H:%M:%S') ===" >> $LOG

# --- phase A: chemistry def8 rows truncated at 8K, retry at 30K ---
strip_rows gpqa-def8 q35-default8-gpqa max_tokens,length chem8k chemistry
run_dom q35-default8-gpqa gpqa-def8 30720 chemistry

# --- phase B: classify remaining truncated rows as loop vs clean ---
python3 - <<'PYEOF' > evalscope/gpqa_loop_report.txt 2>&1
import json, re, glob
from collections import Counter
def loop_score(raw):
    gen = raw.split("', 'stop_reason'")[0]
    tail = gen[-6000:]
    sents = [s.strip() for s in re.split(r'(?<=[.!?])\s+', tail) if len(s.strip()) > 25]
    c = Counter(sents)
    return sum(cnt - 1 for cnt in c.values())
loops, clean = [], []
for f in sorted(glob.glob("evalscope/gpqa-*/predictions/*/gpqa_mc_*.jsonl")):
    for line in open(f, errors="replace"):
        if not line.strip():
            continue
        raw = str(json.loads(line).get("model_output", ""))
        sr = re.search(r"'stop_reason': '(\w+)'", raw)
        if not (sr and sr.group(1) in ("max_tokens", "length")):
            continue
        m = re.search(r"'output_tokens': (\d+)", raw)
        sc = loop_score(raw)
        rec = (f, sc, int(m.group(1)) if m else 0)
        (loops if sc >= 4 else clean).append(rec)
print("LOOP-LIKE (excluded from 60K cycle):", len(loops))
for f, sc, tok in loops:
    print(f"  score={sc:4d} tok={tok}  {f}")
print("CLEAN (will retry at 60K):", len(clean))
for f, sc, tok in clean:
    print(f"  score={sc:4d} tok={tok}  {f}")
PYEOF
cat evalscope/gpqa_loop_report.txt >> $LOG

# --- phase C: strip clean truncated rows everywhere, re-run at 60K ---
strip_rows gpqa-def8 q35-default8-gpqa max_tokens,length trunc8k30k
strip_rows gpqa-gate39 q35-exp20-thr08-gate27-39-gpqa max_tokens,length trunc8k30k
run_dom q35-default8-gpqa gpqa-def8 61440 biology
run_dom q35-exp20-thr08-gate27-39-gpqa gpqa-gate39 61440 biology "${GATE[@]}"
run_dom q35-default8-gpqa gpqa-def8 61440 physics
run_dom q35-exp20-thr08-gate27-39-gpqa gpqa-gate39 61440 physics "${GATE[@]}"
run_dom q35-default8-gpqa gpqa-def8 61440 chemistry
run_dom q35-exp20-thr08-gate27-39-gpqa gpqa-gate39 61440 chemistry "${GATE[@]}"

"$PYE" evalscope/export_gpqa_json.py >> $LOG 2>&1
echo "=== 60K FOLLOWER ALL DONE $(date '+%F %H:%M:%S') ===" >> $LOG
