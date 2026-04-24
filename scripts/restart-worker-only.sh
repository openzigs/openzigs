#!/usr/bin/env bash
# Restart only the LTX worker sidecar with a chosen model and pooling mode.
# Usage: bash scripts/restart-worker-only.sh [model_key] [pooling_mode]
set -euo pipefail
MODEL="${1:-ltxv-2b-096-distilled}"
POOL="${2:-off}"
DIR="$HOME/openzigs-sidecars/worker"
LOG_DIR="$HOME/openzigs-sidecars/logs"
CFG="${OPENZIGS_CONFIG:-/mnt/c/Users/mgbre/.openzigs/config.json}"
mkdir -p "$LOG_DIR"
SECRET=$(python3 -c "import json; print(json.load(open('$CFG'))['auth']['workerSecret'])")

# Kill anything on 5007
PIDS=$(lsof -i:5007 -t 2>/dev/null || true)
if [ -n "$PIDS" ]; then
  echo "Killing existing worker pids: $PIDS"
  kill -9 $PIDS || true
  sleep 2
fi

# CUDA_VISIBLE_DEVICES: when pooling is on, expose both; when off, just GPU 0
if [ "$POOL" = "off" ]; then
  CVD="0"
else
  CVD="0,1"
fi

cd "$DIR"
nohup bash -c "source venv/bin/activate && CUDA_VISIBLE_DEVICES=$CVD CALLBACK_SECRET=$SECRET LTX_MODEL_KEY=$MODEL LTX_POOLING_MODE=$POOL exec python server_cuda.py --port 5007" \
  > "$LOG_DIR/worker-cuda.log" 2>&1 < /dev/null &
disown
sleep 4
if ss -ltn 2>/dev/null | grep -q :5007; then
  echo "WORKER-UP model=$MODEL pool=$POOL CUDA_VISIBLE_DEVICES=$CVD"
else
  echo "WORKER-DOWN — last log lines:"
  tail -30 "$LOG_DIR/worker-cuda.log"
  exit 1
fi
