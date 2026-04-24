#!/usr/bin/env bash
set -euo pipefail
# The ltx2 sidecar source lives in the WSL deployment dir, not the repo
# (it's gitignored — large model wrappers + venv).
cd ~/openzigs-sidecars/ltx2
source ~/openzigs-sidecars/ltx2/venv/bin/activate
export CUDA_VISIBLE_DEVICES=0
# Make sure port is free.
fuser -k 5013/tcp 2>/dev/null || true
sleep 1
nohup python server_cuda.py --port 5013 --host 127.0.0.1 > /tmp/ltx2-sidecar.log 2>&1 &
echo "PID=$!"
sleep 5
echo "--- log ---"
tail -40 /tmp/ltx2-sidecar.log
echo "--- port ---"
ss -ltn | awk '{print $4}' | grep -E ':5013$' || echo NOT_LISTENING
echo "--- /health ---"
curl -fsS http://127.0.0.1:5013/health | python3 -m json.tool || echo HEALTH_FAILED
