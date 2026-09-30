#!/bin/bash
# Round 4 INTERLEAVED: def8 e gate39 alternati PER MATERIA (non a blocchi).
# Per ogni materia: eval def8 (51 q, 15 in cache) -> switch server a gate39 -> eval gate39.
# Cosi' il live status paired si riempie materia per materia.
# Budget reasoning 8K, decoding seriale (batching Metal rotto su q35: NON usare --batched-session).
cd /Users/agrilv/AI/antirez/ds4 || exit 1
PY=/Users/agrilv/venv312/bin/python
ES=/Users/agrilv/venv312/bin/evalscope
LOG=evalscope/round4.log
MODEL=/Users/agrilv/AI/models/Qwen3.6-35B-A3B-UD-6b_XL/Qwen3.6-35B-A3B-UD-Q6_K_XL.gguf
SUBJECTS="biology business chemistry computer-science economics engineering health history law math other philosophy physics psychology"

start_server () {
  # $1 = mode: def8 | gate39
  pkill -f ds4-server 2>/dev/null; sleep 3
  if [ "$1" = gate39 ]; then
    echo "=== starting gate39 server $(date '+%H:%M:%S') ===" >> $LOG
    DS4_METAL_QWEN35_SOURCE=metal/qwen35_lay_last.metal \
    ./ds4-server -m $MODEL --q35-experts 20 --q35-expert-threshold 0.8 --ctx 65536 --port 8000 \
      > /tmp/round4_server_gate39.log 2>&1 &
    echo $! > /tmp/round4_server_gate39.pid
  else
    echo "=== starting def8 server $(date '+%H:%M:%S') ===" >> $LOG
    ./ds4-server -m $MODEL --ctx 65536 --port 8000 \
      > /tmp/round4_server_def8.log 2>&1 &
    echo $! > /tmp/round4_server_def8.pid
  fi
  for i in $(seq 1 60); do
    curl -s -m 2 http://127.0.0.1:8000/v1/models | grep -q deepseek && return 0
    sleep 5
  done
  echo "SERVER $1 FAILED TO START" >> $LOG
  return 1
}

run_eval () {
  # $1 = mode, $2 = subject (subset name)
  local wd mid
  if [ "$1" = gate39 ]; then
    wd=evalscope/runE4-gate39; mid=q35-exp20-thr08-gate27-39-r4
  else
    wd=evalscope/runD4-def8; mid=q35-default8-r4
  fi
  $ES eval --eval-type openai_api --model deepseek-v4-flash --model-id $mid \
    --api-url http://127.0.0.1:8000/v1/chat/completions --api-key EMPTY \
    --datasets mmlu_pro --dataset-args "{\"mmlu_pro\": {\"few_shot_num\": 0, \"subset_list\": [\"$2\"]}}" \
    --limit 51 \
    --generation-config '{"max_tokens": 8192, "temperature": 0, "timeout": 3600}' \
    --no-collect-perf --dataset-hub huggingface \
    --work-dir $wd --no-timestamp \
    --use-cache $wd --eval-batch-size 1 \
    >> $wd/eval_log.log 2>&1
  echo "=== $1 [$2] DONE rc=$? $(date '+%H:%M:%S') ===" >> $LOG
}

echo "=== ROUND4 INTERLEAVED CHAIN START $(date '+%F %H:%M:%S') ===" >> $LOG
for S in $SUBJECTS; do
  SUB=${S//-/ }   # computer-science -> "computer science"
  echo "--- SUBJECT $SUB ---" >> $LOG
  start_server def8   || exit 1
  run_eval   def8   "$SUB"
  start_server gate39 || exit 1
  run_eval   gate39 "$SUB"
done

# report finale
$PY evalscope/report_mmlupro.py evalscope/comparison_round4.md \
  "MMLU-Pro 714 questions (51/subject; 210 cached + 504 new at 8K budget), interleaved per-subject: q35-default8 vs gate39" \
  q35-default8-r4 evalscope/runD4-def8 \
  q35-exp20-thr08-gate27-39-r4 evalscope/runE4-gate39 >> $LOG 2>&1
echo "=== ROUND4 INTERLEAVED CHAIN END $(date '+%F %H:%M:%S') ===" >> $LOG
