#!/bin/bash
# Attende la fine del retry32k e genera la matrice 2x2 Qwen
# (routing default8/experts20 x reasoning on/off).
cd /Users/agrilv/AI/antirez/ds4 || exit 1
while ! grep -q "R2-RETRY32K ALL DONE" evalscope/timeline.log; do
    sleep 300
done
sleep 60  # lascia chiudere il report del retry32k
python3 evalscope/report_mmlupro.py evalscope/comparison_qwen_2x2.md \
    "MMLU-Pro Qwen3.6-35B matrice 2x2: routing (default8 vs experts20+thr0.8) x reasoning (on/off), 210/cfg" \
    q35-default8 evalscope/runB-pro-full \
    q35-experts20-thr08-decay evalscope/runA-pro-full \
    q35-default8-nothink evalscope/runB-pro-nothink \
    q35-experts20-thr08-nothink evalscope/runA-pro-nothink
echo "=== $(date '+%F %H:%M:%S') R2 MATRIX 2x2 DONE ===" >> evalscope/timeline.log
