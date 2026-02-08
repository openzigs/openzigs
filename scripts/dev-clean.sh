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
pkill -f "next.*dev" || true
pkill -f "pnpm.*dev" || true

# Kill processes on port 3000 (default port)
PID=$(lsof -ti:3000 2>/dev/null || true)
if [ -n "$PID" ]; then
  echo "[clean-start] Killing process on port 3000 (PID $PID)"
  kill -9 $PID || true
fi

# Kill processes on port 3001 (Next.js dev server default)
PID=$(lsof -ti:3001 2>/dev/null || true)
if [ -n "$PID" ]; then
  echo "[clean-start] Killing process on port 3001 (PID $PID)"
  kill -9 $PID || true
fi

# Kill zombie Chrome instances associated with OpenZigs
# This matches the profile path used in chrome-launcher.ts
pkill -f "openzigs-chrome-profile" || true

echo "[clean-start] Starting OpenZigs in dev mode (backend + UI)..."

# Auto-populate UI .env.local with auth token from ~/.openzigs/config.json
CONFIG_FILE="$HOME/.openzigs/config.json"
UI_ENV="$PROJECT_ROOT/ui/.env.local"
if [ -f "$CONFIG_FILE" ]; then
  TOKEN=$(python3 -c "import json; print(json.load(open('$CONFIG_FILE'))['auth']['token'])" 2>/dev/null || true)
  if [ -n "$TOKEN" ]; then
    echo "NEXT_PUBLIC_OPENZIGS_API_BASE=http://localhost:3000" > "$UI_ENV"
    echo "NEXT_PUBLIC_OPENZIGS_TOKEN=$TOKEN" >> "$UI_ENV"
    echo "[clean-start] Wrote auth token to ui/.env.local"
  fi
fi

cd "$PROJECT_ROOT"
DEV_LOG="$PROJECT_ROOT/.openzigs-dev.log"
pnpm dev > "$DEV_LOG" 2>&1 &
BACKEND_PID=$!

echo "[clean-start] Backend logs: $DEV_LOG"
tail -f "$DEV_LOG" &
TAIL_PID=$!

cleanup() {
  echo "[clean-start] Stopping OpenZigs dev servers..."
  kill -9 "$BACKEND_PID" 2>/dev/null || true
  if [ -n "${TAIL_PID:-}" ]; then
    kill -9 "$TAIL_PID" 2>/dev/null || true
  fi
  pkill -f "next.*dev" || true
}

trap cleanup EXIT

echo "[clean-start] Waiting for backend on port 3000..."
for _ in {1..30}; do
  if lsof -ti:3000 >/dev/null 2>&1; then
    break
  fi
  sleep 1
done

cd "$PROJECT_ROOT/ui"
PORT=3001 pnpm dev
