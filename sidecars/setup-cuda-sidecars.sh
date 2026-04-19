#!/usr/bin/env bash
# setup-cuda-sidecars.sh
# One-shot setup for CUDA-based ML sidecars in WSL.
# Run from WSL: bash setup-cuda-sidecars.sh
set -euo pipefail

SIDECARS_DIR="$HOME/openzigs-sidecars"
REPO_SIDECARS="${REPO_SIDECARS:-$(cd "$(dirname "$0")" && pwd)}"
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
echo "=== Setting up Audio Sidecar (faster-whisper + Kokoro + F5-TTS) on port 5006 ==="
AUD_DIR="$SIDECARS_DIR/audio"
mkdir -p "$AUD_DIR"

if [ ! -d "$AUD_DIR/venv" ]; then
    python3 -m venv "$AUD_DIR/venv"
fi
source "$AUD_DIR/venv/bin/activate"
pip install --upgrade pip -q
# Install PyTorch with CUDA wheels FIRST so f5-tts uses the GPU-enabled build
pip install torch torchaudio --index-url "$TORCH_INDEX" -q
# Install all audio sidecar deps (Kokoro + faster-whisper + F5-TTS)
pip install -r "$REPO_SIDECARS/audio/requirements-cuda.txt" -q
deactivate

cp "$REPO_SIDECARS/audio/server_cuda.py" "$AUD_DIR/server.py"
echo "Audio sidecar setup complete (Kokoro + F5-TTS voice cloning)."

# ── Lip Sync (LatentSync) ───────────────────────────────────
echo ""
echo "=== Setting up Lip Sync (LatentSync) on port 5010 ==="
LIP_DIR="$SIDECARS_DIR/lipsync"
mkdir -p "$LIP_DIR"

if [ ! -d "$LIP_DIR/venv" ]; then
    python3 -m venv "$LIP_DIR/venv"
fi
source "$LIP_DIR/venv/bin/activate"
pip install --upgrade pip -q
pip install torch torchvision torchaudio --index-url "$TORCH_INDEX" -q
pip install -r "$REPO_SIDECARS/lipsync/requirements-cuda.txt" -q
deactivate

cp "$REPO_SIDECARS/lipsync/server_cuda.py" "$LIP_DIR/server.py"
echo "Lip sync sidecar setup complete."

# ── Music / ACE-Step (port 5009) ─────────────────────────────
echo ""
echo "=== Setting up Music (ACE-Step) on port 5009 ==="
MUS_DIR="$SIDECARS_DIR/music"
mkdir -p "$MUS_DIR"

if [ ! -d "$MUS_DIR/venv" ]; then
    python3 -m venv "$MUS_DIR/venv"
fi
source "$MUS_DIR/venv/bin/activate"
pip install --upgrade pip -q
pip install torch torchaudio --index-url "$TORCH_INDEX" -q
pip install soundfile numpy -q

# Clone ACE-Step repo for CUDA (original upstream, not Apple Silicon fork)
ACESTEP_DIR="$HOME/ace-step"
if [ ! -d "$ACESTEP_DIR" ]; then
    echo "Cloning ACE-Step repo..."
    git clone --depth 1 https://github.com/ace-step/ACE-Step.git "$ACESTEP_DIR"
    cd "$ACESTEP_DIR" && pip install -e . -q && cd -
else
    echo "ACE-Step repo already present at $ACESTEP_DIR"
fi
deactivate

cp "$REPO_SIDECARS/music/server.py" "$MUS_DIR/server.py"
echo "Music sidecar setup complete."

# ── SadTalker (Talking Head) ─────────────────────────────────
echo ""
echo "=== Setting up SadTalker (Talking Head) on port 5011 ==="
SAD_DIR="$SIDECARS_DIR/sadtalker"
mkdir -p "$SAD_DIR"

# Clone SadTalker repo for model code
SADTALKER_MODEL_DIR="$HOME/.openzigs/models/SadTalker"
if [ ! -d "$SADTALKER_MODEL_DIR" ]; then
    echo "Cloning SadTalker repo..."
    git clone --depth 1 https://github.com/OpenTalker/SadTalker.git "$SADTALKER_MODEL_DIR"
else
    echo "SadTalker repo already present at $SADTALKER_MODEL_DIR"
fi

# Download checkpoints if not present
if [ ! -d "$SADTALKER_MODEL_DIR/checkpoints" ] || [ -z "$(ls -A "$SADTALKER_MODEL_DIR/checkpoints" 2>/dev/null)" ]; then
    echo "Downloading SadTalker checkpoints..."
    cd "$SADTALKER_MODEL_DIR" && bash scripts/download_models.sh && cd -
else
    echo "SadTalker checkpoints already present."
fi

# Download GFPGAN weights for face enhancement
GFPGAN_DIR="$SADTALKER_MODEL_DIR/gfpgan/weights"
if [ ! -f "$GFPGAN_DIR/GFPGANv1.4.pth" ]; then
    echo "Downloading GFPGAN weights..."
    mkdir -p "$GFPGAN_DIR"
    wget -q -O "$GFPGAN_DIR/GFPGANv1.4.pth" \
        "https://github.com/TencentARC/GFPGAN/releases/download/v1.3.0/GFPGANv1.4.pth"
else
    echo "GFPGAN weights already present."
fi

if [ ! -d "$SAD_DIR/venv" ]; then
    python3 -m venv "$SAD_DIR/venv"
fi
source "$SAD_DIR/venv/bin/activate"
pip install --upgrade pip -q
pip install torch torchvision torchaudio --index-url "$TORCH_INDEX" -q
pip install -r "$REPO_SIDECARS/sadtalker/requirements-cuda.txt" -q

# Install dlib (may need cmake)
if ! python3 -c "import dlib" 2>/dev/null; then
    echo "Installing dlib (this may take a few minutes)..."
    pip install cmake -q
    pip install dlib -q
fi
deactivate

cp "$REPO_SIDECARS/sadtalker/server_cuda.py" "$SAD_DIR/server.py"
echo "SadTalker setup complete."

# ── Summary ─────────────────────────────────────────────────
echo ""
echo "=== Setup Complete ==="
echo "Start all sidecars with: bash $REPO_SIDECARS/start-cuda-sidecars.sh"
echo ""
echo "Ports:"
echo "  Image Gen (Flux):   http://localhost:5005"
echo "  Audio (STT/TTS):    http://localhost:5006"
echo "  Video Worker (LTX): http://localhost:5007"
echo "  Music (ACE-Step):   http://localhost:5009"
echo "  Lip Sync:           http://localhost:5010"
echo "  SadTalker:          http://localhost:5011"
