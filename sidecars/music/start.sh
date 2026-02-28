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
exec python server.py --host "${MUSIC_GEN_HOST:-0.0.0.0}" --port "${MUSIC_GEN_PORT:-5009}"
