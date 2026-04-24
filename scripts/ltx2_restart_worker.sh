#!/usr/bin/env bash
# Restart only the worker on :5007.
set -uo pipefail
PID=$(ss -ltnp 2>/dev/null | awk '/:5007 /{ for(i=1;i<=NF;i++) if($i ~ /pid=/){gsub(/[^0-9]/,"",$i); print $i; exit}}')
if [ -n "$PID" ]; then
  echo "killing worker pid=$PID"
  kill "$PID" || true
  sleep 2
fi
fuser -k 5007/tcp 2>/dev/null || true
sleep 1
cd ~/openzigs-sidecars/worker
source venv/bin/activate
# Source HF token from .env if present.
if [ -f /mnt/c/Users/mgbre/Development/openzigs/.env ]; then
  set -a; . /mnt/c/Users/mgbre/Development/openzigs/.env; set +a
fi
# Note: native sync audio (via the ltx2 sidecar on :5013) does NOT require
# LTX_ALLOW_AUDIO. We leave it unset here to verify the post-fix behaviour
# matches the user's normal launcher (which also doesn't set it).
nohup python server_cuda.py --port 5007 > /tmp/worker-sidecar.log 2>&1 &
echo "PID=$!"
sleep 6
echo "--- log tail ---"
tail -25 /tmp/worker-sidecar.log
echo "--- port ---"
ss -ltn | awk '{print $4}' | grep -E ':5007$' || echo NOT_LISTENING
