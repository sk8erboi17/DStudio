#!/bin/bash
# Catena notturna (2026-08-29): al termine del round-3 gate39 su ds4:
#   1. riepilogo finale + paired analysis (comparison_gate39.md)
#   2. STOP ds4-server (libera RAM per omlx)
#   3. eval MMLU-Pro 210 su Qwen3.8-27B-nvfp4 @ localhost:8090 (omlx, 4 richieste parallele)
#   4. confronto finale tre-vie vs default8 e gate39
#   5. ripristino ds4-server ai flag utente (exp20 thr0.8, kernel originale)
# Nessuna interattivita': pensato per girare da solo durante la notte.
cd /Users/agrilv/AI/antirez/ds4 || exit 1
PYE=/Users/agrilv/venv312/bin/evalscope
QWEN35=/Users/agrilv/AI/models/Qwen3.6-35B-A3B-UD-6b_XL/Qwen3.6-35B-A3B-UD-Q6_K_XL.gguf
MID27=qwen38-27b-nvfp4
WD27=./evalscope/runH-qwen27b-pro
PRO_ARGS='{"mmlu_pro": {"few_shot_num": 0}}'
GEN='{"max_tokens": 30000, "temperature": 0, "timeout": 7200}'

# attende la fine dell'evalscope round-3 (PID passato come $1)
while kill -0 "$1" 2>/dev/null; do sleep 30; done
sleep 10

echo "=== $(date '+%F %H:%M:%S') NIGHT: round3 evalscope ended, starting night chain ===" >> evalscope/timeline.log

# --- 1. attende il marker NOTTURNO (univoco: il vecchio delle 11:52 non matcha
#     perche' cerchiamo la data di oggi dopo l'avvio della catena)
START_TS=$(date '+%F %H:%M')
echo "=== $START_TS NIGHT: chain armed, waiting for round3 finish watcher ===" >> evalscope/timeline.log
for i in $(seq 1 4320); do   # max 12h
    awk -v ts="$START_TS" '$0 >= ts' evalscope/timeline.log | \
        grep -q "NIGHT-R3-RESTORED" && break
    sleep 10
done

# --- 2. stop ds4-server (nota: r3_finish_watcher.sh lo ha appena ripristinato
#     ai flag utente; lo fermiamo subito per liberare RAM per omlx/27B)
pkill -f "ds4-server -m" 2>/dev/null; sleep 5
pkill -9 -f "ds4-server -m" 2>/dev/null; sleep 3
echo "=== $(date '+%F %H:%M:%S') NIGHT: ds4-server stopped ===" >> evalscope/timeline.log

# --- 3. eval qwen 3.8 27b su omlx :8090 (attende che il server risponda)
for i in $(seq 1 60); do
    curl -s -o /dev/null -w "%{http_code}" --max-time 2 http://localhost:8090/v1/models 2>/dev/null | grep -q 200 && break
    sleep 5
done
echo "=== $(date '+%F %H:%M:%S') NIGHT: starting qwen3.8-27b eval (210, 4-way parallel) ===" >> evalscope/timeline.log
"$PYE" eval --eval-type openai_api \
    --model Qwen3.8-27B-nvfp4 --model-id "$MID27" \
    --api-url http://localhost:8090/v1/chat/completions --api-key EMPTY \
    --datasets mmlu_pro --dataset-args "$PRO_ARGS" --limit 15 \
    --generation-config "$GEN" --no-collect-perf --dataset-hub huggingface \
    --work-dir "$WD27" --no-timestamp --use-cache "$WD27" \
    --eval-batch-size 4 >> ./evalscope/runH-qwen27b-pro.log 2>&1
RC=$?
echo "=== $(date '+%F %H:%M:%S') NIGHT: qwen3.8-27b eval done (rc=$RC) ===" >> evalscope/timeline.log

# --- 4. confronto finale tre-vie
python3 evalscope/report_mmlupro.py evalscope/comparison_qwen27b.md \
    "MMLU-Pro: qwen3.8-27b-nvfp4 (omlx, 4-way) vs default8 vs gate39 vs full-exp20 (210/cfg, thinking, cap 30K)" \
    "$MID27" "$WD27" \
    q35-default8 evalscope/runB-pro-full \
    q35-exp20-thr08-gate27-39 evalscope/runG-gate39-pro \
    q35-experts20-thr08-decay evalscope/runA-pro-full >> /tmp/night_report.log 2>&1

python3 - >> evalscope/comparison_qwen27b.md <<'PYEOF'
import ast, glob, json, os, re
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
            try: qid = int(md["question_id"])
            except: continue
            raw = str(r.get("model_output",""))
            L = re.findall(r"ANSWER:\s*\(?([A-J])\b", raw, re.I)
            pred = L[-1].upper() if L else None
            sr = re.search(r"'stop_reason': '(\w+)'", raw)
            trunc = bool(sr and sr.group(1) in ("max_tokens","length"))
            rows[qid] = (pred, trunc)
    return rows
A = load("evalscope/runH-qwen27b-pro", "qwen38-27b-nvfp4")
for name, wd, mid in [("default8","evalscope/runB-pro-full","q35-default8"),
                      ("gate39","evalscope/runG-gate39-pro","q35-exp20-thr08-gate27-39")]:
    B = load(wd, mid)
    common = {k for k in (A.keys() & B.keys()) if not A[k][1] and not B[k][1]}
    if not common: continue
    ha = sum(A[k][0]==gold.get(k) for k in common)
    hb = sum(B[k][0]==gold.get(k) for k in common)
    wa = sum(A[k][0]==gold.get(k) and B[k][0]!=gold.get(k) for k in common)
    wb = sum(B[k][0]==gold.get(k) and A[k][0]!=gold.get(k) for k in common)
    print("")
    print("## Paired qwen27b vs %s (completati da entrambi)" % name)
    print("")
    print("comuni: %d | q27b %d (%.1f%%) | %s %d (%.1f%%) | vince q27b %d, vince %s %d (netto %+d)" % (
        len(common), ha, 100*ha/len(common), name, hb, 100*hb/len(common), wa, name, wb, wa-wb))
PYEOF

# --- 5. ripristino ds4-server ai flag utente
nohup ./ds4-server -m "$QWEN35" --q35-experts 20 --q35-expert-threshold 0.8 > server.log 2>&1 &
for i in $(seq 1 240); do
    curl -s -o /dev/null -w "%{http_code}" --max-time 2 http://127.0.0.1:8000/v1/models 2>/dev/null | grep -q 200 && break
    sleep 5
done
echo "=== $(date '+%F %H:%M:%S') NIGHT ALL DONE: q27b eval + confronti pronti, ds4 restored ===" >> evalscope/timeline.log
