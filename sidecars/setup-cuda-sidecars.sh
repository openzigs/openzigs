#!/usr/bin/env bash
# setup-cuda-sidecars.sh
# One-shot setup for CUDA-based ML sidecars in WSL.
# Run from WSL: bash setup-cuda-sidecars.sh
set -euo pipefail

SIDECARS_DIR="$HOME/openzigs-sidecars"
REPO_SIDECARS="$(cd "$(dirname "$0")" && pwd)"
TORCH_INDEX="https://download.pytorch.org/whl/cu121"

echo "=== OpenZigs CUDA Sidecar Setup ==="
echo "Sidecars dir: $SIDECARS_DIR"
echo "Repo sidecars: $REPO_SIDECARS"

# Check CUDA
if ! command -v nvidia-smi &>/dev/null; then
    echo "ERROR: nvidia-smi not found. Ensure NVIDIA drivers are installed in WSL."
    exit 1
fi
echo "GPU: $(nvidia-smi --query-gpu=name --format=csv,noheader)"

# ── Image Generation (Flux) ─────────────────────────────────
echo ""
echo "=== Setting up Image Generation (Flux/diffusers) on port 5005 ==="
IMG_DIR="$SIDECARS_DIR/image-gen"
mkdir -p "$IMG_DIR"

if [ ! -d "$IMG_DIR/venv" ]; then
    python3 -m venv "$IMG_DIR/venv"
fi
source "$IMG_DIR/venv/bin/activate"
pip install --upgrade pip -q
pip install torch torchvision --index-url "$TORCH_INDEX" -q
pip install -U git+https://github.com/huggingface/diffusers
pip install transformers accelerate safetensors peft \
    fastapi uvicorn Pillow sentencepiece protobuf tqdm -q
deactivate

cp "$REPO_SIDECARS/image-gen/server_cuda.py" "$IMG_DIR/server.py"
cp "$REPO_SIDECARS/image-gen/train_dreambooth_lora_cuda.py" "$IMG_DIR/train_dreambooth_lora_cuda.py"
echo "Image-gen setup complete."

# ── Video Worker (LTX) ──────────────────────────────────────
echo ""
echo "=== Setting up Video Worker (LTX/diffusers) on port 5007 ==="
VID_DIR="$SIDECARS_DIR/worker"
mkdir -p "$VID_DIR"

if [ ! -d "$VID_DIR/venv" ]; then
    python3 -m venv "$VID_DIR/venv"
fi
source "$VID_DIR/venv/bin/activate"
pip install --upgrade pip -q
pip install torch --index-url "$TORCH_INDEX" -q
pip install -U git+https://github.com/huggingface/diffusers
pip install transformers accelerate safetensors \
    fastapi uvicorn httpx sentencepiece protobuf -q
deactivate

cp "$REPO_SIDECARS/worker/server_cuda.py" "$VID_DIR/server.py"
echo "Video worker setup complete."

# ── Audio (Whisper + TTS) ───────────────────────────────────
echo ""
echo "=== Setting up Audio Sidecar (faster-whisper + Kokoro) on port 5006 ==="
AUD_DIR="$SIDECARS_DIR/audio"
mkdir -p "$AUD_DIR"

if [ ! -d "$AUD_DIR/venv" ]; then
    python3 -m venv "$AUD_DIR/venv"
fi
source "$AUD_DIR/venv/bin/activate"
pip install --upgrade pip -q
pip install torch --index-url "$TORCH_INDEX" -q
pip install faster-whisper kokoro soundfile numpy \
    fastapi uvicorn python-multipart -q
deactivate

cp "$REPO_SIDECARS/audio/server_cuda.py" "$AUD_DIR/server.py"
echo "Audio sidecar setup complete."

# ── Summary ─────────────────────────────────────────────────
echo ""
echo "=== Setup Complete ==="
echo "Start all sidecars with: bash $REPO_SIDECARS/start-cuda-sidecars.sh"
echo ""
echo "Ports:"
echo "  Image Gen (Flux):   http://localhost:5005"
echo "  Audio (STT/TTS):    http://localhost:5006"
echo "  Video Worker (LTX): http://localhost:5007"
