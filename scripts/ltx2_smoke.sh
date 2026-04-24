#!/usr/bin/env bash
set -euo pipefail
cd ~/openzigs-sidecars/ltx2-src
source .venv/bin/activate
export PYTORCH_CUDA_ALLOC_CONF=expandable_segments:True
export CUDA_VISIBLE_DEVICES=0
mkdir -p /tmp/ltx2-out
echo "[smoke] start $(date -Is)"
python -m ltx_pipelines.distilled \
  --distilled-checkpoint-path "$HOME/openzigs-sidecars/ltx2-models/ltx2/ltx-2.3-22b-dev-fp8.safetensors" \
  --spatial-upsampler-path  "$HOME/openzigs-sidecars/ltx2-models/ltx2/ltx-2.3-spatial-upscaler-x2-1.1.safetensors" \
  --gemma-root              "$HOME/openzigs-sidecars/ltx2-models/gemma-3-12b" \
  --prompt   "A cat purring softly on a wooden floor in warm afternoon light." \
  --seed 42 --height 512 --width 512 --num-frames 25 --frame-rate 24 \
  --offload cpu \
  --output-path /tmp/ltx2-out/smoke.mp4 2>&1 | tee /tmp/ltx2-out/smoke.log
echo "[smoke] done $(date -Is) exit=$?"
