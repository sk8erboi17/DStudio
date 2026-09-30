#!/bin/bash
# Interrompe il round-2. L'ordine conta: PRIMA lo script orchestratore,
# altrimenti alla morte di evalscope partirebbe la fase successiva.
cd /Users/agrilv/AI/antirez/ds4 || exit 1
pkill -f bench_round2; sleep 1
pkill -f "venv312/bin/evalscope"
pkill -f "ds4-server -m"
sleep 2
left=$(ps aux | grep -cE "[b]ench_round2|[e]valscope|[d]s4-server")
echo "processi rimasti: $left (0 = tutto fermo)"
echo "--- campioni in cache:"
for d in ornithB-pro-full ornithA-pro-full runB-pro-full runA-pro-full; do
    n=$(wc -l evalscope/$d/predictions/*/*.jsonl 2>/dev/null | tail -1 | awk '{print $1}')
    echo "  $d: ${n:-0}/210"
done
tail -2 evalscope/timeline.log
echo "Per riprendere:  ./evalscope/round2_start.sh"
