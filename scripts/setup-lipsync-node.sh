#!/usr/bin/env bash
# setup-lipsync-node.sh
# One-shot setup for the LatentSync lip-sync sidecar (macOS MPS).
# Run: bash scripts/setup-lipsync-node.sh
set -euo pipefail

SIDECARS_DIR="${OPENZIGS_SIDECARS_DIR:-$HOME/openzigs-sidecars}"
REPO_SIDECARS="$(cd "$(dirname "$0")/../sidecars" && pwd)"
LIP_DIR="$SIDECARS_DIR/lipsync"

echo "=== LatentSync Lip Sync Setup (MPS) ==="
echo "Install dir: $LIP_DIR"

mkdir -p "$LIP_DIR"

# ── Create Python venv ──────────────────────────────────────
if [ ! -d "$LIP_DIR/venv" ]; then
    echo "Creating Python virtual environment..."
    python3 -m venv "$LIP_DIR/venv"
fi

source "$LIP_DIR/venv/bin/activate"
pip install --upgrade pip -q
pip install -r "$REPO_SIDECARS/lipsync/requirements-mps.txt" -q
deactivate

# ── Copy server ─────────────────────────────────────────────
cp "$REPO_SIDECARS/lipsync/server.py" "$LIP_DIR/server.py"

# ── Copy .env template ──────────────────────────────────────
if [ ! -f "$LIP_DIR/.env" ]; then
    cp "$REPO_SIDECARS/lipsync/.env.example" "$LIP_DIR/.env"
    echo "Created $LIP_DIR/.env — edit it to set LIPSYNC_SECRET_TOKEN"
fi

echo ""
echo "=== Setup Complete ==="
echo "Start: cd $LIP_DIR && source venv/bin/activate && python server.py --port 5008"
echo "Health: curl http://localhost:5008/health"
