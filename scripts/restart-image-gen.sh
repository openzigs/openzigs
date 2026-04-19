#!/usr/bin/env bash
set -e
pid=$(lsof -ti :5005 2>/dev/null || true)
if [ -n "$pid" ]; then
    echo "Killing image-gen pid $pid"
    kill -9 $pid 2>/dev/null || true
fi
sleep 3

ENV_FILE="/mnt/c/Users/mgbre/Development/openzigs/.env"
HF_TOKEN=$(grep -m1 '^HF_TOKEN=' "$ENV_FILE" | cut -d= -f2- | tr -d '\r' || true)
CALLBACK_SECRET=$(python3 -c "import json; print(json.load(open('$HOME/.openzigs/config.json')).get('auth',{}).get('workerSecret',''))" 2>/dev/null || true)

export HF_TOKEN CALLBACK_SECRET FLUXQ_CALLBACK_SECRET="$CALLBACK_SECRET" FLUX_DEFAULT_MODEL=flux-dev CUDA_VISIBLE_DEVICES=0
setsid bash -c "cd $HOME/openzigs-sidecars/image-gen && source venv/bin/activate && exec python server_cuda.py --port 5005 >> $HOME/.openzigs/logs/image-gen-cuda.log 2>&1" &
echo "Image-gen restarted with CUDA_VISIBLE_DEVICES=0"
sleep 6
nvidia-smi --query-gpu=index,memory.used --format=csv,noheader,nounits
