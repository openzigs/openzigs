#!/usr/bin/env bash
# run-e2e.sh — Start backend + UI dev servers and run the Playwright E2E suite.
# Usage: ./scripts/run-e2e.sh [playwright options]
#   e.g. ./scripts/run-e2e.sh --headed
#        ./scripts/run-e2e.sh e2e/dashboard.spec.ts
#        ./scripts/run-e2e.sh --ui

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
BACKEND_PORT=3000
UI_PORT=3101
BACKEND_PID=""
UI_PID=""

# ── Cleanup ───────────────────────────────────────────────────────────────────

cleanup() {
  echo ""
  echo "→ Shutting down servers..."
  [[ -n "$BACKEND_PID" ]] && kill "$BACKEND_PID" 2>/dev/null || true
  [[ -n "$UI_PID" ]] && kill "$UI_PID" 2>/dev/null || true
  # Kill any child processes that may have been spawned
  pkill -P "$BACKEND_PID" 2>/dev/null || true
  pkill -P "$UI_PID" 2>/dev/null || true
}
trap cleanup EXIT INT TERM

# ── Helpers ───────────────────────────────────────────────────────────────────

port_in_use() {
  lsof -nP -iTCP:"$1" -sTCP:LISTEN 2>/dev/null | grep -q .
}

wait_for_port() {
  local port=$1
  local name=$2
  local timeout=${3:-60}
  local elapsed=0

  echo -n "  Waiting for $name on :$port"
  until port_in_use "$port" || [[ $elapsed -ge $timeout ]]; do
    sleep 1
    elapsed=$((elapsed + 1))
    echo -n "."
  done

  if port_in_use "$port"; then
    echo " ready"
  else
    echo " timed out after ${timeout}s"
    echo "ERROR: $name failed to start on :$port" >&2
    if [[ -f "/tmp/openzigs-backend.log" && "$name" == "backend" ]]; then
      echo "--- last 20 lines of /tmp/openzigs-backend.log ---" >&2
      tail -20 /tmp/openzigs-backend.log >&2
    elif [[ -f "/tmp/openzigs-ui.log" && "$name" == "UI dev server" ]]; then
      echo "--- last 20 lines of /tmp/openzigs-ui.log ---" >&2
      tail -20 /tmp/openzigs-ui.log >&2
    fi
    exit 1
  fi
}

# ── Pre-flight checks ─────────────────────────────────────────────────────────

cd "$REPO_ROOT"

if port_in_use "$BACKEND_PORT"; then
  echo "→ Backend already running on :$BACKEND_PORT — skipping start"
  BACKEND_PID=""
else
  echo "→ Starting backend..."
  CHROME_AUTO_LAUNCH=false pnpm dev > /tmp/openzigs-backend.log 2>&1 &
  BACKEND_PID=$!
  wait_for_port "$BACKEND_PORT" "backend"
fi

if port_in_use "$UI_PORT"; then
  echo "→ UI dev server already running on :$UI_PORT — skipping start"
  UI_PID=""
else
  echo "→ Starting UI dev server..."
  cd "$REPO_ROOT/ui"
  pnpm dev > /tmp/openzigs-ui.log 2>&1 &
  UI_PID=$!
  wait_for_port "$UI_PORT" "UI dev server" 120
  cd "$REPO_ROOT"
fi

# ── Install Playwright browser if missing ─────────────────────────────────────

cd "$REPO_ROOT/ui"
if ! npx playwright install --dry-run chromium 2>&1 | grep -q "chromium.*is already installed"; then
  echo "→ Installing Playwright Chromium browser..."
  npx playwright install chromium
fi

# ── Run the tests ─────────────────────────────────────────────────────────────

echo ""
echo "→ Running E2E tests..."
echo ""

# Pass any extra args straight through to playwright (e.g. --headed, a spec file, --ui)
npx playwright test "$@"
