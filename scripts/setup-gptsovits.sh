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

command -v git     >/dev/null 2>&1 || err "git not found."

# Find a compatible Python (3.9–3.12). GPT-SoVITS deps don't have wheels for 3.13+.
PYTHON=""
for candidate in python3.12 python3.11 python3.10 python3.9 python3; do
  if command -v "$candidate" >/dev/null 2>&1; then
    _major=$("$candidate" -c "import sys; print(sys.version_info.major)")
    _minor=$("$candidate" -c "import sys; print(sys.version_info.minor)")
    if [[ "$_major" -eq 3 && "$_minor" -ge 9 && "$_minor" -le 12 ]]; then
      PYTHON="$(command -v "$candidate")"
      break
    fi
  fi
done
[[ -z "$PYTHON" ]] && err "No compatible Python 3.9–3.12 found. Install one with: brew install python@3.12"

PYTHON_VERSION=$("$PYTHON" -c "import sys; print(f'{sys.version_info.major}.{sys.version_info.minor}')")
info "Using Python $PYTHON_VERSION ($PYTHON)"

# ── Clone repo ───────────────────────────────────────────────────────────────

sep
if [[ -d "$INSTALL_DIR/.git" ]]; then
  info "Repo already cloned at ${INSTALL_DIR} — pulling latest…"
  git -C "$INSTALL_DIR" pull --ff-only
else
  info "Cloning GPT-SoVITS into ${INSTALL_DIR}…"
  mkdir -p "$(dirname "$INSTALL_DIR")"
  git clone --depth 1 "$REPO_URL" "$INSTALL_DIR"
fi
ok "Repo ready at $INSTALL_DIR"

# ── Virtual environment ──────────────────────────────────────────────────────

sep
VENV_DIR="$INSTALL_DIR/.venv"
# If existing venv was created with an incompatible Python, remove it
if [[ -d "$VENV_DIR" ]]; then
  EXISTING_PY=$("$VENV_DIR/bin/python" -c "import sys; print(f'{sys.version_info.major}.{sys.version_info.minor}')" 2>/dev/null || echo "unknown")
  if [[ "$EXISTING_PY" != "$PYTHON_VERSION" ]]; then
    info "Existing venv uses Python $EXISTING_PY (need $PYTHON_VERSION) — recreating…"
    rm -rf "$VENV_DIR"
  fi
fi
if [[ ! -d "$VENV_DIR" ]]; then
  info "Creating Python $PYTHON_VERSION virtual environment…"
  "$PYTHON" -m venv "$VENV_DIR"
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
info "Downloading pretrained models from Hugging Face (~4.35 GB)…"
info "(This may take several minutes depending on your connection.)"

command -v curl >/dev/null 2>&1 || err "curl not found. Install curl first."
command -v unzip >/dev/null 2>&1 || err "unzip not found. Install unzip first."

PRETRAINED_MODELS_URLS=(
  "https://huggingface.co/XXXXRT/GPT-SoVITS-Pretrained/resolve/main/pretrained_models.zip"
  "https://www.modelscope.cn/models/XXXXRT/GPT-SoVITS-Pretrained/resolve/master/pretrained_models.zip"
)
G2PW_MODEL_URLS=(
  "https://huggingface.co/XXXXRT/GPT-SoVITS-Pretrained/resolve/main/G2PWModel.zip"
  "https://www.modelscope.cn/models/XXXXRT/GPT-SoVITS-Pretrained/resolve/master/G2PWModel.zip"
)
PRETRAINED_ZIP_PATH="$INSTALL_DIR/pretrained_models.zip"
G2PW_ZIP_PATH="$INSTALL_DIR/G2PWModel.zip"

mkdir -p "$INSTALL_DIR/GPT_SoVITS/pretrained_models"

download_first_available() {
  local out_path="$1"
  shift
  local urls=("$@")

  for url in "${urls[@]}"; do
    info "Attempting download: $url"
    if curl -L --fail --retry 5 --retry-delay 3 "$url" -o "$out_path"; then
      ok "Downloaded from: $url"
      return 0
    fi
    info "Download failed at: $url"
  done

  return 1
}

if [[ ! -f "$INSTALL_DIR/GPT_SoVITS/pretrained_models/gsv-v2final-pretrained/s1bert25hz-5kh-longer-epoch=12-step=369668.ckpt" ]] || [[ ! -f "$INSTALL_DIR/GPT_SoVITS/pretrained_models/gsv-v2final-pretrained/s2G2333k.pth" ]]; then
  info "Downloading pretrained_models.zip…"
  download_first_available "$PRETRAINED_ZIP_PATH" "${PRETRAINED_MODELS_URLS[@]}" || err "Failed to download pretrained_models.zip from all known sources."
  info "Extracting pretrained_models.zip…"
  unzip -q -o "$PRETRAINED_ZIP_PATH" -d "$INSTALL_DIR/GPT_SoVITS"
  rm -f "$PRETRAINED_ZIP_PATH"
else
  info "Core pretrained model files already present — skipping zip download."
fi

if [[ ! -d "$INSTALL_DIR/GPT_SoVITS/text/G2PWModel" ]]; then
  info "Downloading G2PWModel.zip…"
  download_first_available "$G2PW_ZIP_PATH" "${G2PW_MODEL_URLS[@]}" || err "Failed to download G2PWModel.zip from all known sources."
  info "Extracting G2PWModel.zip…"
  unzip -q -o "$G2PW_ZIP_PATH" -d "$INSTALL_DIR/GPT_SoVITS/text"
  rm -f "$G2PW_ZIP_PATH"
else
  info "G2PWModel already present — skipping."
fi

[[ -f "$INSTALL_DIR/GPT_SoVITS/pretrained_models/gsv-v2final-pretrained/s1bert25hz-5kh-longer-epoch=12-step=369668.ckpt" ]] || err "Missing GPT-SoVITS checkpoint after download."
[[ -f "$INSTALL_DIR/GPT_SoVITS/pretrained_models/gsv-v2final-pretrained/s2G2333k.pth" ]] || err "Missing SoVITS checkpoint after download."
ok "Pretrained models ready"

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
  -a ${SOVITS_HOST} \
  -p ${SOVITS_PORT}
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
