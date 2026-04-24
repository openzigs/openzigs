#!/usr/bin/env bash
# One-shot helper: kill all CUDA sidecars then restart from synced /home/mcronin/openzigs-sidecars
set -u
for p in 5005 5006 5007 5009 5010 5011 5012; do
    pid=$(lsof -ti :"$p" 2>/dev/null || true)
    if [ -n "$pid" ]; then
        echo "killing pid=$pid on port $p"
        kill "$pid" 2>/dev/null || true
    fi
done
sleep 3
echo "--- launching ---"
bash /home/mcronin/openzigs-sidecars/start-cuda-sidecars.sh >> "$HOME/.openzigs/logs/sidecar-start.log" 2>&1 &
disown
sleep 6
echo "--- ports ---"
for p in 5005 5006 5007 5009 5010 5011 5012; do
    pid=$(lsof -ti :"$p" 2>/dev/null || true)
    echo "port $p pid=${pid:-NONE}"
done
