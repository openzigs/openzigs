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

install_dir="$HOME/.openzigs"

if [ -d "$install_dir" ]; then
  echo "Install directory already exists at $install_dir"
  exit 1
fi

echo "Installing OpenZigs..."

git clone https://github.com/mgcronin/openzigs.git "$install_dir"
cd "$install_dir"

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
