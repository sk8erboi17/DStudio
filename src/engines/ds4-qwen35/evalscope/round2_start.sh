#!/bin/bash
# Riprende il round-2 da dove era arrivato (evalscope salta i campioni in cache).
cd /Users/agrilv/AI/antirez/ds4 || exit 1
if pgrep -f "bench_round2" > /dev/null; then
    echo "già in corsa:"; tail -1 evalscope/timeline.log; exit 0
fi
nohup bash evalscope/bench_round2_v2.sh >> evalscope/round2_pipeline.log 2>&1 &
disown
sleep 3
echo "ripartito:"; tail -1 evalscope/timeline.log
echo "preview: ./evalscope/live_stats.py"
