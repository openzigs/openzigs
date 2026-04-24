#!/usr/bin/env bash
set -euo pipefail
# Restart the LTX video worker on port 5007.
#
# LTX_POOLING_MODE defaults to `auto` so the diffusers
# `device_map="balanced"` sharding path (#949 fix landed 2026-04-24) is
# exercised on multi-GPU hosts. Override per-invocation, e.g.:
#   LTX_POOLING_MODE=off bash scripts/worker_restart.sh   # single-GPU only
#   LTX_POOLING_MODE=manual bash scripts/worker_restart.sh # force pooling
fuser -k 5007/tcp 2>/dev/null || true
sleep 2
cd ~/openzigs-sidecars/worker
source venv/bin/activate
export LTX_POOLING_MODE="${LTX_POOLING_MODE:-auto}"
# #952: Expose BOTH RTX 3060 cards to the worker so the diffusers
# `device_map="balanced"` pooling path (#949) actually has a second
# device to shard onto. Previously the worker process inherited a
# CUDA_VISIBLE_DEVICES=0 from the parent shell which made
# torch.cuda.device_count() return 1 and pooling.active=false even
# though `nvidia-smi` from outside reported both cards.
export CUDA_VISIBLE_DEVICES="${CUDA_VISIBLE_DEVICES:-0,1}"
nohup python server_cuda.py --port 5007 --host 0.0.0.0 > /tmp/worker.log 2>&1 &
echo "PID=$!"
sleep 6
echo "--- port ---"
ss -ltn | awk '{print $4}' | grep -E ':5007$' || echo NOT_LISTENING
echo "--- log tail ---"
tail -25 /tmp/worker.log
