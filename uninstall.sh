#!/bin/bash
set -e

install_dir="$HOME/.openzigs"

if [ ! -d "$install_dir" ]; then
  echo "OpenZigs is not installed in $install_dir"
  exit 0
fi

cd "$install_dir"

docker compose down -v
cd "$HOME"
rm -rf "$install_dir"

echo "OpenZigs uninstalled."
