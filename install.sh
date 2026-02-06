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

docker compose build

echo "OpenZigs installed."
echo "Next steps:"
echo "  1. Edit $install_dir/.env with your tokens"
echo "  2. Run: cd $install_dir && docker compose up"
echo "  3. Optional setup wizard: pnpm install && pnpm build && openzigs setup"
