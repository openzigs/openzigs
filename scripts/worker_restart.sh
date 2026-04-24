#!/usr/bin/env bash
set -euo pipefail
# Restart the LTX video worker on port 5007.
# NOTE: Pooling is forced OFF here. The current pooling implementation places
# the whole 13B transformer on cuda:1 (it does not actually shard layers
# across devices), which OOMs a single 12 GB card during inference. With
# pooling disabled, the worker falls back to enable_model_cpu_offload() which
# IS the supported single-GPU path on this hardware tier. See follow-up bug
# tracking the pooling rework before re-enabling.
fuser -k 5007/tcp 2>/dev/null || true
sleep 2
cd ~/openzigs-sidecars/worker
source venv/bin/activate
export LTX_POOLING_MODE=off
nohup python server_cuda.py --port 5007 --host 0.0.0.0 > /tmp/worker.log 2>&1 &
echo "PID=$!"
sleep 6
echo "--- port ---"
ss -ltn | awk '{print $4}' | grep -E ':5007$' || echo NOT_LISTENING
echo "--- log tail ---"
tail -25 /tmp/worker.log
