#!/usr/bin/env bash
# ─────────────────────────────────────────────────────────────
# LTX Worker — Standalone Setup Script
# Issue #327: Remote Video Generation (LTX-2 on Apple Silicon)
#
# Copy this script to your Mac with an M-series chip and run it.
# It sets up a lightweight Python video generation worker with NO
# dependency on Node.js, Docker, or OpenZigs core.
#
# Usage:
#   chmod +x setup-ltx-node.sh
#   ./setup-ltx-node.sh
#
# After setup:
#   cd ~/ltx-worker
#   source .venv/bin/activate
#   python server.py
# ─────────────────────────────────────────────────────────────
set -euo pipefail

INSTALL_DIR="${LTX_INSTALL_DIR:-$HOME/ltx-worker}"
PYTHON="${LTX_PYTHON:-python3}"
REPO_RAW="https://raw.githubusercontent.com/openzigs/openzigs/main"

# Resolve local sidecar directory relative to this script
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
LOCAL_SIDECAR_DIR="$SCRIPT_DIR/../sidecars/worker"

# ── Colors ────────────────────────────────────────────────────
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
CYAN='\033[0;36m'
NC='\033[0m'

info()  { echo -e "${CYAN}[LTX]${NC} $*"; }
ok()    { echo -e "${GREEN}[LTX]${NC} $*"; }
warn()  { echo -e "${YELLOW}[LTX]${NC} $*"; }
fail()  { echo -e "${RED}[LTX]${NC} $*" >&2; exit 1; }

# Copy a file from local repo if available, otherwise download from GitHub
fetch_file() {
  local filename="$1"
  local dest="$2"
  local local_path="$LOCAL_SIDECAR_DIR/$filename"
  if [[ -f "$local_path" ]]; then
    cp "$local_path" "$dest"
    info "Copied $filename from local repo"
  else
    curl -fsSL "$REPO_RAW/sidecars/worker/$filename" -o "$dest"
    info "Downloaded $filename from GitHub"
  fi
}

# Fix Homebrew directory ownership
ensure_brew_writable() {
  command -v brew >/dev/null 2>&1 || return 1
  local brew_prefix
  brew_prefix="$(brew --prefix 2>/dev/null)" || return 1
  [[ -w "$brew_prefix" ]] && return 0
  warn "Homebrew directory is not writable — fixing permissions (sudo may be required)."
  sudo chown -R "$(whoami)" "$brew_prefix" || fail "Could not fix Homebrew permissions."
  for d in "$brew_prefix/share/zsh" "$brew_prefix/share/zsh/site-functions" "$brew_prefix/var/homebrew/locks"; do
    [[ -d "$d" ]] && sudo chown -R "$(whoami)" "$d" 2>/dev/null || true
  done
  chmod u+w "$brew_prefix" 2>/dev/null || true
  ok "Homebrew permissions fixed"
}

brew_ensure() {
  local pkg="$1"
  local check_cmd="${2:-$1}"
  command -v brew >/dev/null 2>&1 || return 1
  if command -v "$check_cmd" >/dev/null 2>&1; then
    ok "$pkg already available"
    return 0
  fi
  ensure_brew_writable
  info "Installing $pkg via Homebrew..."
  brew install "$pkg"
  ok "$pkg installed"
}

select_python() {
  if [[ -n "${LTX_PYTHON:-}" ]]; then
    command -v "$LTX_PYTHON" >/dev/null 2>&1 || fail "LTX_PYTHON='$LTX_PYTHON' not found."
    echo "$LTX_PYTHON"; return
  fi
  for candidate in python3.12 python3.13 python3.11 python3.10; do
    if command -v "$candidate" >/dev/null 2>&1; then
      echo "$candidate"; return
    fi
  done
  if command -v python3 >/dev/null 2>&1; then
    local major minor
    major=$(python3 -c 'import sys; print(sys.version_info.major)')
    minor=$(python3 -c 'import sys; print(sys.version_info.minor)')
    if [[ "$major" -eq 3 && "$minor" -ge 10 ]]; then
      echo "python3"; return
    fi
  fi
  if command -v brew >/dev/null 2>&1; then
    ensure_brew_writable
    info "No Python 3.10+ found — installing python@3.12 via Homebrew..."
    brew install python@3.12
    echo "python3.12"
  else
    fail "Python 3.10+ is required.\nInstall Homebrew (https://brew.sh), then run: brew install python@3.12"
  fi
}

# ── Preflight Checks ─────────────────────────────────────────
info "Checking prerequisites..."

if ! xcode-select -p >/dev/null 2>&1; then
  info "Xcode Command Line Tools not found — installing..."
  xcode-select --install 2>/dev/null || true
  until xcode-select -p >/dev/null 2>&1; do
    sleep 10
    info "Waiting for Xcode Command Line Tools..."
  done
  ok "Xcode Command Line Tools installed"
fi

if ! command -v brew >/dev/null 2>&1; then
  info "Homebrew not found — installing..."
  /bin/bash -c "$(curl -fsSL https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh)"
  eval "$(/opt/homebrew/bin/brew shellenv 2>/dev/null || /usr/local/bin/brew shellenv 2>/dev/null)"
  ok "Homebrew installed"
fi

PYTHON="$(select_python)"
ok "Using Python interpreter: $PYTHON ($(${PYTHON} --version 2>&1))"

PY_MAJOR=$("$PYTHON" -c 'import sys; print(sys.version_info.major)')
PY_MINOR=$("$PYTHON" -c 'import sys; print(sys.version_info.minor)')

if [[ "$PY_MAJOR" -lt 3 ]] || [[ "$PY_MAJOR" -eq 3 && "$PY_MINOR" -lt 10 ]]; then
  fail "Python 3.10+ required, found $("$PYTHON" --version 2>&1)"
fi

brew_ensure cmake cmake
brew_ensure ffmpeg ffmpeg

ARCH=$(uname -m)
if [[ "$ARCH" == "arm64" ]]; then
  ok "Apple Silicon detected — Metal/MLX will be used for inference"
else
  warn "x86 architecture detected — LTX-2 requires Apple Silicon (MLX)"
fi

# ── Create Install Directory ─────────────────────────────────
info "Setting up LTX worker at: $INSTALL_DIR"
mkdir -p "$INSTALL_DIR"
cd "$INSTALL_DIR"

# ── Create Virtual Environment ────────────────────────────────
if [[ -d ".venv" ]]; then
  VENV_PY_VER=$(.venv/bin/python --version 2>&1 | grep -oE '[0-9]+\.[0-9]+\.[0-9]+' | head -1)
  WANT_PY_VER=$("$PYTHON" -c 'import sys; print("{}.{}.{}".format(*sys.version_info[:3]))')
  if [[ "$VENV_PY_VER" != "$WANT_PY_VER" ]]; then
    warn "Existing venv uses Python $VENV_PY_VER but selected is $WANT_PY_VER — recreating..."
    rm -rf .venv
  else
    ok "Virtual environment already exists (Python $VENV_PY_VER)"
  fi
fi
if [[ ! -d ".venv" ]]; then
  info "Creating Python virtual environment with $PYTHON..."
  "$PYTHON" -m venv .venv
  ok "Virtual environment created"
fi

source .venv/bin/activate

# ── Install Dependencies ──────────────────────────────────────
fetch_file "requirements.txt" "requirements.txt"

info "Installing Python dependencies (this may take several minutes on first run)..."
pip install --upgrade pip wheel setuptools -q
pip install --prefer-binary -r requirements.txt

ok "Dependencies installed"

# ── Download Server ───────────────────────────────────────────
fetch_file "server.py" "server.py"
ok "Server ready"

# ── Download launchd Plist Template ───────────────────────────
fetch_file "com.openzigs.ltx-worker.plist" "com.openzigs.ltx-worker.plist"

sed -i '' "s|__LTX_DIR__|$INSTALL_DIR|g" com.openzigs.ltx-worker.plist

ok "launchd plist template prepared"

cp com.openzigs.ltx-worker.plist "$HOME/Library/LaunchAgents/com.openzigs.ltx-worker.plist"
ok "Plist copied to ~/Library/LaunchAgents/"

if [[ "${LTX_INSTALL_SERVICE:-}" == "1" ]]; then
  info "Loading launchd agent now (LTX_INSTALL_SERVICE=1)..."
  launchctl unload "$HOME/Library/LaunchAgents/com.openzigs.ltx-worker.plist" 2>/dev/null || true
  launchctl load "$HOME/Library/LaunchAgents/com.openzigs.ltx-worker.plist"
  ok "Launchd service loaded — will auto-start on boot"
fi

# ── Generate Secret Token ─────────────────────────────────────
TOKEN_FILE="$INSTALL_DIR/.ltx-token"
if [[ ! -f "$TOKEN_FILE" ]]; then
  TOKEN=$(openssl rand -hex 32)
  echo "$TOKEN" > "$TOKEN_FILE"
  chmod 600 "$TOKEN_FILE"
  ok "Generated secret token → $TOKEN_FILE"
else
  TOKEN=$(cat "$TOKEN_FILE")
  ok "Using existing secret token from $TOKEN_FILE"
fi

# ── Create .env File ──────────────────────────────────────────
ENV_FILE="$INSTALL_DIR/.env"
if [[ ! -f "$ENV_FILE" ]]; then
  cat > "$ENV_FILE" << EOF
# LTX Worker Environment
LTX_SECRET_TOKEN=$TOKEN
M2_PRO_HOST=0.0.0.0
M2_PRO_PORT=5007
LTX_MODEL_REPO=AITRADER/ltx2-distilled-4bit-mlx

# Audio generation (disabled by default — requires ~87 GB download on first use)
# Uncomment to enable synchronized audio in generated videos, then restart the worker.
# LTX_ALLOW_AUDIO=1
EOF
  chmod 600 "$ENV_FILE"
  ok "Created .env file"
fi

# ── Create start.sh Convenience Script ────────────────────────
cat > "$INSTALL_DIR/start.sh" << 'STARTEOF'
#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")"

if [[ -f .env ]]; then
  set -a
  source .env
  set +a
fi

source .venv/bin/activate
exec python server.py
STARTEOF
chmod +x "$INSTALL_DIR/start.sh"

# ── Print Summary ─────────────────────────────────────────────
LOCAL_IP=$(ipconfig getifaddr en0 2>/dev/null || \
         ipconfig getifaddr en1 2>/dev/null || \
         ipconfig getifaddr en2 2>/dev/null || \
         echo "<your-local-ip>")

echo ""
echo -e "${GREEN}╔═══════════════════════════════════════════════════════════╗${NC}"
echo -e "${GREEN}║       LTX Worker Setup Complete!                         ║${NC}"
echo -e "${GREEN}╚═══════════════════════════════════════════════════════════╝${NC}"
echo ""
echo -e "  Install directory:  ${CYAN}$INSTALL_DIR${NC}"
echo -e "  Secret token:       ${CYAN}$(cat "$TOKEN_FILE")${NC}"
echo -e "  This Mac's IP:      ${CYAN}$LOCAL_IP${NC}"
echo ""
echo -e "  ${YELLOW}Start the worker:${NC}"
echo -e "    cd $INSTALL_DIR && ./start.sh"
echo ""
echo -e "  ${YELLOW}Or use the unified control script:${NC}"
echo -e "    ./scripts/media-ctl.sh ltx start"
echo -e "    ./scripts/media-ctl.sh ltx status"
echo -e "    ./scripts/media-ctl.sh switch ltx     # unload flux, prep for video"
echo ""
echo -e "  ${YELLOW}Configure in OpenZigs Admin UI:${NC}"
echo -e "    Mode:   Network Node"
echo -e "    URL:    http://$LOCAL_IP:5007"
echo -e "    Token:  $(cat "$TOKEN_FILE")"
echo ""
echo -e "  ${YELLOW}macOS Firewall:${NC}"
echo -e "    System Settings → Network → Firewall → Options"
echo -e "    Allow incoming connections for Python or port 5007"
echo ""
echo -e "  ${YELLOW}Note:${NC} Both FluxQ (port 5005) and LTX (port 5007) share VRAM."
echo -e "        Only one model can be loaded at a time."
echo -e "        Use: ./scripts/media-ctl.sh switch <flux|ltx>"
echo ""
