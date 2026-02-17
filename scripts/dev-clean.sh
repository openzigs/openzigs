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
pkill -f "sidecars/image-gen/server.py" || true
pkill -f "sidecars/audio/server.py" || true

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

# Kill processes on port 5005 (image-gen sidecar)
PID=$(lsof -ti:5005 2>/dev/null || true)
if [ -n "$PID" ]; then
  echo "[clean-start] Killing process on port 5005 (PID $PID)"
  kill -9 $PID || true
fi

# Kill processes on port 5006 (audio sidecar)
PID=$(lsof -ti:5006 2>/dev/null || true)
if [ -n "$PID" ]; then
  echo "[clean-start] Killing process on port 5006 (PID $PID)"
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

# Optional: start local image-gen sidecar (default enabled)
# The sidecar starts in lazy mode — no model loaded until first /generate request.
# This makes startup instant (~1s) and costs no GPU RAM until actually used.
SIDECAR_PID=""
if [ "${OPENZIGS_START_SIDECAR:-1}" != "0" ]; then
  SIDECAR_DIR="$PROJECT_ROOT/sidecars/image-gen"
  SIDECAR_LOG="$PROJECT_ROOT/.openzigs-image-sidecar.log"
  SIDECAR_MODEL="${OPENZIGS_IMAGE_MODEL:-sdxl-turbo}"
  SIDECAR_IDLE_TIMEOUT="${OPENZIGS_SIDECAR_IDLE_TIMEOUT:-300}"

  if [ -x "$SIDECAR_DIR/.venv/bin/python" ]; then
    SIDECAR_PY="$SIDECAR_DIR/.venv/bin/python"
  elif command -v python3.12 >/dev/null 2>&1; then
    SIDECAR_PY="python3.12"
  else
    SIDECAR_PY="python3"
  fi

  if [ -f "$SIDECAR_DIR/server.py" ]; then
    echo "[clean-start] Starting image-gen sidecar (lazy mode, default-model=$SIDECAR_MODEL, idle-timeout=${SIDECAR_IDLE_TIMEOUT}s, port=5005)"
    (
      cd "$SIDECAR_DIR"
      "$SIDECAR_PY" server.py --port 5005 --default-model "$SIDECAR_MODEL" --idle-timeout "$SIDECAR_IDLE_TIMEOUT" > "$SIDECAR_LOG" 2>&1
    ) &
    SIDECAR_PID=$!

    echo "[clean-start] Sidecar logs: $SIDECAR_LOG"
    echo "[clean-start] Waiting for sidecar health on port 5005..."
    SIDECAR_READY=0
    for _ in {1..15}; do
      if curl -fsS "http://127.0.0.1:5005/health" >/dev/null 2>&1; then
        SIDECAR_READY=1
        echo "[clean-start] Sidecar is healthy (lazy mode — no model loaded yet)"
        break
      fi
      sleep 1
    done

    if [ "$SIDECAR_READY" -ne 1 ]; then
      echo "[clean-start] WARNING: Sidecar failed to become healthy. Continuing startup."
      echo "[clean-start] Check logs: $SIDECAR_LOG"
    fi
  else
    echo "[clean-start] WARNING: sidecar server not found at $SIDECAR_DIR/server.py"
  fi
fi

# Optional: start local audio sidecar (default enabled)
# The audio sidecar starts in lazy mode — no models loaded until first TTS/STT request.
# Comment out this block if you don't need local TTS/STT.
AUDIO_SIDECAR_PID=""
if [ "${OPENZIGS_START_AUDIO_SIDECAR:-1}" != "0" ]; then
  AUDIO_DIR="$PROJECT_ROOT/sidecars/audio"
  AUDIO_LOG="$PROJECT_ROOT/.openzigs-audio-sidecar.log"
  AUDIO_TTS_MODEL="${AUDIO_TTS_MODEL:-mlx-community/Kokoro-82M-bf16}"
  AUDIO_STT_MODEL="${AUDIO_STT_MODEL:-distil-large-v3}"
  AUDIO_IDLE_TIMEOUT="${AUDIO_IDLE_TIMEOUT:-0}"

  if [ -x "$AUDIO_DIR/.venv/bin/python" ]; then
    AUDIO_PY="$AUDIO_DIR/.venv/bin/python"
  elif command -v python3.12 >/dev/null 2>&1; then
    AUDIO_PY="python3.12"
  else
    AUDIO_PY="python3"
  fi

  if [ -f "$AUDIO_DIR/server.py" ]; then
    echo "[clean-start] Starting audio sidecar (lazy mode, tts=$AUDIO_TTS_MODEL, stt=$AUDIO_STT_MODEL, idle-timeout=${AUDIO_IDLE_TIMEOUT}s, port=5006)"
    (
      cd "$AUDIO_DIR"
      "$AUDIO_PY" server.py --port 5006 --tts-model "$AUDIO_TTS_MODEL" --stt-model "$AUDIO_STT_MODEL" --idle-timeout "$AUDIO_IDLE_TIMEOUT" > "$AUDIO_LOG" 2>&1
    ) &
    AUDIO_SIDECAR_PID=$!

    echo "[clean-start] Audio sidecar logs: $AUDIO_LOG"
    echo "[clean-start] Waiting for audio sidecar health on port 5006..."
    AUDIO_READY=0
    for _ in {1..15}; do
      if curl -fsS "http://127.0.0.1:5006/health" >/dev/null 2>&1; then
        AUDIO_READY=1
        echo "[clean-start] Audio sidecar is healthy (lazy mode — no models loaded yet)"
        break
      fi
      sleep 1
    done

    if [ "$AUDIO_READY" -ne 1 ]; then
      echo "[clean-start] WARNING: Audio sidecar failed to become healthy. Continuing startup."
      echo "[clean-start] Check logs: $AUDIO_LOG"
    fi
  else
    echo "[clean-start] WARNING: audio sidecar server not found at $AUDIO_DIR/server.py"
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
  if [ -n "${SIDECAR_PID:-}" ]; then
    kill -9 "$SIDECAR_PID" 2>/dev/null || true
  fi
  if [ -n "${AUDIO_SIDECAR_PID:-}" ]; then
    kill -9 "$AUDIO_SIDECAR_PID" 2>/dev/null || true
  fi
  if [ -n "${TAIL_PID:-}" ]; then
    kill -9 "$TAIL_PID" 2>/dev/null || true
  fi
  pkill -f "next.*dev" || true
  pkill -f "sidecars/image-gen/server.py" || true
  pkill -f "sidecars/audio/server.py" || true
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
