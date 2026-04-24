#!/usr/bin/env bash
set -euo pipefail
pkill -f "ltx2/server_cuda.py" 2>/dev/null || true
sleep 1
cd ~/openzigs-sidecars/ltx2
nohup ./venv/bin/python server_cuda.py --port 5013 > /tmp/ltx2-sidecar.log 2>&1 &
echo "ltx2 PID=$!"
for i in 1 2 3 4 5 6 7 8 9 10; do
  sleep 2
  if curl -fsS http://127.0.0.1:5013/health >/dev/null 2>&1; then
    echo "ready after ${i} polls"
    curl -fsS http://127.0.0.1:5013/health
    exit 0
  fi
done
echo "--- log tail ---"
tail -60 /tmp/ltx2-sidecar.log
exit 1
