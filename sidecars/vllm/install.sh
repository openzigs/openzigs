#!/usr/bin/env bash
# sidecars/vllm/install.sh
# Install + smoke-prep the vLLM dual-GPU sidecar.
#
# Issue #916. This script does NOT pull the model — vLLM downloads it on
# first run. It only:
#   1. Verifies docker + nvidia-smi are present.
#   2. Verifies ≥2 visible GPUs.
#   3. Generates VLLM_API_KEY into ~/.openzigs/vllm-api-key (mode 0600) if
#      one isn't already set.
#   4. Pulls the pinned vllm/vllm-openai image so first start doesn't block
#      on a multi-GB image download.
#
# Run from WSL (not from the openzigs project root):
#   bash sidecars/vllm/install.sh
set -euo pipefail

VLLM_IMAGE="${VLLM_IMAGE:-vllm/vllm-openai:v0.6.4}"
KEY_FILE="$HOME/.openzigs/vllm-api-key"

echo "=== vLLM sidecar install ==="

if ! command -v docker >/dev/null 2>&1; then
    echo "ERROR: docker not found in PATH." >&2
    exit 1
fi
if ! command -v nvidia-smi >/dev/null 2>&1; then
    echo "ERROR: nvidia-smi not found. Install NVIDIA drivers + nvidia-container-toolkit." >&2
    exit 1
fi

GPU_COUNT=$(nvidia-smi --query-gpu=count --format=csv,noheader | head -1 | tr -d ' ')
if [ "$GPU_COUNT" -lt 2 ]; then
    echo "ERROR: vLLM TP=2 requires at least 2 GPUs; found $GPU_COUNT." >&2
    exit 1
fi
echo "Detected $GPU_COUNT GPUs."

mkdir -p "$(dirname "$KEY_FILE")"
chmod 700 "$(dirname "$KEY_FILE")" 2>/dev/null || true

if [ ! -s "$KEY_FILE" ]; then
    # crypto-quality 32-byte key, base64url-encoded (matches Issue #920).
    NEW_KEY=$(python3 -c 'import secrets; print(secrets.token_urlsafe(32))')
    printf '%s' "$NEW_KEY" > "$KEY_FILE"
    chmod 600 "$KEY_FILE"
    echo "Generated new vLLM API key at $KEY_FILE (mode 600)."
else
    echo "Reusing existing vLLM API key at $KEY_FILE."
fi

echo "Pulling $VLLM_IMAGE (this is multi-GB; one-time per host)..."
docker pull "$VLLM_IMAGE"

echo "=== Done. To start: ==="
echo "  export VLLM_API_KEY=\"\$(cat $KEY_FILE)\""
echo "  docker compose -f docker-compose.vllm.yml up -d"
