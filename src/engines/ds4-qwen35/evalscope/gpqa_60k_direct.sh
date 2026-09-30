#!/bin/bash
# Direct-to-60K plan: skip the remaining 30K phases entirely.
# All 94 currently-truncated rows: 4 are true loops (excluded), 90 clean
# (60K candidates). Steps:
#   1) classify loops -> evalscope/gpqa_loop_report.txt
#   2) strip clean truncated rows (backup predictions_pre60k/)
#   3) re-run affected domains at 60K, alternating def8/gate39
#   4) final export gpqa_results.json
# Chemistry gate39 rows 45..93 were never generated: they run at 60K too
# (cache covers 1..44).
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

strip_rows() { # $1=wd $2=mid  — remove max_tokens/length rows, backup once
    python3 - "$1" "$2" <<'PYEOF'
import json, os, re, shutil, sys, glob
wd, mid = sys.argv[1], sys.argv[2]
base_dir = os.path.join("evalscope", wd, "predictions", mid)
backup = os.path.join("evalscope", wd, "predictions_pre60k", mid)
os.makedirs(backup, exist_ok=True)
total = 0
for f in glob.glob(os.path.join(base_dir, "*.jsonl")):
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
        if sr and sr.group(1) in ("max_tokens", "length"):
            removed += 1
        else:
            out.append(line)
    open(f, "w").write("".join(out))
    total += removed
print(f"{mid}: stripped {total} truncated rows (backup predictions_pre60k)")
PYEOF
}

run_dom() { # $1=model-id $2=workdir $3=domain $4...=server flags
    local mid="$1" wd="$2" dom="$3"; shift 3
    stop_server
    start_server -m "$QWEN" --ctx 65536 --port 8000 "$@"
    echo "=== $(date '+%F %H:%M:%S') 60K $mid $dom start ===" >> $LOG
    "$PYE" - "$mid" "evalscope/$wd" "$dom" >> "evalscope/$wd.log" 2>&1 <<'PYEOF'
import sys
sys.path.insert(0, "evalscope")
import gpqa_adapter_local  # noqa: F401
from evalscope.run import run_task
mid, wd, dom = sys.argv[1], sys.argv[2], sys.argv[3]
run_task(dict(
    model='deepseek-v4-flash', model_id=mid,
    api_url='http://127.0.0.1:8000/v1/chat/completions', api_key='EMPTY',
    eval_type='openai_api', datasets=['gpqa_mc'],
    dataset_args={'gpqa_mc': {'few_shot_num': 0, 'subset_list': [dom]}},
    generation_config={'max_tokens': 61440, 'temperature': 0, 'timeout': 43200},
    collect_perf=False, dataset_hub='huggingface', eval_batch_size=1,
    use_cache=wd, work_dir=wd, no_timestamp=True,
))
PYEOF
    echo "=== $(date '+%F %H:%M:%S') 60K $mid $dom done rc=$? ===" >> $LOG
}

GATE=(--q35-experts 20 --q35-expert-threshold 0.8)

echo "=== 60K DIRECT PLAN START $(date '+%F %H:%M:%S') ===" >> $LOG

# 1) loop classification report (informational)
python3 - > evalscope/gpqa_loop_report.txt 2>&1 <<'PYEOF'
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
print("LOOP-LIKE (excluded from 60K):", len(loops))
for f, sc, tok in loops:
    print(f"  score={sc:4d} tok={tok}  {f}")
print("CLEAN (60K candidates):", len(clean))
for f, sc, tok in clean:
    print(f"  score={sc:4d} tok={tok}  {f}")
PYEOF
cat evalscope/gpqa_loop_report.txt >> $LOG

# 2) strip ALL clean truncated rows (loops go too: excluded by cache-skip? No —
# evalscope will regenerate whatever is missing. To keep loops OUT of the 60K
# cycle we re-add loop rows right after stripping, from the same file backup.)
strip_rows gpqa-def8 q35-default8-gpqa
strip_rows gpqa-gate39 q35-exp20-thr08-gate27-39-gpqa

python3 - <<'PYEOF' >> $LOG 2>&1
# restore loop rows so the 60K runs skip them (they stay loop-truncated forever)
import json, re, glob, os
from collections import Counter
def loop_score(raw):
    gen = raw.split("', 'stop_reason'")[0]
    tail = gen[-6000:]
    sents = [s.strip() for s in re.split(r'(?<=[.!?])\s+', tail) if len(s.strip()) > 25]
    c = Counter(sents)
    return sum(cnt - 1 for cnt in c.values())
restored = 0
for f in sorted(glob.glob("evalscope/gpqa-*/predictions/*/gpqa_mc_*.jsonl")):
    bk = os.path.join("evalscope", f.split("/")[1], "predictions_pre60k", f.split("/")[3], os.path.basename(f))
    if not os.path.exists(bk):
        continue
    cur_raws = set()
    for line in open(f, errors="replace"):
        if line.strip():
            try:
                cur_raws.add(str(json.loads(line).get("model_output", ""))[:200])
            except Exception:
                pass
    add = []
    for line in open(bk, errors="replace"):
        if not line.strip():
            continue
        try:
            raw = str(json.loads(line).get("model_output", ""))
        except Exception:
            continue
        sr = re.search(r"'stop_reason': '(\w+)'", raw)
        if sr and sr.group(1) in ("max_tokens", "length") and loop_score(raw) >= 4 \
           and raw[:200] not in cur_raws:
            add.append(line)
    if add:
        with open(f, "a") as fh:
            fh.writelines(add)
        restored += len(add)
print(f"restored {restored} loop rows (kept out of 60K cycle)")
PYEOF

# 3) 60K runs per domain, alternating
run_dom q35-default8-gpqa gpqa-def8 biology
run_dom q35-exp20-thr08-gate27-39-gpqa gpqa-gate39 biology "${GATE[@]}"
run_dom q35-default8-gpqa gpqa-def8 physics
run_dom q35-exp20-thr08-gate27-39-gpqa gpqa-gate39 physics "${GATE[@]}"
run_dom q35-default8-gpqa gpqa-def8 chemistry
run_dom q35-exp20-thr08-gate27-39-gpqa gpqa-gate39 chemistry "${GATE[@]}"

# 4) final export
"$PYE" evalscope/export_gpqa_json.py >> $LOG 2>&1
echo "=== 60K DIRECT PLAN ALL DONE $(date '+%F %H:%M:%S') ===" >> $LOG
