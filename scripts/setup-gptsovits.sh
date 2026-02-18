#!/usr/bin/env bash
# setup-gptsovits.sh — One-shot installer for GPT-SoVITS (Engine B)
#
# What this does:
#   1. Clones https://github.com/RVC-Boss/GPT-SoVITS into
#      ~/.openzigs/sidecars/gptsovits/
#   2. Creates a Python virtual environment and installs dependencies
#   3. Downloads the required pretrained models (~2–4 GB)
#   4. Writes ~/.openzigs/sidecars/gptsovits/start.sh  ← run this to start
#
# Requirements:
#   - Python 3.9–3.11 (3.12 not yet tested upstream)
#   - git
#   - ~4 GB free disk space
#   - ~8 GB RAM (model + inference)
#   - Apple Silicon (MPS) or CUDA GPU recommended; CPU-only works but is slow
#
# Usage:
#   bash scripts/setup-gptsovits.sh
#   # then start the server:
#   ~/.openzigs/sidecars/gptsovits/start.sh

set -euo pipefail

INSTALL_DIR="${GPTSOVITS_DIR:-$HOME/.openzigs/sidecars/gptsovits}"
REPO_URL="https://github.com/RVC-Boss/GPT-SoVITS.git"
SOVITS_HOST="${SOVITS_HOST:-127.0.0.1}"
SOVITS_PORT="${SOVITS_PORT:-9880}"

# ── Helpers ──────────────────────────────────────────────────────────────────

info()  { echo "  [gptsovits] $*"; }
ok()    { echo "  ✓ $*"; }
err()   { echo "  ✗ ERROR: $*" >&2; exit 1; }
sep()   { echo ""; echo "─────────────────────────────────────────"; }

# ── Pre-flight checks ────────────────────────────────────────────────────────

sep
echo "  GPT-SoVITS installer for OpenZigs Engine B"
sep

command -v python3 >/dev/null 2>&1 || err "python3 not found. Install Python 3.9–3.11."
command -v git     >/dev/null 2>&1 || err "git not found."

PYTHON_VERSION=$(python3 -c "import sys; print(f'{sys.version_info.major}.{sys.version_info.minor}')")
info "Python version: $PYTHON_VERSION"

PY_MAJOR=$(python3 -c "import sys; print(sys.version_info.major)")
PY_MINOR=$(python3 -c "import sys; print(sys.version_info.minor)")
if [[ "$PY_MAJOR" -lt 3 ]] || [[ "$PY_MAJOR" -eq 3 && "$PY_MINOR" -lt 9 ]]; then
  err "Python 3.9+ required (found $PYTHON_VERSION)."
fi

# ── Clone repo ───────────────────────────────────────────────────────────────

sep
if [[ -d "$INSTALL_DIR/.git" ]]; then
  info "Repo already cloned at $INSTALL_DIR — pulling latest…"
  git -C "$INSTALL_DIR" pull --ff-only
else
  info "Cloning GPT-SoVITS into $INSTALL_DIR…"
  mkdir -p "$(dirname "$INSTALL_DIR")"
  git clone --depth 1 "$REPO_URL" "$INSTALL_DIR"
fi
ok "Repo ready at $INSTALL_DIR"

# ── Virtual environment ──────────────────────────────────────────────────────

sep
VENV_DIR="$INSTALL_DIR/.venv"
if [[ ! -d "$VENV_DIR" ]]; then
  info "Creating Python virtual environment…"
  python3 -m venv "$VENV_DIR"
fi
ok "Virtual environment ready"

# shellcheck disable=SC1090
source "$VENV_DIR/bin/activate"

info "Upgrading pip…"
pip install --quiet --upgrade pip

# ── Install dependencies ─────────────────────────────────────────────────────

sep
info "Installing Python dependencies (this may take a few minutes)…"

# Install torch for Apple Silicon if on macOS
if [[ "$(uname)" == "Darwin" ]]; then
  info "macOS detected — installing PyTorch with MPS support…"
  pip install --quiet torch torchaudio --index-url https://download.pytorch.org/whl/cpu
fi

if [[ -f "$INSTALL_DIR/requirements.txt" ]]; then
  pip install --quiet -r "$INSTALL_DIR/requirements.txt"
else
  # Fallback: known core deps for api_v2.py
  pip install --quiet \
    fastapi uvicorn pydantic \
    numpy soundfile librosa \
    transformers huggingface_hub \
    jieba pypinyin
fi
ok "Dependencies installed"

# ── Download pretrained models ───────────────────────────────────────────────

sep
info "Downloading pretrained models from Hugging Face (~2 GB)…"
info "(If this fails due to network restrictions, see README for manual download)"

# GPT-SoVITS v2 base models
python3 - <<'PYEOF'
import os, sys
try:
    from huggingface_hub import snapshot_download
    repo_id = "lj1995/GPT-SoVITS"
    local_dir = os.path.expanduser("~/.openzigs/sidecars/gptsovits/GPT_SoVITS/pretrained_models")
    os.makedirs(local_dir, exist_ok=True)
    snapshot_download(
        repo_id=repo_id,
        local_dir=local_dir,
        ignore_patterns=["*.bin.index.json"],  # skip large unused index files
    )
    print("  ✓ Pretrained models downloaded")
except ImportError:
    print("  ℹ huggingface_hub not available — models will be downloaded on first TTS request")
except Exception as e:
    print(f"  ℹ Model download skipped ({e}) — models will be downloaded on first use")
PYEOF

# ── Write start script ───────────────────────────────────────────────────────

sep
START_SCRIPT="$INSTALL_DIR/start.sh"
cat > "$START_SCRIPT" <<STARTEOF
#!/usr/bin/env bash
# start.sh — Start the GPT-SoVITS API server for OpenZigs Engine B
#
# The server binds to http://${SOVITS_HOST}:${SOVITS_PORT}
# Keep this terminal open while using Engine B in OpenZigs.
#
# To stop: Ctrl-C

set -euo pipefail
cd "\$(dirname "\$0")"
source .venv/bin/activate

echo ""
echo "  Starting GPT-SoVITS API server…"
echo "  Endpoint: http://${SOVITS_HOST}:${SOVITS_PORT}"
echo "  Press Ctrl-C to stop."
echo ""

python api_v2.py \
  --host ${SOVITS_HOST} \
  --port ${SOVITS_PORT}
STARTEOF
chmod +x "$START_SCRIPT"
ok "Start script written: $START_SCRIPT"

# ── Done ─────────────────────────────────────────────────────────────────────

sep
echo ""
echo "  GPT-SoVITS installation complete!"
echo ""
echo "  To start Engine B:"
echo "    $START_SCRIPT"
echo ""
echo "  Then in OpenZigs Voice Lab → expand 'Set up Engine B' → refresh → switch."
echo ""
