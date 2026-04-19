#!/usr/bin/env bash
# start-cuda-sidecars.sh
# Start all CUDA ML sidecars as background processes in WSL.
# Uses setsid + nohup so processes survive when the parent wsl session exits.
# Run from WSL: bash start-cuda-sidecars.sh
# NOTE: intentionally no 'set -e' — individual sidecar failures must not
#       prevent the remaining sidecars from starting.
set -u

SIDECARS_DIR="$HOME/openzigs-sidecars"
LOG_DIR="$HOME/.openzigs/logs"
PID_DIR="$HOME/.openzigs/pids"

# Read HF_TOKEN from the Windows .env file if not already set
ENV_FILE="/mnt/c/Users/mgbre/Development/openzigs/.env"
if [ -z "${HF_TOKEN:-}" ] && [ -f "$ENV_FILE" ]; then
    HF_TOKEN=$(grep -m1 '^HF_TOKEN=' "$ENV_FILE" | cut -d= -f2- | tr -d '\r' || true)
export HF_TOKEN
fi

# Read CALLBACK_SECRET from ~/.openzigs/config.json
# Try WSL-local config first, then fall back to Windows host config
CONFIG_FILE="$HOME/.openzigs/config.json"
# Resolve Windows username without fragile cmd.exe call — use /mnt/c/Users/*/.openzigs glob
_WIN_USER_HOME=$(ls -d /mnt/c/Users/*/.openzigs 2>/dev/null | head -1 | xargs dirname 2>/dev/null || true)
WIN_CONFIG_FILE="${_WIN_USER_HOME:+${_WIN_USER_HOME}/.openzigs/config.json}"
if [ ! -f "$CONFIG_FILE" ] && [ -f "$WIN_CONFIG_FILE" ]; then
    CONFIG_FILE="$WIN_CONFIG_FILE"
fi
CALLBACK_SECRET=""
if [ -f "$CONFIG_FILE" ] && command -v python3 &>/dev/null; then
    CALLBACK_SECRET=$(python3 -c "import json,sys; d=json.load(open('$CONFIG_FILE')); print(d.get('auth',{}).get('workerSecret',''))" 2>/dev/null || true)
fi
mkdir -p "$LOG_DIR" "$PID_DIR"

# ── Machine-specific model configuration ─────────────────────
# Override these in ~/.openzigs/.env.cuda or export before running.
# LTX Video model: ltxv-13b-097-distilled (default), ltxv-13b-097-dev,
#   ltxv-2b-096-distilled, ltxv-2b-legacy
LTX_MODEL_KEY="${LTX_MODEL_KEY:-ltxv-13b-097-distilled}"
# Flux Image model: flux-dev (default, high quality), flux-schnell (fast)
FLUX_DEFAULT_MODEL="${FLUX_DEFAULT_MODEL:-flux-dev}"

# Read additional overrides from optional per-machine env file
CUDA_ENV="$HOME/.openzigs/.env.cuda"
if [ -f "$CUDA_ENV" ]; then
    echo "Loading CUDA env overrides from $CUDA_ENV"
    set -a; source "$CUDA_ENV"; set +a
fi

echo "=== Starting CUDA Sidecars ==="

# ── Multi-GPU device pinning (Epic #883, Issue #884) ─────────
# Auto-detect GPU count via nvidia-smi. When ≥2 GPUs are present, split the
# workload so the talking-head pipeline (TTS → video → lipsync) can overlap:
#   image-gen + audio → GPU 0
#   worker (video) + lipsync + sadtalker → GPU 1
# Override per-sidecar via *_GPU_INDEX env vars (e.g. WORKER_GPU_INDEX=0).
GPU_COUNT=0
if command -v nvidia-smi &>/dev/null; then
    GPU_COUNT=$(nvidia-smi -L 2>/dev/null | wc -l || echo 0)
fi
echo "Detected $GPU_COUNT NVIDIA GPU(s)"

if [ "$GPU_COUNT" -ge 2 ]; then
    IMAGE_GEN_GPU_INDEX="${IMAGE_GEN_GPU_INDEX:-0}"
    AUDIO_GPU_INDEX="${AUDIO_GPU_INDEX:-0}"
    WORKER_GPU_INDEX="${WORKER_GPU_INDEX:-1}"
    LIPSYNC_GPU_INDEX="${LIPSYNC_GPU_INDEX:-1}"
    SADTALKER_GPU_INDEX="${SADTALKER_GPU_INDEX:-1}"
    MUSIC_GPU_INDEX="${MUSIC_GPU_INDEX:-0}"
    echo "Multi-GPU pinning: image-gen=$IMAGE_GEN_GPU_INDEX, audio=$AUDIO_GPU_INDEX, worker=$WORKER_GPU_INDEX, lipsync=$LIPSYNC_GPU_INDEX, sadtalker=$SADTALKER_GPU_INDEX, music=$MUSIC_GPU_INDEX"
else
    IMAGE_GEN_GPU_INDEX="${IMAGE_GEN_GPU_INDEX:-0}"
    AUDIO_GPU_INDEX="${AUDIO_GPU_INDEX:-0}"
    WORKER_GPU_INDEX="${WORKER_GPU_INDEX:-0}"
    LIPSYNC_GPU_INDEX="${LIPSYNC_GPU_INDEX:-0}"
    SADTALKER_GPU_INDEX="${SADTALKER_GPU_INDEX:-0}"
    MUSIC_GPU_INDEX="${MUSIC_GPU_INDEX:-0}"
fi

# Kill any existing sidecar processes
for port in 5005 5006 5007 5009 5010 5011; do
    pid=$(lsof -ti :$port 2>/dev/null || true)
    if [ -n "$pid" ]; then
        echo "Killing existing process on port $port (PID: $pid)"
        kill "$pid" 2>/dev/null || true
        sleep 1
    fi
done

# ── Image Generation (port 5005) ────────────────────────────
echo "Starting Image Gen sidecar (port 5005, GPU $IMAGE_GEN_GPU_INDEX)..."
setsid bash -c "cd '$SIDECARS_DIR/image-gen' && source venv/bin/activate && CUDA_VISIBLE_DEVICES='$IMAGE_GEN_GPU_INDEX' HF_TOKEN='${HF_TOKEN:-}' FLUXQ_CALLBACK_SECRET='${CALLBACK_SECRET:-}' FLUX_DEFAULT_MODEL='${FLUX_DEFAULT_MODEL:-flux-dev}' exec python server_cuda.py --port 5005 >> '$LOG_DIR/image-gen-cuda.log' 2>&1" &
IMG_PID=$!
echo "$IMG_PID" > "$PID_DIR/image-gen.pid"
echo "  PID: $IMG_PID"

# ── Audio (port 5006) ───────────────────────────────────────
echo "Starting Audio sidecar (port 5006, GPU $AUDIO_GPU_INDEX)..."
setsid bash -c "cd '$SIDECARS_DIR/audio' && source venv/bin/activate && CUDA_VISIBLE_DEVICES='$AUDIO_GPU_INDEX' exec python server_cuda.py --port 5006 >> '$LOG_DIR/audio-cuda.log' 2>&1" &
AUD_PID=$!
echo "$AUD_PID" > "$PID_DIR/audio.pid"
echo "  PID: $AUD_PID"

# ── Video Worker (port 5007) ────────────────────────────────
echo "Starting Video Worker sidecar (port 5007, GPU $WORKER_GPU_INDEX)..."
setsid bash -c "cd '$SIDECARS_DIR/worker' && source venv/bin/activate && CUDA_VISIBLE_DEVICES='$WORKER_GPU_INDEX' HF_TOKEN='${HF_TOKEN:-}' CALLBACK_SECRET='${CALLBACK_SECRET:-}' LTX_MODEL_KEY='${LTX_MODEL_KEY:-ltxv-13b-097-distilled}' exec python server_cuda.py --port 5007 >> '$LOG_DIR/worker-cuda.log' 2>&1" &
VID_PID=$!
echo "$VID_PID" > "$PID_DIR/worker.pid"
echo "  PID: $VID_PID"

# ── Music / ACE-Step (port 5009) ──────────────────────────
if [ -d "$SIDECARS_DIR/music" ]; then
    echo "Starting Music sidecar (port 5009, GPU $MUSIC_GPU_INDEX)..."
    setsid bash -c "cd '$SIDECARS_DIR/music' && source venv/bin/activate && CUDA_VISIBLE_DEVICES='$MUSIC_GPU_INDEX' ACESTEP_DIR='$HOME/ace-step' ACESTEP_DEVICE='cuda' exec python server.py --port 5009 >> '$LOG_DIR/music-cuda.log' 2>&1" &
    MUS_PID=$!
    echo "$MUS_PID" > "$PID_DIR/music.pid"
    echo "  PID: $MUS_PID"
else
    echo "Music sidecar not deployed (skipping port 5009)"
    MUS_PID=""
fi

# ── Resolve Windows host IP for callbacks from WSL ──────────
# Sidecars running in WSL need to POST callbacks to the Windows host, not localhost.
WSL_HOST_IP=$(cat /etc/resolv.conf 2>/dev/null | grep nameserver | awk '{print $2}' | head -1)
if [ -n "$WSL_HOST_IP" ]; then
    CALLBACK_BASE_URL="http://${WSL_HOST_IP}:3000/api/queue"
    echo "WSL host IP: $WSL_HOST_IP (callback base: $CALLBACK_BASE_URL)"
else
    CALLBACK_BASE_URL="http://localhost:3000/api/queue"
    echo "Could not detect WSL host IP — using localhost for callbacks"
fi

# ── Lip Sync / LatentSync (port 5010) ───────────────────────
if [ -d "$SIDECARS_DIR/lipsync" ]; then
    echo "Starting Lip Sync sidecar (port 5010, GPU $LIPSYNC_GPU_INDEX)..."
    setsid bash -c "cd '$SIDECARS_DIR/lipsync' && source venv/bin/activate && CUDA_VISIBLE_DEVICES='$LIPSYNC_GPU_INDEX' CALLBACK_SECRET='${CALLBACK_SECRET:-}' CALLBACK_URL='${CALLBACK_BASE_URL}/complete' PROGRESS_URL='${CALLBACK_BASE_URL}/progress' exec python server_cuda.py --port 5010 >> '$LOG_DIR/lipsync-cuda.log' 2>&1" &
    LIP_PID=$!
    echo "$LIP_PID" > "$PID_DIR/lipsync.pid"
    echo "  PID: $LIP_PID"
else
    echo "Lip Sync sidecar not deployed (skipping port 5010)"
    LIP_PID=""
fi

# ── SadTalker / Talking Head (port 5011) ────────────────────
if [ -d "$SIDECARS_DIR/sadtalker" ]; then
    echo "Starting SadTalker sidecar (port 5011, GPU $SADTALKER_GPU_INDEX)..."
    setsid bash -c "cd '$SIDECARS_DIR/sadtalker' && source venv/bin/activate && CUDA_VISIBLE_DEVICES='$SADTALKER_GPU_INDEX' SADTALKER_DIR='$HOME/.openzigs/models/SadTalker' GALLERY_DIR='$HOME/.openzigs/gallery' CALLBACK_SECRET='${CALLBACK_SECRET:-}' CALLBACK_URL='${CALLBACK_BASE_URL}/complete' PROGRESS_URL='${CALLBACK_BASE_URL}/progress' exec python server_cuda.py --port 5011 >> '$LOG_DIR/sadtalker-cuda.log' 2>&1" &
    SAD_PID=$!
    echo "$SAD_PID" > "$PID_DIR/sadtalker.pid"
    echo "  PID: $SAD_PID"
else
    echo "SadTalker sidecar not deployed (skipping port 5011)"
    SAD_PID=""
fi

# Detach background jobs so they survive shell exit
disown -a

# Wait for health endpoints
echo ""
echo "Waiting for sidecars to become ready..."
sleep 8

for entry in "5005:Image Gen" "5006:Audio" "5007:Video Worker" "5009:Music (ACE-Step)" "5010:Lip Sync (LatentSync)" "5011:SadTalker"; do
    port="${entry%%:*}"
    name="${entry##*:}"
    if curl -sf "http://localhost:$port/health" > /dev/null 2>&1; then
        echo "  $name (port $port): READY"
    else
        echo "  $name (port $port): NOT READY (check $LOG_DIR/*-cuda.log)"
    fi
done

echo ""
echo "Sidecar PIDs: image-gen=$IMG_PID, audio=$AUD_PID, worker=$VID_PID${MUS_PID:+, music=$MUS_PID}${LIP_PID:+, lipsync=$LIP_PID}${SAD_PID:+, sadtalker=$SAD_PID}"
echo "Logs: $LOG_DIR/{image-gen,audio,worker,music,lipsync,sadtalker}-cuda.log"
echo ""
echo "To stop all: kill $IMG_PID $AUD_PID $VID_PID${MUS_PID:+ $MUS_PID}${LIP_PID:+ $LIP_PID}${SAD_PID:+ $SAD_PID}"
