#!/bin/bash
set -e

# Resolve the directory of the script
DIR="$( cd "$( dirname "${BASH_SOURCE[0]}" )" && pwd )"
PROJECT_ROOT="$(dirname "$DIR")"

echo "[clean-start] Killing existing OpenZigs processes..."

# Kill common OpenZigs dev/watch processes by full command path
pkill -f "$PROJECT_ROOT.*src/server.ts" || true
pkill -f "$PROJECT_ROOT.*dist/server.js" || true
pkill -f "$PROJECT_ROOT.*tsx" || true
pkill -f "$PROJECT_ROOT.*pnpm.*dev" || true
pkill -f "$PROJECT_ROOT/ui.*next.*dev" || true
pkill -f "$PROJECT_ROOT/sidecars/image-gen/server.py" || true
pkill -f "$PROJECT_ROOT/sidecars/audio/server.py" || true
pkill -f "$PROJECT_ROOT.*api_v2.py" || true

# Final deterministic sweep: kill any OpenZigs-rooted node/tsx/pnpm/next/python
# process that may have escaped the explicit patterns above.
for PID in $(pgrep -f "$PROJECT_ROOT" 2>/dev/null || true); do
  [ "$PID" = "$$" ] && continue
  CMD=$(ps -p "$PID" -o command= 2>/dev/null || true)
  if echo "$CMD" | grep -Eq "(node|tsx|pnpm|next|python)"; then
    kill -9 "$PID" 2>/dev/null || true
  fi
done

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

# Kill processes on port 9880 (GPT-SoVITS Engine B)
PID=$(lsof -ti:9880 2>/dev/null || true)
if [ -n "$PID" ]; then
  echo "[clean-start] Killing process on port 9880 (PID $PID)"
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
  INVITE_SECRET=$(python3 -c "import json; d=json.load(open('$CONFIG_FILE')); print(d.get('presenter',{}).get('inviteSecret',''))" 2>/dev/null || true)
  if [ -n "$TOKEN" ]; then
    echo "NEXT_PUBLIC_OPENZIGS_API_BASE=http://localhost:3000" > "$UI_ENV"
    echo "NEXT_PUBLIC_OPENZIGS_TOKEN=$TOKEN" >> "$UI_ENV"
    if [ -n "$INVITE_SECRET" ]; then
      echo "PRESENTER_INVITE_SECRET=$INVITE_SECRET" >> "$UI_ENV"
    fi
    echo "[clean-start] Wrote auth token to ui/.env.local"
  fi
fi

cd "$PROJECT_ROOT"
DEV_LOG="$PROJECT_ROOT/.openzigs-dev.log"
UI_LOG="$PROJECT_ROOT/.openzigs-ui.log"
PROBE_PIDS=()

start_health_probe() {
  local name="$1"
  local url="$2"
  local attempts="$3"
  local interval="$4"
  local force_ipv4="${5:-0}"

  (
    local ready=0
    for _ in $(seq 1 "$attempts"); do
      if [ "$force_ipv4" = "1" ]; then
        if curl -4 -fsS "$url" >/dev/null 2>&1; then
          ready=1
          break
        fi
      else
        if curl -fsS "$url" >/dev/null 2>&1; then
          ready=1
          break
        fi
      fi
      sleep "$interval"
    done

    if [ "$ready" -eq 1 ]; then
      echo "[clean-start] ${name} is healthy"
    else
      echo "[clean-start] WARNING: ${name} health check timed out. Check logs."
    fi
  ) &

  PROBE_PIDS+=("$!")
}

echo "[clean-start] Starting backend first..."
pnpm dev > "$DEV_LOG" 2>&1 &
BACKEND_PID=$!
echo "[clean-start] Backend logs: $DEV_LOG"

echo "[clean-start] Waiting for backend on port 3000..."
for _ in {1..30}; do
  if lsof -ti:3000 >/dev/null 2>&1; then
    break
  fi
  sleep 1
done

echo "[clean-start] Starting UI..."
(
  cd "$PROJECT_ROOT/ui"
  PORT=3001 pnpm dev > "$UI_LOG" 2>&1
) &
UI_PID=$!
echo "[clean-start] UI logs: $UI_LOG"

echo "[clean-start] Waiting for UI on port 3001..."
for _ in {1..30}; do
  if lsof -ti:3001 >/dev/null 2>&1; then
    break
  fi
  sleep 1
done

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
    echo "[clean-start] Probing image-gen sidecar health in background..."
    start_health_probe "Image-gen sidecar (port 5005)" "http://127.0.0.1:5005/health" 15 1
  else
    echo "[clean-start] WARNING: sidecar server not found at $SIDECAR_DIR/server.py"
  fi
fi

# Optional: start GPT-SoVITS (Engine B) if installed (default enabled)
# GPT-SoVITS must be started BEFORE the audio sidecar so the --sovits-url probe succeeds.
SOVITS_PID=""
SOVITS_URL=""
SOVITS_DIR="${HOME}/.openzigs/sidecars/gptsovits"
if [ "${OPENZIGS_START_SOVITS:-1}" != "0" ] && [ -x "$SOVITS_DIR/start.sh" ]; then
  SOVITS_URL="http://127.0.0.1:9880"
  SOVITS_LOG="$PROJECT_ROOT/.openzigs-sovits.log"
  echo "[clean-start] Starting GPT-SoVITS (Engine B, port=9880)"
  (
    bash "$SOVITS_DIR/start.sh" > "$SOVITS_LOG" 2>&1
  ) &
  SOVITS_PID=$!

  echo "[clean-start] GPT-SoVITS logs: $SOVITS_LOG"
  echo "[clean-start] Probing GPT-SoVITS health in background..."
  start_health_probe "GPT-SoVITS (port 9880)" "http://127.0.0.1:9880/" 60 2 1
else
  if [ "${OPENZIGS_START_SOVITS:-1}" != "0" ]; then
    echo "[clean-start] GPT-SoVITS not installed at $SOVITS_DIR — skipping Engine B."
    echo "[clean-start] Install with: bash scripts/setup-gptsovits.sh"
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
    AUDIO_SOVITS_FLAG=""
    if [ -n "$SOVITS_URL" ]; then
      AUDIO_SOVITS_FLAG="--sovits-url $SOVITS_URL"
      echo "[clean-start] Starting audio sidecar (lazy mode, tts=$AUDIO_TTS_MODEL, stt=$AUDIO_STT_MODEL, sovits=$SOVITS_URL, idle-timeout=${AUDIO_IDLE_TIMEOUT}s, port=5006)"
    else
      echo "[clean-start] Starting audio sidecar (lazy mode, tts=$AUDIO_TTS_MODEL, stt=$AUDIO_STT_MODEL, idle-timeout=${AUDIO_IDLE_TIMEOUT}s, port=5006)"
    fi
    (
      cd "$AUDIO_DIR"
      # shellcheck disable=SC2086
      "$AUDIO_PY" server.py --port 5006 --tts-model "$AUDIO_TTS_MODEL" --stt-model "$AUDIO_STT_MODEL" --idle-timeout "$AUDIO_IDLE_TIMEOUT" $AUDIO_SOVITS_FLAG > "$AUDIO_LOG" 2>&1
    ) &
    AUDIO_SIDECAR_PID=$!

    echo "[clean-start] Audio sidecar logs: $AUDIO_LOG"
    echo "[clean-start] Probing audio sidecar health in background..."
    start_health_probe "Audio sidecar (port 5006)" "http://127.0.0.1:5006/health" 15 1
  else
    echo "[clean-start] WARNING: audio sidecar server not found at $AUDIO_DIR/server.py"
  fi
fi

tail -f "$DEV_LOG" "$UI_LOG" &
TAIL_PID=$!

cleanup() {
  echo "[clean-start] Stopping OpenZigs dev servers..."
  kill -9 "$BACKEND_PID" 2>/dev/null || true
  if [ -n "${UI_PID:-}" ]; then
    kill -9 "$UI_PID" 2>/dev/null || true
  fi
  if [ -n "${SIDECAR_PID:-}" ]; then
    kill -9 "$SIDECAR_PID" 2>/dev/null || true
  fi
  if [ -n "${AUDIO_SIDECAR_PID:-}" ]; then
    kill -9 "$AUDIO_SIDECAR_PID" 2>/dev/null || true
  fi
  if [ -n "${SOVITS_PID:-}" ]; then
    kill -9 "$SOVITS_PID" 2>/dev/null || true
  fi
  if [ -n "${TAIL_PID:-}" ]; then
    kill -9 "$TAIL_PID" 2>/dev/null || true
  fi
  if [ "${#PROBE_PIDS[@]}" -gt 0 ]; then
    for probe_pid in "${PROBE_PIDS[@]}"; do
      kill -9 "$probe_pid" 2>/dev/null || true
    done
  fi
  pkill -f "next.*dev" || true
  pkill -f "sidecars/image-gen/server.py" || true
  pkill -f "sidecars/audio/server.py" || true
  pkill -f "api_v2.py" || true
}

trap cleanup EXIT

wait "$UI_PID"
