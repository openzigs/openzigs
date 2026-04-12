#!/bin/bash
set -e

# Resolve the directory of the script
DIR="$( cd "$( dirname "${BASH_SOURCE[0]}" )" && pwd )"
PROJECT_ROOT="$(dirname "$DIR")"

# ── Port helpers ─────────────────────────────────────────────────────────────

# Return the first PID listening on a given port, or empty string
port_pid() {
  lsof -ti:"$1" 2>/dev/null | head -1 || true
}

# Return 0 if the PID's command contains PROJECT_ROOT (i.e. it's an OpenZigs process)
is_own_pid() {
  local pid="$1"
  [ -z "$pid" ] && return 1
  ps -p "$pid" -o command= 2>/dev/null | grep -q "$PROJECT_ROOT"
}

# Find the lowest free port >= the given port
find_free_port() {
  local port="$1"
  while lsof -ti:"$port" >/dev/null 2>&1; do
    port=$((port + 1))
  done
  echo "$port"
}

# Resolve the effective port for a service.
#   • Port is free              → use default
#   • Port has an OpenZigs proc → use default (it will be killed below)
#   • Port has a foreign app    → bump to next free port
resolve_port() {
  local default_port="$1"
  local service_name="$2"
  local pid
  pid=$(port_pid "$default_port")
  if [ -z "$pid" ]; then
    echo "$default_port"
    return
  fi
  if is_own_pid "$pid"; then
    echo "[clean-start] OpenZigs $service_name detected on port $default_port – will restart" >&2
    echo "$default_port"
  else
    local free_port
    free_port=$(find_free_port $((default_port + 1)))
    echo "[clean-start] Port $default_port is in use by another app (PID $pid); $service_name will use port $free_port" >&2
    echo "$free_port"
  fi
}

BACKEND_PORT=$(resolve_port 3000 "backend")
UI_PORT=$(resolve_port 3001 "UI")
# Ensure backend and UI never share the same port
if [ "$UI_PORT" -eq "$BACKEND_PORT" ]; then
  UI_PORT=$(find_free_port $((BACKEND_PORT + 1)))
  echo "[clean-start] UI port adjusted to $UI_PORT to avoid collision with backend"
fi

# ── Kill existing OpenZigs processes ─────────────────────────────────────────
echo "[clean-start] Killing existing OpenZigs processes..."

# Kill common OpenZigs dev/watch processes by full command path
pkill -f "$PROJECT_ROOT.*src/server.ts" || true
pkill -f "$PROJECT_ROOT.*dist/server.js" || true
pkill -f "$PROJECT_ROOT.*tsx" || true
pkill -f "$PROJECT_ROOT.*pnpm.*dev" || true
pkill -f "$PROJECT_ROOT/ui.*next.*dev" || true
pkill -f "$PROJECT_ROOT/sidecars/image-gen/server.py" || true
pkill -f "$PROJECT_ROOT/sidecars/audio/server.py" || true
pkill -f "$PROJECT_ROOT/sidecars/music/server.py" || true
pkill -f "$PROJECT_ROOT/sidecars/music-studio/server.py" || true
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

# Force-clear any OpenZigs stragglers still holding their ports after the sweep.
# Non-OpenZigs apps on those ports are intentionally left untouched.
for _port in "$BACKEND_PORT" "$UI_PORT" 3101 5005 5006 9880 5009 5010; do
  STALE_PID=$(port_pid "$_port")
  if [ -n "$STALE_PID" ] && is_own_pid "$STALE_PID"; then
    echo "[clean-start] Killing stale OpenZigs process on port $_port (PID $STALE_PID)"
    kill -9 "$STALE_PID" 2>/dev/null || true
  fi
done

# Kill zombie Chrome instances associated with OpenZigs
# This matches the profile path used in chrome-launcher.ts
pkill -f "openzigs-chrome-profile" || true

# Stop Firecrawl Docker containers if running (they survive process kills)
FIRECRAWL_COMPOSE="$PROJECT_ROOT/docker-compose.firecrawl.yml"
if [ -f "$FIRECRAWL_COMPOSE" ] && command -v docker >/dev/null 2>&1; then
  echo "[clean-start] Stopping Firecrawl Docker containers..."
  docker compose -f "$FIRECRAWL_COMPOSE" down 2>/dev/null || true
fi

echo "[clean-start] Starting OpenZigs in dev mode (backend + UI)..."

# Auto-populate UI .env.local with auth token from ~/.openzigs/config.json
CONFIG_FILE="$HOME/.openzigs/config.json"
UI_ENV="$PROJECT_ROOT/ui/.env.local"
if [ -f "$CONFIG_FILE" ]; then
  TOKEN=$(python3 -c "import json; print(json.load(open('$CONFIG_FILE'))['auth']['token'])" 2>/dev/null || true)
  INVITE_SECRET=$(python3 -c "import json; d=json.load(open('$CONFIG_FILE')); print(d.get('presenter',{}).get('inviteSecret',''))" 2>/dev/null || true)
  # Export workerSecret as CALLBACK_SECRET so local sidecars can authenticate callbacks
  WORKER_SECRET=$(python3 -c "import json; d=json.load(open('$CONFIG_FILE')); print(d.get('auth',{}).get('workerSecret',''))" 2>/dev/null || true)
  if [ -n "$WORKER_SECRET" ]; then
    export CALLBACK_SECRET="$WORKER_SECRET"
  fi
  if [ -n "$TOKEN" ]; then
    echo "NEXT_PUBLIC_OPENZIGS_API_BASE=http://localhost:$BACKEND_PORT" > "$UI_ENV"
    echo "OPENZIGS_INTERNAL_API=http://localhost:$BACKEND_PORT" >> "$UI_ENV"
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
PORT="$BACKEND_PORT" pnpm dev > "$DEV_LOG" 2>&1 &
BACKEND_PID=$!
echo "[clean-start] Backend logs: $DEV_LOG"

echo "[clean-start] Waiting for backend on port $BACKEND_PORT..."
for _ in {1..30}; do
  if lsof -ti:"$BACKEND_PORT" >/dev/null 2>&1; then
    break
  fi
  sleep 1
done

echo "[clean-start] Starting UI..."
(
  cd "$PROJECT_ROOT/ui"
  PORT=$UI_PORT pnpm dev > "$UI_LOG" 2>&1
) &
UI_PID=$!
echo "[clean-start] UI logs: $UI_LOG"

echo "[clean-start] Waiting for UI on port $UI_PORT..."
for _ in {1..30}; do
  if lsof -ti:"$UI_PORT" >/dev/null 2>&1; then
    break
  fi
  sleep 1
done

# Optional: start Firecrawl Docker sidecar (default enabled)
# Checks if Firecrawl is already reachable before attempting Docker startup.
if [ "${OPENZIGS_START_FIRECRAWL:-1}" != "0" ] && [ -f "$FIRECRAWL_COMPOSE" ] && command -v docker >/dev/null 2>&1; then
  if curl -sf http://127.0.0.1:3002/ >/dev/null 2>&1; then
    echo "[clean-start] Firecrawl already running on port 3002 — skipping Docker startup"
  else
    echo "[clean-start] Starting Firecrawl Docker sidecar (port 3002)..."
    if docker compose -f "$FIRECRAWL_COMPOSE" up -d 2>/dev/null; then
      echo "[clean-start] Probing Firecrawl sidecar health in background..."
      start_health_probe "Firecrawl sidecar (port 3002)" "http://127.0.0.1:3002/" 30 2
    else
      echo "[clean-start] WARNING: Firecrawl Docker startup failed — crawl tools will be unavailable"
    fi
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
  echo "[clean-start] Probing GPT-SoVITS health in background (model load can take 5+ min)..."
  start_health_probe "GPT-SoVITS (port 9880)" "http://127.0.0.1:9880/" 150 2 1
else
  if [ "${OPENZIGS_START_SOVITS:-1}" != "0" ]; then
    echo "[clean-start] GPT-SoVITS not installed at $SOVITS_DIR — skipping Engine B."
    echo "[clean-start] Install with: bash scripts/setup-gptsovits.sh"
  fi
fi

# Optional: start music generation sidecar (ACE-Step 1.5, default disabled)
# NOTE: The sidecar is now managed by launchd (com.openzigs.acestep) and starts
# automatically on login — you only need this if you want dev-clean.sh to own
# the process (e.g. to capture output in .openzigs-music-sidecar.log).
# Set OPENZIGS_START_MUSIC_SIDECAR=1 to enable. Requires Python 3.11 venv and
# ~/ace-step-apple-silicon cloned + uv-synced (see docs/USER_GUIDE.md).
MUSIC_SIDECAR_PID=""
if [ "${OPENZIGS_START_MUSIC_SIDECAR:-0}" = "1" ]; then
  MUSIC_DIR="$PROJECT_ROOT/sidecars/music"
  MUSIC_LOG="$PROJECT_ROOT/.openzigs-music-sidecar.log"
  MUSIC_PORT="${MUSIC_GEN_PORT:-5009}"

  if [ -x "$MUSIC_DIR/.venv/bin/python" ]; then
    MUSIC_PY="$MUSIC_DIR/.venv/bin/python"
  else
    echo "[clean-start] WARNING: music sidecar venv not found at $MUSIC_DIR/.venv — skipping."
    echo "[clean-start] Run: cd sidecars/music && /opt/homebrew/bin/python3.11 -m venv .venv && source .venv/bin/activate && pip install -r requirements.txt"
    MUSIC_PY=""
  fi

  if [ -n "$MUSIC_PY" ] && [ -f "$MUSIC_DIR/server.py" ]; then
    echo "[clean-start] Starting music-gen sidecar (ACE-Step 1.5, port=$MUSIC_PORT)"
    (
      cd "$MUSIC_DIR"
      "$MUSIC_PY" server.py --port "$MUSIC_PORT" > "$MUSIC_LOG" 2>&1
    ) &
    MUSIC_SIDECAR_PID=$!

    echo "[clean-start] Music sidecar logs: $MUSIC_LOG"
    echo "[clean-start] Probing music-gen sidecar health in background..."
    start_health_probe "Music-gen sidecar (port $MUSIC_PORT)" "http://127.0.0.1:${MUSIC_PORT}/health" 15 1
  fi
fi

# Optional: start music-studio sidecar (demucs stem separation, Seed-VC voice2voice, default enabled)
# Set OPENZIGS_START_MUSIC_STUDIO_SIDECAR=0 to disable. Requires project venv with
# demucs, basic-pitch, matchering, and seed-vc deps installed (see sidecars/music-studio/requirements.txt).
# NOTE: Unlike image-gen/audio, music-studio does not cache heavy models between jobs
# (Demucs loads per-call and is freed immediately). The idle-timeout here logs a warning
# after inactivity but does not unload anything — the process footprint is ~200-400MB.
MUSIC_STUDIO_SIDECAR_PID=""
if [ "${OPENZIGS_START_MUSIC_STUDIO_SIDECAR:-1}" != "0" ]; then
  MUSIC_STUDIO_DIR="$PROJECT_ROOT/sidecars/music-studio"
  MUSIC_STUDIO_LOG="$PROJECT_ROOT/.openzigs-music-studio-sidecar.log"
  MUSIC_STUDIO_PORT="${MUSIC_STUDIO_PORT:-5010}"
  MUSIC_STUDIO_IDLE_TIMEOUT="${MUSIC_STUDIO_IDLE_TIMEOUT:-600}"

  if [ -x "$MUSIC_STUDIO_DIR/.venv/bin/python" ]; then
    MUSIC_STUDIO_PY="$MUSIC_STUDIO_DIR/.venv/bin/python"
  elif [ -x "$PROJECT_ROOT/.venv/bin/python" ]; then
    MUSIC_STUDIO_PY="$PROJECT_ROOT/.venv/bin/python"
  else
    MUSIC_STUDIO_PY="python3"
  fi

  if [ -f "$MUSIC_STUDIO_DIR/server.py" ]; then
    # Ensure venv has all deps (python-multipart etc.) before starting
    if [ -f "$MUSIC_STUDIO_DIR/requirements.txt" ] && [ -x "$MUSIC_STUDIO_DIR/.venv/bin/pip" ]; then
      echo "[clean-start] Syncing music-studio venv deps..."
      "$MUSIC_STUDIO_DIR/.venv/bin/pip" install -q -r "$MUSIC_STUDIO_DIR/requirements.txt" 2>/dev/null || true
    fi

    echo "[clean-start] Starting music-studio sidecar (demucs/Seed-VC/matchering, port=$MUSIC_STUDIO_PORT)"
    (
      cd "$MUSIC_STUDIO_DIR"
      "$MUSIC_STUDIO_PY" server.py --port "$MUSIC_STUDIO_PORT" --idle-timeout "$MUSIC_STUDIO_IDLE_TIMEOUT" > "$MUSIC_STUDIO_LOG" 2>&1
    ) &
    MUSIC_STUDIO_SIDECAR_PID=$!

    echo "[clean-start] Music-studio sidecar logs: $MUSIC_STUDIO_LOG"
    echo "[clean-start] Probing music-studio sidecar health in background..."
    start_health_probe "Music-studio sidecar (port $MUSIC_STUDIO_PORT)" "http://127.0.0.1:${MUSIC_STUDIO_PORT}/health" 15 1
  else
    echo "[clean-start] WARNING: music-studio sidecar server not found at $MUSIC_STUDIO_DIR/server.py"
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
  AUDIO_IDLE_TIMEOUT="${AUDIO_IDLE_TIMEOUT:-300}"

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
  if [ -n "${MUSIC_SIDECAR_PID:-}" ]; then
    kill -9 "$MUSIC_SIDECAR_PID" 2>/dev/null || true
  fi
  if [ -n "${MUSIC_STUDIO_SIDECAR_PID:-}" ]; then
    kill -9 "$MUSIC_STUDIO_SIDECAR_PID" 2>/dev/null || true
  fi
  if [ -n "${TAIL_PID:-}" ]; then
    kill -9 "$TAIL_PID" 2>/dev/null || true
  fi
  if [ "${#PROBE_PIDS[@]}" -gt 0 ]; then
    for probe_pid in "${PROBE_PIDS[@]}"; do
      kill -9 "$probe_pid" 2>/dev/null || true
    done
  fi
  pkill -f "$PROJECT_ROOT.*next.*dev" || true
  pkill -f "$PROJECT_ROOT/sidecars/image-gen/server.py" || true
  pkill -f "$PROJECT_ROOT/sidecars/audio/server.py" || true
  pkill -f "$PROJECT_ROOT/sidecars/music/server.py" || true
  pkill -f "$PROJECT_ROOT/sidecars/music-studio/server.py" || true
  pkill -f "$PROJECT_ROOT.*api_v2.py" || true
  # Stop Firecrawl Docker containers on exit
  if [ -f "$FIRECRAWL_COMPOSE" ] && command -v docker >/dev/null 2>&1; then
    docker compose -f "$FIRECRAWL_COMPOSE" down 2>/dev/null || true
  fi
}

trap cleanup EXIT

# Wait for the UI process; use || true so a UI crash doesn't trigger set -e
# and tear down the entire stack. The EXIT trap still fires on Ctrl+C.
wait "$UI_PID" || true
