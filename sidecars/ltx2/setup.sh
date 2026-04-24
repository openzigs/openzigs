#!/usr/bin/env bash
# sidecars/ltx2/setup.sh
# Idempotent provisioning script for the LTX-2 native audio+video sidecar.
#
# Run from WSL (or any Linux host with NVIDIA driver ≥ 535 + CUDA 12.x):
#   bash sidecars/ltx2/setup.sh
#
# What it does (skips each step if already complete):
#   1. Installs `uv` to ~/.local/bin if missing
#   2. Clones Lightricks/LTX-2 to ~/openzigs-sidecars/ltx2-src/
#   3. Runs `uv sync --frozen` (creates .venv with PyTorch 2.9 / CUDA 12.8)
#   4. Downloads ~53 GB of model artefacts to ~/openzigs-sidecars/ltx2-models/
#
# HF auth: reads HF_TOKEN from the repo .env (loaded automatically) or env.
# The Gemma 3 12B text encoder is gated — accept the license at
# https://huggingface.co/unsloth/gemma-3-12b-it before running.

set -euo pipefail

SRC_ROOT="${LTX2_SRC_ROOT:-$HOME/openzigs-sidecars/ltx2-src}"
MODELS_ROOT="${LTX2_MODELS_ROOT:-$HOME/openzigs-sidecars/ltx2-models}"
ENV_FILE="${OPENZIGS_ENV_FILE:-/mnt/c/Users/mgbre/Development/openzigs/.env}"

# ── Load HF_TOKEN from repo .env if not exported ───────────────────────
if [ -z "${HF_TOKEN:-}" ] && [ -f "$ENV_FILE" ]; then
    HF_TOKEN=$(grep -m1 '^HF_TOKEN=' "$ENV_FILE" | cut -d= -f2- | tr -d '\r' || true)
    export HF_TOKEN
fi
if [ -z "${HF_TOKEN:-}" ]; then
    echo "ERROR: HF_TOKEN not set. Export it or add to $ENV_FILE." >&2
    exit 1
fi

# ── 1. Install uv if missing ───────────────────────────────────────────
if ! command -v uv &>/dev/null; then
    if [ ! -x "$HOME/.local/bin/uv" ]; then
        echo "[ltx2-setup] installing uv to $HOME/.local/bin"
        curl -LsSf https://astral.sh/uv/install.sh | sh
    fi
    # shellcheck disable=SC1091
    [ -f "$HOME/.local/bin/env" ] && source "$HOME/.local/bin/env"
    export PATH="$HOME/.local/bin:$PATH"
fi
echo "[ltx2-setup] uv: $(uv --version)"

# ── 2. Clone Lightricks/LTX-2 monorepo ────────────────────────────────
mkdir -p "$(dirname "$SRC_ROOT")"
if [ ! -d "$SRC_ROOT/.git" ]; then
    echo "[ltx2-setup] cloning Lightricks/LTX-2 → $SRC_ROOT"
    git clone --depth 1 https://github.com/Lightricks/LTX-2.git "$SRC_ROOT"
else
    echo "[ltx2-setup] monorepo already cloned at $SRC_ROOT"
fi

# ── 3. uv sync — creates .venv with torch + ltx_pipelines ─────────────
cd "$SRC_ROOT"
if [ ! -x "$SRC_ROOT/.venv/bin/python" ]; then
    echo "[ltx2-setup] uv sync --frozen (downloads ~5 GB torch+CUDA wheels)"
    uv sync --frozen
else
    echo "[ltx2-setup] .venv already provisioned"
fi
# Verify imports
"$SRC_ROOT/.venv/bin/python" -c "import ltx_pipelines, ltx_core; print('imports OK')"

# ── 4. Download model artefacts ───────────────────────────────────────
mkdir -p "$MODELS_ROOT/ltx2" "$MODELS_ROOT/gemma-3-12b"

# Use the venv's huggingface-cli (transformers pulls in huggingface_hub).
HF_CLI="$SRC_ROOT/.venv/bin/huggingface-cli"
if [ ! -x "$HF_CLI" ]; then
    "$SRC_ROOT/.venv/bin/pip" install --quiet "huggingface_hub[cli]"
fi

DISTILLED="$MODELS_ROOT/ltx2/ltx-2.3-22b-dev-fp8.safetensors"
UPSCALER="$MODELS_ROOT/ltx2/ltx-2.3-spatial-upscaler-x2-1.1.safetensors"

if [ ! -f "$DISTILLED" ]; then
    echo "[ltx2-setup] downloading distilled checkpoint (~29 GB)"
    "$HF_CLI" download Lightricks/LTX-2.3-fp8 \
        ltx-2.3-22b-dev-fp8.safetensors \
        --local-dir "$MODELS_ROOT/ltx2"
else
    echo "[ltx2-setup] distilled checkpoint already present"
fi

if [ ! -f "$UPSCALER" ]; then
    echo "[ltx2-setup] downloading spatial upscaler (~1 GB)"
    "$HF_CLI" download Lightricks/LTX-2.3 \
        ltx-2.3-spatial-upscaler-x2-1.1.safetensors \
        --local-dir "$MODELS_ROOT/ltx2"
else
    echo "[ltx2-setup] spatial upscaler already present"
fi

GEMMA_SHARDS=$(find "$MODELS_ROOT/gemma-3-12b" -maxdepth 1 -name 'model-*.safetensors' 2>/dev/null | wc -l)
if [ "$GEMMA_SHARDS" -lt 5 ]; then
    echo "[ltx2-setup] downloading Gemma 3 12B text encoder (~23 GB; gated)"
    "$HF_CLI" download unsloth/gemma-3-12b-it \
        --local-dir "$MODELS_ROOT/gemma-3-12b"
else
    echo "[ltx2-setup] Gemma 3 12B already present ($GEMMA_SHARDS shards)"
fi

echo ""
echo "[ltx2-setup] DONE. Sidecar can now be launched:"
echo "  cd $SRC_ROOT && source .venv/bin/activate"
echo "  cd $(dirname "$0")"
echo "  python server_cuda.py --port 5013"
