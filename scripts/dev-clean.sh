#!/bin/bash
set -e

# Resolve the directory of the script
DIR="$( cd "$( dirname "${BASH_SOURCE[0]}" )" && pwd )"
PROJECT_ROOT="$(dirname "$DIR")"

echo "[clean-start] Killing existing OpenZigs processes..."

# Kill Node processes (tsx or node running server.ts/js inside openzigs) where name involves server
# Using -f to match full argument list
pkill -f "node.*src/server.ts" || true
pkill -f "tsx.*src/server.ts" || true
pkill -f "node.*dist/server.js" || true

# Kill processes on port 3000 (default port)
PID=$(lsof -ti:3000 2>/dev/null || true)
if [ -n "$PID" ]; then
  echo "[clean-start] Killing process on port 3000 (PID $PID)"
  kill -9 $PID || true
fi

# Kill zombie Chrome instances associated with OpenZigs
# This matches the profile path used in chrome-launcher.ts
pkill -f "openzigs-chrome-profile" || true

echo "[clean-start] Starting OpenZigs in dev mode..."
cd "$PROJECT_ROOT"
npm run dev
