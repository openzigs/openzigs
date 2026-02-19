#!/bin/bash
set -e

if ! command -v docker >/dev/null 2>&1; then
  echo "Docker is required. Install from https://docker.com"
  exit 1
fi

if ! docker compose version >/dev/null 2>&1; then
  echo "Docker Compose v2 is required. Install Docker Desktop or the compose plugin."
  exit 1
fi

if ! command -v git >/dev/null 2>&1; then
  echo "git is required to clone the repository."
  exit 1
fi

# ── Optional converter prerequisites (host/local runtime) ───────────────────
install_converter_deps_with_brew() {
  echo ""
  echo "=== Optional Knowledge Converter Dependencies ==="
  echo "These are required when running OpenZigs directly on your host (pnpm dev):"
  echo "  - ffmpeg (media/audio extraction)"
  echo "  - imagemagick + ghostscript (scanned PDF OCR rendering)"
  echo ""

  local missing=0
  command -v ffmpeg >/dev/null 2>&1 || missing=1
  command -v magick >/dev/null 2>&1 || missing=1
  command -v gs >/dev/null 2>&1 || missing=1

  if [ "$missing" -eq 0 ]; then
    echo "Converter host dependencies already installed."
    return
  fi

  if command -v brew >/dev/null 2>&1; then
    printf "Install missing converter dependencies now with Homebrew? [Y/n]: "
    read -r install_now
    if [ -z "$install_now" ] || [ "$install_now" = "y" ] || [ "$install_now" = "Y" ]; then
      brew install ffmpeg imagemagick ghostscript || true
    else
      echo "Skipping converter dependency install."
    fi
  else
    echo "Homebrew not found. Install manually for local converter support:"
    echo "  - ffmpeg"
    echo "  - imagemagick"
    echo "  - ghostscript"
  fi
}

install_converter_deps_with_brew

# ── Optional GPT-SoVITS runtime dependencies ────────────────────────────────
install_gptsovits_deps() {
  local SOVITS_DIR="$HOME/.openzigs/sidecars/gptsovits"
  local SOVITS_VENV="$SOVITS_DIR/.venv"

  if [ ! -d "$SOVITS_VENV" ]; then
    return  # GPT-SoVITS not installed yet — skip
  fi

  echo ""
  echo "=== GPT-SoVITS Runtime Dependencies ==="
  echo "Ensuring torchcodec and NLTK data are installed in the GPT-SoVITS venv."
  echo ""

  local SOVITS_PY="$SOVITS_VENV/bin/python"
  if [ -x "$SOVITS_PY" ]; then
    # Install torchcodec (required for audio decoding)
    "$SOVITS_PY" -m pip install --quiet torchcodec 2>/dev/null || true

    # Download NLTK averaged_perceptron_tagger_eng data (required for English text processing)
    "$SOVITS_PY" -c "import nltk; nltk.download('averaged_perceptron_tagger_eng', quiet=True)" 2>/dev/null || true

    echo "  ✓ GPT-SoVITS runtime dependencies installed"
  else
    echo "  ⚠ GPT-SoVITS venv Python not found at $SOVITS_PY — skipping"
  fi
}

install_gptsovits_deps

install_dir="$HOME/.openzigs"

if [ -d "$install_dir" ]; then
  echo "Install directory already exists at $install_dir"
  exit 1
fi

echo "Installing OpenZigs..."

git clone --recurse-submodules https://github.com/mgcronin/openzigs.git "$install_dir"
cd "$install_dir"

# Ensure submodules are initialized (Instagram MCP server)
git submodule update --init

if [ -f .env.example ]; then
  cp .env.example .env
fi

# ── Interactive credential setup ──────────────────────────────────────────────
echo ""
echo "=== MCP Sidecar Credentials ==="
echo "OpenZigs can automatically provision social media and productivity MCP servers."
echo "Enter your API credentials below, or press Enter to skip."
echo ""

read_credential() {
  local prompt="$1"
  local var_name="$2"
  printf "  %s: " "$prompt"
  read -r value
  if [ -n "$value" ]; then
    # Append to .env, replacing existing if present
    if grep -q "^${var_name}=" .env 2>/dev/null; then
      sed -i.bak "s|^${var_name}=.*|${var_name}=${value}|" .env && rm -f .env.bak
    else
      echo "${var_name}=${value}" >> .env
    fi
    echo "    ✓ ${var_name} saved"
  fi
}

echo "LinkedIn:"
read_credential "Access Token" "LINKEDIN_ACCESS_TOKEN"

echo ""
echo "Twitter/X:"
read_credential "Bearer Token" "TWITTER_BEARER_TOKEN"
read_credential "API Key" "TWITTER_API_KEY"
read_credential "API Secret" "TWITTER_API_SECRET"

echo ""
echo "Facebook:"
read_credential "Page Token" "FACEBOOK_PAGE_TOKEN"

echo ""
echo "Pinterest:"
read_credential "App ID" "PINTEREST_APP_ID"
read_credential "App Secret" "PINTEREST_APP_SECRET"

echo ""
echo "Brave Search (for web search tool):"
read_credential "API Key" "BRAVE_API_KEY"

# ── Build and start ──────────────────────────────────────────────────────────
echo ""
echo "Building Docker images..."
docker compose build

echo ""
echo "Starting OpenZigs (MCP sidecars auto-provisioned based on your credentials)..."
docker compose up -d

# Wait briefly for health check
echo "Waiting for services to start..."
sleep 5

# Show status
echo ""
echo "=== Service Status ==="
docker compose ps --format "table {{.Name}}\t{{.Status}}\t{{.Ports}}"

echo ""
echo "✓ OpenZigs installed and running!"
echo ""
echo "Web UI:       http://localhost:3000"
echo "Admin panel:  http://localhost:3000/admin"
echo ""
echo "Useful commands:"
echo "  cd $install_dir"
echo "  docker compose logs -f       # View logs"
echo "  docker compose restart       # Restart all services"
echo "  docker compose down          # Stop all services"
echo "  vim .env                     # Update API credentials"
echo ""
echo "MCP sidecars are automatically managed — just add credentials to .env and restart."
echo ""
echo "Knowledge converter notes:"
echo "  - Excel (.xlsx/.xls), PDF, and DOCX conversion are bundled."
echo "  - Media transcription requires whisper model download for local dev:"
echo "      pnpm exec whisper-node download"
echo ""
echo "Voice cloning (GPT-SoVITS Engine B):"
echo "  - Install with: bash scripts/setup-gptsovits.sh"
echo "  - After install, runtime deps are auto-provisioned on next install.sh run."
echo "  - Start manually: ~/.openzigs/sidecars/gptsovits/start.sh"
echo "  - Or use: bash scripts/dev-clean.sh (auto-starts all sidecars)"
