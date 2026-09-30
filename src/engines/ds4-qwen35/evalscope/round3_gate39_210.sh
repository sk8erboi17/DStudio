#!/bin/bash
# Round 3: 210 domande MMLU-Pro (thinking) col candidato gate [27-39].
# N=20, thr0.8, decay on, kernel /tmp/qwen35_lay_last.metal via env override.
# cap 30K, ctx server 65K. Al termine: report + restore server ai flag utente
# con kernel originale.
cd /Users/agrilv/AI/antirez/ds4 || exit 1

PYE=/Users/agrilv/venv312/bin/evalscope
QWEN=/Users/agrilv/AI/models/Qwen3.6-35B-A3B-UD-6b_XL/Qwen3.6-35B-A3B-UD-Q6_K_XL.gguf
API=http://127.0.0.1:8000/v1/chat/completions
MID=q35-exp20-thr08-gate27-39
WD=./evalscope/runG-gate39-pro
PRO_ARGS='{"mmlu_pro": {"few_shot_num": 0}}'
GEN='{"max_tokens": 30000, "temperature": 0, "timeout": 7200}'

wait_server() {
    for i in $(seq 1 240); do
        curl -s -o /dev/null -w "%{http_code}" --max-time 2 \
            http://127.0.0.1:8000/v1/models 2>/dev/null | grep -q 200 && return 0
        sleep 5
    done
    return 1
}

pkill -f "ds4-server -m" 2>/dev/null; sleep 3
DS4_METAL_QWEN35_SOURCE=/tmp/qwen35_lay_last.metal \
    nohup ./ds4-server -m "$QWEN" --q35-experts 20 --q35-expert-threshold 0.8 \
    --ctx 65536 > server.log 2>&1 &
wait_server || { echo "FATAL: server gate39 non partito" >> evalscope/timeline.log; exit 1; }

echo "=== $(date '+%F %H:%M:%S') R3-RUN $mid start (N20 thr0.8 gate27-39, cap30K, ctx65K) ===" >> evalscope/timeline.log
"$PYE" eval --eval-type openai_api \
    --model deepseek-v4-flash --model-id "$MID" \
    --api-url "$API" --api-key EMPTY \
    --datasets mmlu_pro --dataset-args "$PRO_ARGS" --limit 15 \
    --generation-config "$GEN" --no-collect-perf --dataset-hub huggingface \
    --work-dir "$WD" --no-timestamp >> ./evalscope/runG-gate39-pro.log 2>&1
RC=$?
echo "=== $(date '+%F %H:%M:%S') R3-RUN $mid done (rc=$RC) ===" >> evalscope/timeline.log
cp server.log "$WD/server-gate39-phase.log" 2>/dev/null

python3 evalscope/report_mmlupro.py evalscope/comparison_gate39.md \
    "MMLU-Pro round 3: gate[27-39] N20 thr0.8 vs default8 vs full-exp20 (210/cfg, thinking, cap 30K)" \
    "$MID" "$WD" \
    q35-default8 evalscope/runB-pro-full \
    q35-experts20-thr08-decay evalscope/runA-pro-full

# matched paired vs default8 sulle domande completate da entrambi
python3 - >> evalscope/comparison_gate39.md <<'PYEOF'
import ast, glob, json, os, re, sys
os.environ["HF_HUB_OFFLINE"] = "1"
from datasets import load_dataset
gold = {r["question_id"]: r["answer"] for r in load_dataset("TIGER-Lab/MMLU-Pro", split="test")}
def load(wd, mid):
    rows = {}
    for f in glob.glob(f"{wd}/predictions/{mid}/*.jsonl"):
        for line in open(f, errors="replace"):
            try: r = json.loads(line)
            except: continue
            md = r.get("metadata")
            if isinstance(md, str):
                try: md = ast.literal_eval(md)
                except: continue
            qid = int(md["question_id"])
            raw = str(r.get("model_output",""))
            L = re.findall(r"ANSWER:\s*\(?([A-J])\b", raw, re.I)
            pred = L[-1].upper() if L else None
            sr = re.search(r"'stop_reason': '(\w+)'", raw)
            trunc = bool(sr and sr.group(1) in ("max_tokens","length"))
            rows[qid] = (pred, trunc)
    return rows
A = load("evalscope/runG-gate39-pro", "q35-exp20-thr08-gate27-39")
B = load("evalscope/runB-pro-full", "q35-default8")
common = {k for k in (A.keys() & B.keys()) if not A[k][1] and not B[k][1]}
if common:
    ha = sum(A[k][0] == gold.get(k) for k in common)
    hb = sum(B[k][0] == gold.get(k) for k in common)
    wa = sum(A[k][0] == gold.get(k) and B[k][0] != gold.get(k) for k in common)
    wb = sum(B[k][0] == gold.get(k) and A[k][0] != gold.get(k) for k in common)
    print("")
    print("## Paired gate39 vs default8 (domande completate da entrambi)")
    print("")
    print("comuni non troncati: %d | gate39 %d (%.1f%%) | default8 %d (%.1f%%) | vince gate39 %d, vince default8 %d (netto %+d)" % (
        len(common), ha, 100*ha/len(common), hb, 100*hb/len(common), wa, wb, wa-wb))
PYEOF

pkill -f "ds4-server -m" 2>/dev/null; sleep 3
nohup ./ds4-server -m "$QWEN" --q35-experts 20 --q35-expert-threshold 0.8 > server.log 2>&1 &
wait_server && echo "=== $(date '+%F %H:%M:%S') R3 ALL DONE, server restored (exp20 thr0.8, kernel originale) ===" >> evalscope/timeline.log
