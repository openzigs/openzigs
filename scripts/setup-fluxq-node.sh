#!/usr/bin/env bash
# ─────────────────────────────────────────────────────────────
# FluxQ Node — Standalone Setup Script
# Issue #290: Remote Image Generation (FluxQ Local Network Node)
#
# Copy this script to a second Mac on your local network and run it.
# It sets up a lightweight Python image generation worker with NO
# dependency on Node.js, Docker, or OpenZigs core.
#
# Usage:
#   chmod +x setup-fluxq-node.sh
#   ./setup-fluxq-node.sh
#
# After setup:
#   cd ~/fluxq-node
#   source .venv/bin/activate
#   FLUXQ_SECRET_TOKEN=your-secret python server.py --host 0.0.0.0
# ─────────────────────────────────────────────────────────────
set -euo pipefail

INSTALL_DIR="${FLUXQ_INSTALL_DIR:-$HOME/fluxq-node}"
PYTHON="${FLUXQ_PYTHON:-python3}"
REPO_RAW="https://raw.githubusercontent.com/mgcronin/openzigs/main"

# Resolve local sidecar directory relative to this script (works when run from within the repo)
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
LOCAL_SIDECAR_DIR="$SCRIPT_DIR/../sidecars/image-gen"

# ── Colors ────────────────────────────────────────────────────
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
CYAN='\033[0;36m'
NC='\033[0m' # No Color

info()  { echo -e "${CYAN}[FluxQ]${NC} $*"; }
ok()    { echo -e "${GREEN}[FluxQ]${NC} $*"; }
warn()  { echo -e "${YELLOW}[FluxQ]${NC} $*"; }
fail()  { echo -e "${RED}[FluxQ]${NC} $*" >&2; exit 1; }

# Copy a file from local repo if available, otherwise download from GitHub
fetch_file() {
  local filename="$1"
  local dest="$2"
  local local_path="$LOCAL_SIDECAR_DIR/$filename"
  if [[ -f "$local_path" ]]; then
    cp "$local_path" "$dest"
    info "Copied $filename from local repo"
  else
    curl -fsSL "$REPO_RAW/sidecars/image-gen/$filename" -o "$dest"
    info "Downloaded $filename from GitHub"
  fi
}

# ── Preflight Checks ─────────────────────────────────────────
info "Checking prerequisites..."

command -v "$PYTHON" >/dev/null 2>&1 || fail "Python 3 not found. Install it via: brew install python@3.11"

PY_VERSION=$("$PYTHON" -c 'import sys; print(f"{sys.version_info.major}.{sys.version_info.minor}")')
PY_MAJOR=$("$PYTHON" -c 'import sys; print(sys.version_info.major)')
PY_MINOR=$("$PYTHON" -c 'import sys; print(sys.version_info.minor)')

if [[ "$PY_MAJOR" -lt 3 ]] || [[ "$PY_MAJOR" -eq 3 && "$PY_MINOR" -lt 10 ]]; then
  fail "Python 3.10+ required, found $PY_VERSION"
fi
ok "Python $PY_VERSION found"

# Check for Apple Silicon (MPS)
ARCH=$(uname -m)
if [[ "$ARCH" == "arm64" ]]; then
  ok "Apple Silicon detected — Metal Performance Shaders (MPS) will be used"
else
  warn "x86 architecture detected — GPU acceleration may not be available (CPU fallback)"
fi

# ── Create Install Directory ─────────────────────────────────
info "Setting up FluxQ node at: $INSTALL_DIR"
mkdir -p "$INSTALL_DIR"
cd "$INSTALL_DIR"

# ── Create Virtual Environment ────────────────────────────────
if [[ ! -d ".venv" ]]; then
  info "Creating Python virtual environment..."
  "$PYTHON" -m venv .venv
  ok "Virtual environment created"
else
  ok "Virtual environment already exists"
fi

source .venv/bin/activate

# ── Install Dependencies ──────────────────────────────────────
fetch_file "requirements.txt" "requirements.txt"

info "Installing Python dependencies (this may take several minutes on first run)..."
pip install --upgrade pip wheel setuptools -q
pip install -r requirements.txt -q

ok "Dependencies installed"

# ── Download Server ───────────────────────────────────────────
fetch_file "server.py" "server.py"
ok "Server ready"

# ── Download launchd Plist Template ───────────────────────────
fetch_file "com.openzigs.fluxq.plist" "com.openzigs.fluxq.plist"

# Substitute the current user's home directory into the plist
sed -i '' "s|__FLUXQ_DIR__|$INSTALL_DIR|g" com.openzigs.fluxq.plist
sed -i '' "s|__USER__|$(whoami)|g" com.openzigs.fluxq.plist

ok "launchd plist template downloaded"

# ── Generate Secret Token ─────────────────────────────────────
TOKEN_FILE="$INSTALL_DIR/.fluxq-token"
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
# FluxQ Node Environment
FLUXQ_SECRET_TOKEN=$TOKEN
IMAGE_GEN_HOST=0.0.0.0
IMAGE_GEN_PORT=5005
IMAGE_GEN_MODEL=sdxl-turbo
# IMAGE_GEN_IDLE_TIMEOUT=600
EOF
  chmod 600 "$ENV_FILE"
  ok "Created .env file"
fi

# ── Create start.sh Convenience Script ────────────────────────
cat > "$INSTALL_DIR/start.sh" << 'STARTEOF'
#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")"

# Load .env if present
if [[ -f .env ]]; then
  set -a
  source .env
  set +a
fi

source .venv/bin/activate
exec python server.py --host "${IMAGE_GEN_HOST:-0.0.0.0}" --port "${IMAGE_GEN_PORT:-5005}"
STARTEOF
chmod +x "$INSTALL_DIR/start.sh"

# ── Print Summary ─────────────────────────────────────────────
LOCAL_IP=$(ipconfig getifaddr en0 2>/dev/null || echo "<your-local-ip>")

echo ""
echo -e "${GREEN}╔═══════════════════════════════════════════════════════════╗${NC}"
echo -e "${GREEN}║       FluxQ Node Setup Complete!                         ║${NC}"
echo -e "${GREEN}╚═══════════════════════════════════════════════════════════╝${NC}"
echo ""
echo -e "  Install directory:  ${CYAN}$INSTALL_DIR${NC}"
echo -e "  Secret token:       ${CYAN}$(cat "$TOKEN_FILE")${NC}"
echo -e "  This Mac's IP:      ${CYAN}$LOCAL_IP${NC}"
echo ""
echo -e "  ${YELLOW}Start the worker:${NC}"
echo -e "    cd $INSTALL_DIR && ./start.sh"
echo ""
echo -e "  ${YELLOW}Or start manually:${NC}"
echo -e "    cd $INSTALL_DIR"
echo -e "    source .venv/bin/activate"
echo -e "    FLUXQ_SECRET_TOKEN=$(cat "$TOKEN_FILE") python server.py --host 0.0.0.0"
echo ""
echo -e "  ${YELLOW}Install as macOS service (auto-start on boot):${NC}"
echo -e "    cp com.openzigs.fluxq.plist ~/Library/LaunchAgents/"
echo -e "    launchctl load ~/Library/LaunchAgents/com.openzigs.fluxq.plist"
echo ""
echo -e "  ${YELLOW}Configure in OpenZigs Admin UI:${NC}"
echo -e "    Mode:   Network Node"
echo -e "    URL:    http://$LOCAL_IP:5005"
echo -e "    Token:  $(cat "$TOKEN_FILE")"
echo ""
echo -e "  ${YELLOW}macOS Firewall:${NC}"
echo -e "    System Settings → Network → Firewall → Options"
echo -e "    Allow incoming connections for Python or port 5005"
echo ""
