#!/usr/bin/env bash
# start-mac-sidecars.sh
# Start MPS-backed sidecars on macOS / Apple Silicon. Parity with
# start-cuda-sidecars.sh but tuned for unified-memory hosts:
#   * No GPU pinning (Metal / MPS owns the unified memory pool).
#   * Lip Sync starts on the canonical port 5012 (issue #1104).
#   * Per-sidecar SKIP_* env vars match the CUDA script for muscle memory.
#
# Run from a normal shell:
#   bash sidecars/start-mac-sidecars.sh
#
# NOTE: intentionally no `set -e` — one sidecar failing must not block the rest.
set -u

SIDECARS_DIR="${OPENZIGS_SIDECARS_DIR:-$HOME/.openzigs/sidecars}"
LOG_DIR="$HOME/.openzigs/logs"
PID_DIR="$HOME/.openzigs/pids"
mkdir -p "$LOG_DIR" "$PID_DIR"

# Read CALLBACK_SECRET from ~/.openzigs/config.json so callbacks pass HMAC verification.
CONFIG_FILE="$HOME/.openzigs/config.json"
CALLBACK_SECRET=""
if [ -f "$CONFIG_FILE" ] && command -v python3 >/dev/null 2>&1; then
    CALLBACK_SECRET=$(python3 -c "import json; d=json.load(open('$CONFIG_FILE')); print(d.get('auth',{}).get('workerSecret',''))" 2>/dev/null || true)
fi

# Optional per-machine env overrides (FLUX_DEFAULT_MODEL, HF_TOKEN, etc.)
MAC_ENV="$HOME/.openzigs/.env.mac"
if [ -f "$MAC_ENV" ]; then
    echo "Loading Mac env overrides from $MAC_ENV"
    set -a; source "$MAC_ENV"; set +a
fi

CALLBACK_BASE_URL="${CALLBACK_BASE_URL:-http://localhost:3000/api/queue}"

echo "=== Starting Mac (MPS) Sidecars ==="

# Refuse to start lipsync alongside LTX worker on the same host — they cannot
# coexist within 16 GB of unified memory. The backend's
# QueueMaster.ensureSidecarMemory("lipsync") already unloads LTX before
# dispatch (issue #1102), but at the OS level we still want the operator
# to make a deliberate choice when starting both daemons.
if [ "${SKIP_LIPSYNC:-0}" != "1" ] && [ "${SKIP_WORKER:-0}" != "1" ] \
   && [ -d "$SIDECARS_DIR/lipsync" ] && [ -d "$SIDECARS_DIR/worker" ]; then
    echo ""
    echo "  NOTE: both LTX worker (5007) and Lip Sync (5012) are deployed."
    echo "        On a 16 GB Mac they cannot run simultaneously. The queue"
    echo "        master will unload LTX before dispatching lipsync jobs."
    echo "        Set SKIP_LIPSYNC=1 or SKIP_WORKER=1 to start only one."
    echo ""
fi

# Kill any existing sidecar processes on the canonical Mac ports.
for port in 5005 5006 5007 5009 5011 5012; do
    pid=$(lsof -ti :$port 2>/dev/null || true)
    if [ -n "$pid" ]; then
        echo "Killing existing process on port $port (PID: $pid)"
        kill "$pid" 2>/dev/null || true
        sleep 1
    fi
done

start_sidecar() {
    # $1 = name (display)        e.g. "Image Gen"
    # $2 = subdir under SIDECARS_DIR   e.g. "image-gen"
    # $3 = entrypoint script     e.g. "server.py"
    # $4 = port                   e.g. 5005
    # $5 = pid file basename      e.g. "image-gen"
    # $6 = extra env (single string of KEY=VALUE pairs separated by spaces)
    local name="$1" sub="$2" entry="$3" port="$4" pidname="$5" extra="$6"
    local dir="$SIDECARS_DIR/$sub"
    local venv="$dir/.venv-mps"
    if [ ! -f "$venv/bin/python" ]; then
        venv="$dir/venv"  # fall back to the CUDA-style venv name
    fi
    if [ ! -d "$dir" ] || [ ! -f "$dir/$entry" ]; then
        echo "$name not deployed (missing $dir/$entry) — skipping port $port"
        return
    fi
    if [ ! -f "$venv/bin/python" ]; then
        echo "$name venv not found at $venv — run install.sh to set it up"
        return
    fi
    echo "Starting $name sidecar (port $port)..."
    # nohup + disown is the macOS-friendly equivalent of WSL's setsid trick.
    # Quoting note: the env block must expand in this shell, not the child.
    nohup bash -c "cd '$dir' && source '$venv/bin/activate' && $extra exec python '$entry' --port $port" \
        >> "$LOG_DIR/${pidname}-mps.log" 2>&1 &
    local pid=$!
    echo "$pid" > "$PID_DIR/$pidname.pid"
    disown "$pid" 2>/dev/null || true
    echo "  PID: $pid"
}

COMMON_ENV="HF_TOKEN='${HF_TOKEN:-}' CALLBACK_SECRET='${CALLBACK_SECRET}' CALLBACK_URL='${CALLBACK_BASE_URL}/complete' PROGRESS_URL='${CALLBACK_BASE_URL}/progress'"

# ── Image Generation (5005) ─────────────────────────────────
if [ "${SKIP_IMAGE_GEN:-0}" != "1" ]; then
    start_sidecar "Image Gen" "image-gen" "server.py" 5005 "image-gen" \
        "$COMMON_ENV FLUX_DEFAULT_MODEL='${FLUX_DEFAULT_MODEL:-flux-dev}'"
fi

# ── Audio (5006) ────────────────────────────────────────────
if [ "${SKIP_AUDIO:-0}" != "1" ]; then
    start_sidecar "Audio" "audio" "server.py" 5006 "audio" "$COMMON_ENV"
fi

# ── Video Worker / LTX (5007) ───────────────────────────────
if [ "${SKIP_WORKER:-0}" != "1" ]; then
    start_sidecar "Video Worker (LTX)" "worker" "server.py" 5007 "worker" \
        "$COMMON_ENV LTX_MODEL_KEY='${LTX_MODEL_KEY:-ltxv-13b-097-distilled}'"
fi

# ── Music (5009) ────────────────────────────────────────────
if [ "${SKIP_MUSIC:-0}" != "1" ]; then
    start_sidecar "Music (ACE-Step)" "music" "server.py" 5009 "music" \
        "$COMMON_ENV ACESTEP_DEVICE='mps'"
fi

# ── Lip Sync / LatentSync (5012) ────────────────────────────
if [ "${SKIP_LIPSYNC:-0}" != "1" ]; then
    start_sidecar "Lip Sync (LatentSync)" "lipsync" "server.py" 5012 "lipsync" \
        "$COMMON_ENV LIPSYNC_DEFAULT_MODEL='${LIPSYNC_DEFAULT_MODEL:-v1.5}'"
fi

# Wait for /health endpoints to come up.
echo ""
echo "Waiting for sidecars to become ready..."
sleep 8

for entry in "5005:Image Gen" "5006:Audio" "5007:Video Worker" "5009:Music (ACE-Step)" "5012:Lip Sync (LatentSync)"; do
    port="${entry%%:*}"
    name="${entry##*:}"
    if curl -sf "http://localhost:$port/health" > /dev/null 2>&1; then
        echo "  $name (port $port): READY"
    else
        echo "  $name (port $port): NOT READY (check $LOG_DIR/*-mps.log)"
    fi
done

echo ""
echo "Logs: $LOG_DIR/{image-gen,audio,worker,music,lipsync}-mps.log"
echo "PID files: $PID_DIR/*.pid"
echo "Stop one: kill \$(cat $PID_DIR/<name>.pid)"
