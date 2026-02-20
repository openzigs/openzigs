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

# Fix Homebrew directory ownership when it is not writable by the current user.
# This is a common state on shared or migrated Macs.
ensure_brew_writable() {
  command -v brew >/dev/null 2>&1 || return 1
  local brew_prefix
  brew_prefix="$(brew --prefix 2>/dev/null)" || return 1
  [[ -w "$brew_prefix" ]] && return 0   # already writable — nothing to do

  warn "Homebrew directory is not writable by your user — fixing permissions now."
  warn "(sudo password may be required)"
  sudo chown -R "$(whoami)" "$brew_prefix" || fail "Could not fix Homebrew permissions. Run manually:\n  sudo chown -R $(whoami) $brew_prefix"
  # Fix common locked subdirectories
  for d in "$brew_prefix/share/zsh" "$brew_prefix/share/zsh/site-functions" "$brew_prefix/var/homebrew/locks"; do
    [[ -d "$d" ]] && sudo chown -R "$(whoami)" "$d" 2>/dev/null || true
  done
  chmod u+w "$brew_prefix" 2>/dev/null || true
  ok "Homebrew permissions fixed"
}

# Install a Homebrew formula if it is not already present, fixing permissions first.
brew_ensure() {
  local pkg="$1"
  local check_cmd="${2:-$1}"   # optional: command to probe instead of the package name
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

# Return the path of the best available Python interpreter (3.10–3.12 preferred).
# If only 3.13+ is found, installs python@3.12 via Homebrew automatically.
select_python() {
  # Honour explicit override
  if [[ -n "${FLUXQ_PYTHON:-}" ]]; then
    command -v "$FLUXQ_PYTHON" >/dev/null 2>&1 || fail "FLUXQ_PYTHON='$FLUXQ_PYTHON' not found."
    echo "$FLUXQ_PYTHON"; return
  fi

  # Check candidates in preference order
  for candidate in python3.12 python3.11 python3.10; do
    if command -v "$candidate" >/dev/null 2>&1; then
      echo "$candidate"; return
    fi
  done

  # Check if the system python3 is in a good range (3.10–3.12)
  if command -v python3 >/dev/null 2>&1; then
    local major minor
    major=$(python3 -c 'import sys; print(sys.version_info.major)')
    minor=$(python3 -c 'import sys; print(sys.version_info.minor)')
    if [[ "$major" -eq 3 && "$minor" -ge 10 && "$minor" -le 12 ]]; then
      echo "python3"; return
    fi
  fi

  # Nothing suitable — install python@3.12 via Homebrew
  if command -v brew >/dev/null 2>&1; then
    ensure_brew_writable
    info "No Python 3.10–3.12 found — installing python@3.12 via Homebrew..."
    brew install python@3.12
    ok "python@3.12 installed"
    echo "python3.12"
  else
    fail "Python 3.10–3.12 is required.\nInstall Homebrew (https://brew.sh), then run: brew install python@3.12"
  fi
}

# ── Preflight Checks ─────────────────────────────────────────
info "Checking prerequisites..."

# Ensure Xcode command-line tools are present (needed for any compilation)
if ! xcode-select -p >/dev/null 2>&1; then
  info "Xcode Command Line Tools not found — installing (a dialog may appear)..."
  xcode-select --install 2>/dev/null || true
  # Wait for CLT install to complete (up to 5 min)
  until xcode-select -p >/dev/null 2>&1; do
    sleep 10
    info "Waiting for Xcode Command Line Tools installation to complete..."
  done
  ok "Xcode Command Line Tools installed"
fi

# Ensure Homebrew is installed
if ! command -v brew >/dev/null 2>&1; then
  info "Homebrew not found — installing..."
  /bin/bash -c "$(curl -fsSL https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh)"
  # Add brew to PATH for the remainder of this script
  eval "$(/opt/homebrew/bin/brew shellenv 2>/dev/null || /usr/local/bin/brew shellenv 2>/dev/null)"
  ok "Homebrew installed"
fi

# Select Python interpreter (auto-installs python@3.12 if only 3.13+ is available)
PYTHON="$(select_python)"
ok "Using Python interpreter: $PYTHON ($(${PYTHON} --version 2>&1))"

PY_MAJOR=$("$PYTHON" -c 'import sys; print(sys.version_info.major)')
PY_MINOR=$("$PYTHON" -c 'import sys; print(sys.version_info.minor)')

if [[ "$PY_MAJOR" -lt 3 ]] || [[ "$PY_MAJOR" -eq 3 && "$PY_MINOR" -lt 10 ]]; then
  fail "Python 3.10+ required, found $("$PYTHON" --version 2>&1)"
fi

# Ensure build tools needed to compile Python extensions from source
brew_ensure cmake cmake
brew_ensure pkg-config pkg-config

# Install sentencepiece system library if available (avoids building from source entirely)
brew_ensure sentencepiece sentencepiece_trainer 2>/dev/null || true

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
# If a venv exists but was built with a different Python (e.g., a previous
# failed run used Python 3.14 and we now want 3.12), delete and recreate it.
if [[ -d ".venv" ]]; then
  VENV_PY_VER=$(.venv/bin/python --version 2>&1 | grep -oE '[0-9]+\.[0-9]+\.[0-9]+' | head -1)
  WANT_PY_VER=$("$PYTHON" -c 'import sys; print("{}.{}.{}".format(*sys.version_info[:3]))')
  if [[ "$VENV_PY_VER" != "$WANT_PY_VER" ]]; then
    warn "Existing venv uses Python $VENV_PY_VER but selected interpreter is $WANT_PY_VER — recreating..."
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
# --prefer-binary: use pre-built wheels whenever available (avoids source compilation for packages
# like sentencepiece that don't yet have wheels for newer Python versions).
#
# CMAKE_POLICY_VERSION_MINIMUM=3.5: CMake 4.x dropped support for cmake_minimum_required < 3.5.
# This env var tells CMake 4 to allow old CMakeLists.txt files (like sentencepiece 0.2.0) to
# configure without failing. Inherited by any cmake subprocess spawned during the pip build.
CMAKE_POLICY_VERSION_MINIMUM=3.5 pip install --prefer-binary -r requirements.txt

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
# Try common macOS interface names until one returns a non-empty result. Wi‑Fi is usually en0,
# ethernet en1 (or en2 on some models). If none are active fall back to a placeholder.
LOCAL_IP=$(ipconfig getifaddr en0 2>/dev/null || \
         ipconfig getifaddr en1 2>/dev/null || \
         ipconfig getifaddr en2 2>/dev/null || \
         echo "<your-local-ip>")

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
