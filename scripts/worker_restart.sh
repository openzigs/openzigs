#!/usr/bin/env bash
set -euo pipefail
# Restart the LTX video worker on port 5007.
fuser -k 5007/tcp 2>/dev/null || true
sleep 2
cd ~/openzigs-sidecars/worker
source venv/bin/activate
nohup python server_cuda.py --port 5007 --host 0.0.0.0 > /tmp/worker.log 2>&1 &
echo "PID=$!"
sleep 6
echo "--- port ---"
ss -ltn | awk '{print $4}' | grep -E ':5007$' || echo NOT_LISTENING
echo "--- log tail ---"
tail -25 /tmp/worker.log
