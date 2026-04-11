#!/usr/bin/env bash
# ─────────────────────────────────────────────────────────────────────────────
# cuda-ctl.sh — Unified CUDA Media Node Control Script (WSL)
#
# Manages the FluxQ image-gen, audio STT/TTS, LTX video-gen, ACE-Step
# music, and LatentSync lip-sync sidecars on a WSL/CUDA machine. Processes are backgrounded with setsid
# and tracked via PID files so they survive parent shell exit.
#
# Usage:
#   ./scripts/cuda-ctl.sh <service> <command> [options]
#   ./scripts/cuda-ctl.sh <command>   (unified commands)
#
# Services:
#   flux               FluxQ image generation sidecar (port 5005)
#   audio              Audio STT/TTS sidecar           (port 5006)
#   ltx                LTX-2 video generation worker   (port 5007)
#   music              ACE-Step music generation       (port 5009)
#   lipsync            LatentSync lip sync              (port 5010)
#
# Per-service commands:
#   start              Launch background process and write PID file
#   stop               Kill from PID file (graceful SIGTERM → SIGKILL)
#   restart            Stop then start
#   status             Show process state + health endpoint
#   logs               Tail service logs (Ctrl+C to exit)
#   sync               Copy server_cuda.py from repo → install dir
#
# Flux-only commands:
#   flux load [model]      Trigger model load (flux-schnell|flux-dev)
#   flux generate [prompt] Send a quick test generation request
#   flux clear-cache       Remove cached model weights
#
# LTX-only commands:
#   ltx generate [pipeline] [prompt] [audio] [tiling]  Quick test generation
#   ltx models             List available model catalog from worker
#
# Audio-only commands:
#   audio transcribe [file]  Quick STT smoke test (wav/mp3)
#   audio tts [text]         Quick TTS smoke test
#
# Music-only commands:
#   music generate [prompt]  Quick ACE-Step generation test
#
# Lipsync-only commands:
#   lipsync unload           Unload model from VRAM
#
# Unified commands:
#   status             Show status of all services
#   sync               Sync all server_cuda.py files from repo
#   start              Start all services
#   stop               Stop all services
#   restart            Restart all services
#   switch <flux|ltx>  Unload competing VRAM hog and activate target service
#   help               Show this help message
# ─────────────────────────────────────────────────────────────────────────────
set -euo pipefail

# ── Defaults ──────────────────────────────────────────────────────────────────
SIDECARS_DIR="${SIDECARS_DIR:-$HOME/openzigs-sidecars}"
LOG_DIR="${LOG_DIR:-$HOME/.openzigs/logs}"
PID_DIR="${PID_DIR:-$HOME/.openzigs/pids}"

IMG_DIR="$SIDECARS_DIR/image-gen"
AUD_DIR="$SIDECARS_DIR/audio"
VID_DIR="$SIDECARS_DIR/worker"
MUS_DIR="$SIDECARS_DIR/music"
LIP_DIR="$SIDECARS_DIR/lipsync"

IMG_LOG="$LOG_DIR/image-gen-cuda.log"
AUD_LOG="$LOG_DIR/audio-cuda.log"
VID_LOG="$LOG_DIR/worker-cuda.log"
MUS_LOG="$LOG_DIR/music-cuda.log"
LIP_LOG="$LOG_DIR/lipsync-cuda.log"

IMG_PID_FILE="$PID_DIR/image-gen.pid"
AUD_PID_FILE="$PID_DIR/audio.pid"
VID_PID_FILE="$PID_DIR/worker.pid"
MUS_PID_FILE="$PID_DIR/music.pid"
LIP_PID_FILE="$PID_DIR/lipsync.pid"

FLUX_PORT="${FLUX_PORT:-5005}"
AUDIO_PORT="${AUDIO_PORT:-5006}"
LTX_PORT="${LTX_PORT:-5007}"
MUSIC_PORT="${MUSIC_PORT:-5009}"
LIPSYNC_PORT="${LIPSYNC_PORT:-5010}"

# ── Colors ────────────────────────────────────────────────────────────────────
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
CYAN='\033[0;36m'
BOLD='\033[1m'
NC='\033[0m'

info()    { echo -e "${CYAN}[cuda]${NC} $*"; }
ok()      { echo -e "${GREEN}[cuda]${NC} $*"; }
warn()    { echo -e "${YELLOW}[cuda]${NC} $*"; }
fail()    { echo -e "${RED}[cuda]${NC} $*" >&2; exit 1; }
section() { echo -e "\n${BOLD}$*${NC}"; }

# ── Helpers ───────────────────────────────────────────────────────────────────

load_env() {
  # Load per-machine CUDA overrides (FLUXQ_SECRET_TOKEN, LTX_SECRET_TOKEN, etc.)
  local env_file="$HOME/.openzigs/.env.cuda"
  if [[ -f "$env_file" ]]; then
    set -a; source "$env_file"; set +a
  fi
  # Fallback: read HF_TOKEN from Windows repo .env if running under WSL
  if [[ -z "${HF_TOKEN:-}" ]]; then
    local win_env="/mnt/c/Users/$(cmd.exe /C "echo %USERNAME%" 2>/dev/null | tr -d '\r')/Development/openzigs/.env"
    [[ -f "$win_env" ]] && HF_TOKEN=$(grep -m1 '^HF_TOKEN=' "$win_env" | cut -d= -f2- | tr -d '\r') || true
  fi
}

read_callback_secret() {
  local config="$HOME/.openzigs/config.json"
  if [[ -f "$config" ]] && command -v python3 &>/dev/null; then
    python3 -c "import json; d=json.load(open('$config')); print(d.get('auth',{}).get('workerSecret',''))" 2>/dev/null || true
  fi
}

# Write PID to file. Creates parent dirs.
write_pid() {
  local pidfile="$1"
  local pid="$2"
  mkdir -p "$PID_DIR"
  echo "$pid" > "$pidfile"
}

# Read PID from file, returns "" if missing/stale.
read_pid() {
  local pidfile="$1"
  if [[ ! -f "$pidfile" ]]; then
    echo ""; return
  fi
  local pid
  pid=$(cat "$pidfile" 2>/dev/null || true)
  if [[ -n "$pid" ]] && kill -0 "$pid" 2>/dev/null; then
    echo "$pid"
  else
    echo ""
  fi
}

# Graceful stop: SIGTERM → wait 5s → SIGKILL
stop_pid() {
  local pidfile="$1"
  local label="$2"
  local pid
  pid=$(read_pid "$pidfile")
  if [[ -z "$pid" ]]; then
    warn "$label: no running process found."
    rm -f "$pidfile"
    return
  fi
  info "Sending SIGTERM to $label (PID $pid)..."
  kill "$pid" 2>/dev/null || true
  local count=0
  while kill -0 "$pid" 2>/dev/null && [[ $count -lt 10 ]]; do
    sleep 0.5; ((count++))
  done
  if kill -0 "$pid" 2>/dev/null; then
    warn "$label still alive — sending SIGKILL"
    kill -9 "$pid" 2>/dev/null || true
  fi
  rm -f "$pidfile"
  ok "$label stopped."
}

# Check health endpoint
check_health() {
  local url="$1"
  local response
  if response=$(curl -sf --max-time 4 "$url/health" 2>/dev/null); then
    echo "$response" | python3 -m json.tool 2>/dev/null || echo "$response"
    return 0
  fi
  return 1
}

# Sidecar install dir guard
require_sidecar_dir() {
  local dir="$1"
  local name="$2"
  if [[ ! -d "$dir" ]]; then
    fail "$name sidecar directory not found: $dir — run setup-cuda-sidecars.sh first"
  fi
  if [[ ! -d "$dir/venv" ]]; then
    fail "$name venv missing at $dir/venv — run setup-cuda-sidecars.sh first"
  fi
}

# ── Repo source path  ─────────────────────────────────────────────────────────
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_SIDECARS="$SCRIPT_DIR/../sidecars"

# ── FluxQ (Image Gen) Commands ────────────────────────────────────────────────

flux_start() {
  require_sidecar_dir "$IMG_DIR" "Image Gen"
  load_env
  local callback_secret
  callback_secret=$(read_callback_secret)
  mkdir -p "$LOG_DIR" "$PID_DIR"
  info "Starting Image Gen sidecar (port $FLUX_PORT)..."
  setsid bash -c "
    cd '$IMG_DIR'
    source venv/bin/activate
    HF_TOKEN='${HF_TOKEN:-}' \
    FLUXQ_CALLBACK_SECRET='${callback_secret:-}' \
    FLUX_DEFAULT_MODEL='${FLUX_DEFAULT_MODEL:-flux-dev}' \
    FLUXQ_SECRET_TOKEN='${FLUXQ_SECRET_TOKEN:-}' \
    exec python server.py --port $FLUX_PORT \
      >> '$IMG_LOG' 2>&1
  " &
  write_pid "$IMG_PID_FILE" $!
  sleep 3
  flux_status
}

flux_stop() {
  stop_pid "$IMG_PID_FILE" "FluxQ"
}

flux_restart() {
  flux_stop
  sleep 1
  flux_start
}

flux_status() {
  section "── FluxQ (Image Gen) ── port $FLUX_PORT"
  local pid
  pid=$(read_pid "$IMG_PID_FILE")
  if [[ -n "$pid" ]]; then
    ok "Running — PID $pid"
  else
    warn "Not running (no PID or process dead)"
  fi
  if check_health "http://localhost:$FLUX_PORT"; then
    : # printed by check_health
  else
    warn "Health endpoint unreachable at http://localhost:$FLUX_PORT/health"
  fi
}

flux_logs() {
  info "Tailing FluxQ logs — Ctrl+C to stop"
  mkdir -p "$LOG_DIR"
  touch "$IMG_LOG"
  tail -F "$IMG_LOG"
}

flux_load_model() {
  load_env
  if [[ -z "${FLUXQ_SECRET_TOKEN:-}" ]]; then
    fail "FLUXQ_SECRET_TOKEN not set. Add it to $HOME/.openzigs/.env.cuda"
  fi
  local model="${1:-flux-dev}"
  info "Requesting FluxQ model load: $model"
  local response
  response=$(curl -sf -X POST "http://localhost:$FLUX_PORT/model" \
    -H "Authorization: Bearer $FLUXQ_SECRET_TOKEN" \
    -H "Content-Type: application/json" \
    -d "{\"model\":\"$model\"}" 2>/dev/null) \
    || fail "Request failed. Is FluxQ running? Try: $0 flux status"
  echo "$response" | python3 -m json.tool 2>/dev/null || echo "$response"
  ok "Model load triggered (diffusers/CUDA — may take 30-120s on first run)."
}

flux_unload() {
  load_env
  if [[ -z "${FLUXQ_SECRET_TOKEN:-}" ]]; then
    fail "FLUXQ_SECRET_TOKEN not set."
  fi
  info "Unloading FluxQ model from VRAM..."
  local response
  response=$(curl -sf -X POST "http://localhost:$FLUX_PORT/unload" \
    -H "Authorization: Bearer $FLUXQ_SECRET_TOKEN" \
    -H "Content-Type: application/json" \
    -d '{}' 2>/dev/null) \
    || fail "Request failed. Is FluxQ running?"
  echo "$response" | python3 -m json.tool 2>/dev/null || echo "$response"
}

flux_generate() {
  load_env
  if [[ -z "${FLUXQ_SECRET_TOKEN:-}" ]]; then
    fail "FLUXQ_SECRET_TOKEN not set."
  fi
  local prompt="${1:-A majestic mountain at sunrise, photorealistic}"
  local outfile="/tmp/fluxq-test-$(date +%s).png"
  info "Generating image: \"$prompt\""
  info "Output: $outfile"
  local http_code
  http_code=$(curl -sf -X POST "http://localhost:$FLUX_PORT/generate" \
    -H "Authorization: Bearer $FLUXQ_SECRET_TOKEN" \
    -H "Content-Type: application/json" \
    -d "{\"prompt\":\"$prompt\",\"width\":512,\"height\":512,\"steps\":4}" \
    --output "$outfile" \
    -w "%{http_code}" 2>/dev/null) \
    || fail "Request failed. Is a model loaded? Run: $0 flux load"
  if [[ "$http_code" == "200" ]]; then
    ok "Saved to $outfile"
  else
    fail "HTTP $http_code — check logs: $0 flux logs"
  fi
}

flux_sync() {
  local src="$REPO_SIDECARS/image-gen/server_cuda.py"
  [[ -f "$src" ]] || fail "Source not found: $src"
  mkdir -p "$IMG_DIR"
  info "Syncing image-gen/server_cuda.py → $IMG_DIR/server.py"
  cp "$src" "$IMG_DIR/server.py"
  local req="$REPO_SIDECARS/image-gen/requirements.txt"
  if [[ -f "$req" ]]; then
    info "Syncing image-gen/requirements.txt → $IMG_DIR/requirements.txt"
    cp "$req" "$IMG_DIR/requirements.txt"
  fi
  local lora="$REPO_SIDECARS/image-gen/train_dreambooth_lora_cuda.py"
  if [[ -f "$lora" ]]; then
    cp "$lora" "$IMG_DIR/train_dreambooth_lora_cuda.py"
  fi
  ok "FluxQ synced. Restart to apply: $0 flux restart"
}

flux_clear_cache() {
  local cache_dir="${HF_HUB_CACHE:-$HOME/.cache/huggingface/hub}"
  info "Model cache at $cache_dir"
  info "To clear Flux weights only, remove subdirs matching 'FLUX.1' inside that path."
  info "Full wipe: rm -rf $cache_dir  (WARNING: deletes all HuggingFace model downloads)"
  warn "No automatic clear — too destructive. Use: huggingface-cli delete-cache"
}

# ── Audio (Whisper + Kokoro) Commands ─────────────────────────────────────────

audio_start() {
  require_sidecar_dir "$AUD_DIR" "Audio"
  mkdir -p "$LOG_DIR" "$PID_DIR"
  info "Starting Audio sidecar (port $AUDIO_PORT)..."
  setsid bash -c "
    cd '$AUD_DIR'
    source venv/bin/activate
    exec python server.py --port $AUDIO_PORT \
      >> '$AUD_LOG' 2>&1
  " &
  write_pid "$AUD_PID_FILE" $!
  sleep 3
  audio_status
}

audio_stop() {
  stop_pid "$AUD_PID_FILE" "Audio"
}

audio_restart() {
  audio_stop
  sleep 1
  audio_start
}

audio_status() {
  section "── Audio (STT/TTS) ── port $AUDIO_PORT"
  local pid
  pid=$(read_pid "$AUD_PID_FILE")
  if [[ -n "$pid" ]]; then
    ok "Running — PID $pid"
  else
    warn "Not running (no PID or process dead)"
  fi
  if check_health "http://localhost:$AUDIO_PORT"; then
    :
  else
    warn "Health endpoint unreachable at http://localhost:$AUDIO_PORT/health"
  fi
}

audio_logs() {
  info "Tailing Audio logs — Ctrl+C to stop"
  mkdir -p "$LOG_DIR"
  touch "$AUD_LOG"
  tail -F "$AUD_LOG"
}

audio_transcribe() {
  local file="${1:-}"
  if [[ -z "$file" ]]; then
    fail "Usage: $0 audio transcribe <file.wav|mp3>"
  fi
  [[ -f "$file" ]] || fail "File not found: $file"
  info "Transcribing: $file"
  curl -sf -X POST "http://localhost:$AUDIO_PORT/transcribe" \
    -F "file=@$file" \
    | python3 -m json.tool 2>/dev/null \
    || fail "Request failed. Is Audio running?"
}

audio_tts() {
  local text="${1:-Hello from OpenZigs CUDA audio sidecar}"
  local outfile="/tmp/audio-tts-test-$(date +%s).wav"
  info "TTS: \"$text\""
  local http_code
  http_code=$(curl -sf -X POST "http://localhost:$AUDIO_PORT/tts" \
    -H "Content-Type: application/json" \
    -d "{\"text\":\"$text\"}" \
    --output "$outfile" \
    -w "%{http_code}" 2>/dev/null) \
    || fail "Request failed. Is Audio running?"
  if [[ "$http_code" == "200" ]]; then
    ok "Saved to $outfile"
  else
    fail "HTTP $http_code — check logs: $0 audio logs"
  fi
}

audio_sync() {
  local src="$REPO_SIDECARS/audio/server_cuda.py"
  [[ -f "$src" ]] || fail "Source not found: $src"
  mkdir -p "$AUD_DIR"
  info "Syncing audio/server_cuda.py → $AUD_DIR/server.py"
  cp "$src" "$AUD_DIR/server.py"
  local req="$REPO_SIDECARS/audio/requirements.txt"
  if [[ -f "$req" ]]; then
    info "Syncing audio/requirements.txt → $AUD_DIR/requirements.txt"
    cp "$req" "$AUD_DIR/requirements.txt"
  fi
  ok "Audio synced. Restart to apply: $0 audio restart"
}

# ── LTX Worker (Video Gen) Commands ──────────────────────────────────────────

ltx_start() {
  require_sidecar_dir "$VID_DIR" "Video Worker"
  load_env
  local callback_secret
  callback_secret=$(read_callback_secret)
  mkdir -p "$LOG_DIR" "$PID_DIR"
  info "Starting Video Worker sidecar (port $LTX_PORT)..."
  setsid bash -c "
    cd '$VID_DIR'
    source venv/bin/activate
    HF_TOKEN='${HF_TOKEN:-}' \
    CALLBACK_SECRET='${callback_secret:-}' \
    LTX_SECRET_TOKEN='${LTX_SECRET_TOKEN:-}' \
    LTX_MODEL_KEY='${LTX_MODEL_KEY:-ltxv-13b-097-distilled}' \
    exec python server.py --port $LTX_PORT \
      >> '$VID_LOG' 2>&1
  " &
  write_pid "$VID_PID_FILE" $!
  sleep 3
  ltx_status
}

ltx_stop() {
  stop_pid "$VID_PID_FILE" "LTX Worker"
}

ltx_restart() {
  ltx_stop
  sleep 1
  ltx_start
}

ltx_status() {
  section "── LTX-2 (Video Gen) ── port $LTX_PORT"
  local pid
  pid=$(read_pid "$VID_PID_FILE")
  if [[ -n "$pid" ]]; then
    ok "Running — PID $pid"
  else
    warn "Not running (no PID or process dead)"
  fi
  if check_health "http://localhost:$LTX_PORT"; then
    :
  else
    warn "Health endpoint unreachable at http://localhost:$LTX_PORT/health"
  fi
}

ltx_logs() {
  info "Tailing LTX worker logs — Ctrl+C to stop"
  mkdir -p "$LOG_DIR"
  touch "$VID_LOG"
  tail -F "$VID_LOG"
}

ltx_unload() {
  load_env
  local -a curl_opts=(-sf -X POST "http://localhost:$LTX_PORT/unload" -H "Content-Type: application/json")
  if [[ -n "${LTX_SECRET_TOKEN:-}" ]]; then
    curl_opts+=(-H "Authorization: Bearer $LTX_SECRET_TOKEN")
  fi
  info "Unloading LTX model from VRAM..."
  local response
  response=$(curl "${curl_opts[@]}" 2>/dev/null) \
    || fail "Request failed. Is LTX worker running?"
  echo "$response" | python3 -m json.tool 2>/dev/null || echo "$response"
}

ltx_generate() {
  load_env
  local pipeline="${1:-distilled}"
  local prompt="${2:-A cat sitting on a windowsill watching rain fall outside, cozy atmosphere, warm lighting, photorealistic, cinematic}"
  local audio="${3:-false}"
  local tiling="${4:-aggressive}"
  local job_id
  job_id=$(python3 -c "import uuid; print(uuid.uuid4())")

  case "$pipeline" in
    distilled|dev|dev-two-stage|dev-two-stage-hq) ;;
    *) fail "Unknown pipeline: $pipeline. Valid: distilled|dev|dev-two-stage|dev-two-stage-hq" ;;
  esac

  info "Submitting test job — pipeline=$pipeline audio=$audio tiling=$tiling"
  info "Prompt: \"$prompt\""

  local -a curl_opts=(-s -X POST "http://localhost:$LTX_PORT/generate" -H "Content-Type: application/json")
  if [[ -n "${LTX_SECRET_TOKEN:-}" ]]; then
    curl_opts+=(-H "Authorization: Bearer $LTX_SECRET_TOKEN")
  fi

  local response http_code body
  response=$(curl "${curl_opts[@]}" \
    -d "{
      \"job_id\": \"$job_id\",
      \"type\": \"txt2video\",
      \"prompt\": \"$prompt\",
      \"width\": 512,
      \"height\": 320,
      \"num_frames\": 9,
      \"fps\": 24,
      \"model\": \"ltx-2\",
      \"pipeline\": \"$pipeline\",
      \"audio\": $audio,
      \"tiling\": \"$tiling\",
      \"cfg_scale\": 4.5,
      \"num_inference_steps\": 15,
      \"negative_prompt\": \"worst quality, blurry, distorted\",
      \"callback_url\": \"http://localhost:19999/noop\",
      \"seed\": 42
    }" \
    -w "\n%{http_code}" 2>/dev/null)

  http_code=$(echo "$response" | tail -1)
  body=$(echo "$response" | head -n -1)

  if [[ "$http_code" == "202" ]]; then
    ok "Job accepted (id=$job_id)"
    info "Watch progress: $0 ltx logs"
  else
    fail "HTTP $http_code — $body"
  fi
}

ltx_models() {
  info "Fetching model catalog from http://localhost:$LTX_PORT/models"
  local response
  response=$(curl -sf --max-time 5 "http://localhost:$LTX_PORT/models" 2>/dev/null) \
    || fail "Could not reach /models — is the LTX worker running?"
  echo "$response" | python3 -m json.tool 2>/dev/null || echo "$response"
}

ltx_sync() {
  local src="$REPO_SIDECARS/worker/server_cuda.py"
  [[ -f "$src" ]] || fail "Source not found: $src"
  mkdir -p "$VID_DIR"
  info "Syncing worker/server_cuda.py → $VID_DIR/server.py"
  cp "$src" "$VID_DIR/server.py"
  local req="$REPO_SIDECARS/worker/requirements.txt"
  if [[ -f "$req" ]]; then
    info "Syncing worker/requirements.txt → $VID_DIR/requirements.txt"
    cp "$req" "$VID_DIR/requirements.txt"
  fi
  ok "LTX worker synced. Restart to apply: $0 ltx restart"
}

# ── Music (ACE-Step) Commands ─────────────────────────────────────────────────

music_start() {
  if [[ ! -d "$MUS_DIR" ]]; then
    warn "Music sidecar not deployed ($MUS_DIR missing). Run setup-cuda-sidecars.sh first."
    return
  fi
  if [[ ! -d "$MUS_DIR/venv" ]]; then
    warn "Music venv missing at $MUS_DIR/venv. Run setup-cuda-sidecars.sh first."
    return
  fi
  mkdir -p "$LOG_DIR" "$PID_DIR"
  info "Starting Music sidecar (port $MUSIC_PORT)..."
  setsid bash -c "
    cd '$MUS_DIR'
    source venv/bin/activate
    exec python server.py --port $MUSIC_PORT \
      >> '$MUS_LOG' 2>&1
  " &
  write_pid "$MUS_PID_FILE" $!
  sleep 3
  music_status
}

music_stop() {
  stop_pid "$MUS_PID_FILE" "Music"
}

music_restart() {
  music_stop
  sleep 1
  music_start
}

music_status() {
  section "── Music (ACE-Step) ── port $MUSIC_PORT"
  if [[ ! -d "$MUS_DIR" ]]; then
    warn "Music sidecar not deployed (skipping)"
    return
  fi
  local pid
  pid=$(read_pid "$MUS_PID_FILE")
  if [[ -n "$pid" ]]; then
    ok "Running — PID $pid"
  else
    warn "Not running (no PID or process dead)"
  fi
  if check_health "http://localhost:$MUSIC_PORT"; then
    :
  else
    warn "Health endpoint unreachable at http://localhost:$MUSIC_PORT/health"
  fi
}

music_logs() {
  info "Tailing Music logs — Ctrl+C to stop"
  mkdir -p "$LOG_DIR"
  touch "$MUS_LOG"
  tail -F "$MUS_LOG"
}

music_generate() {
  local prompt="${1:-Upbeat electronic track with driving bass and synth leads}"
  local duration="${2:-10}"
  local outfile="/tmp/music-gen-test-$(date +%s).wav"
  info "Generating music: \"$prompt\" (${duration}s)"
  local http_code
  http_code=$(curl -sf -X POST "http://localhost:$MUSIC_PORT/generate" \
    -H "Content-Type: application/json" \
    -d "{\"prompt\":\"$prompt\",\"duration\":$duration}" \
    --output "$outfile" \
    -w "%{http_code}" 2>/dev/null) \
    || fail "Request failed. Is Music sidecar running?"
  if [[ "$http_code" == "200" || "$http_code" == "202" ]]; then
    ok "Output: $outfile (HTTP $http_code)"
  else
    fail "HTTP $http_code — check logs: $0 music logs"
  fi
}

music_sync() {
  local src="$REPO_SIDECARS/music/server.py"
  [[ -f "$src" ]] || fail "Source not found: $src"
  mkdir -p "$MUS_DIR"
  info "Syncing music/server.py → $MUS_DIR/server.py"
  cp "$src" "$MUS_DIR/server.py"
  local req="$REPO_SIDECARS/music/requirements.txt"
  if [[ -f "$req" ]]; then
    info "Syncing music/requirements.txt → $MUS_DIR/requirements.txt"
    cp "$req" "$MUS_DIR/requirements.txt"
  fi
  ok "Music synced. Restart to apply: $0 music restart"
}

# ── Lip Sync (LatentSync) Commands ────────────────────────────────────────────

lipsync_start() {
  if [[ ! -d "$LIP_DIR" ]]; then
    warn "Lip Sync sidecar not deployed ($LIP_DIR missing). Run setup-cuda-sidecars.sh first."
    return
  fi
  if [[ ! -d "$LIP_DIR/venv" ]]; then
    warn "Lip Sync venv missing at $LIP_DIR/venv. Run setup-cuda-sidecars.sh first."
    return
  fi
  load_env
  local callback_secret
  callback_secret=$(read_callback_secret)
  mkdir -p "$LOG_DIR" "$PID_DIR"
  info "Starting Lip Sync sidecar (port $LIPSYNC_PORT)..."
  setsid bash -c "
    cd '$LIP_DIR'
    source venv/bin/activate
    CALLBACK_SECRET='${callback_secret:-}' \
    LIPSYNC_SECRET_TOKEN='${LIPSYNC_SECRET_TOKEN:-}' \
    exec python server.py --port $LIPSYNC_PORT \
      >> '$LIP_LOG' 2>&1
  " &
  write_pid "$LIP_PID_FILE" $!
  sleep 3
  lipsync_status
}

lipsync_stop() {
  stop_pid "$LIP_PID_FILE" "Lip Sync"
}

lipsync_restart() {
  lipsync_stop
  sleep 1
  lipsync_start
}

lipsync_status() {
  section "── Lip Sync (LatentSync) ── port $LIPSYNC_PORT"
  if [[ ! -d "$LIP_DIR" ]]; then
    warn "Lip Sync sidecar not deployed (skipping)"
    return
  fi
  local pid
  pid=$(read_pid "$LIP_PID_FILE")
  if [[ -n "$pid" ]]; then
    ok "Running — PID $pid"
  else
    warn "Not running (no PID or process dead)"
  fi
  if check_health "http://localhost:$LIPSYNC_PORT"; then
    :
  else
    warn "Health endpoint unreachable at http://localhost:$LIPSYNC_PORT/health"
  fi
}

lipsync_logs() {
  info "Tailing Lip Sync logs — Ctrl+C to stop"
  mkdir -p "$LOG_DIR"
  touch "$LIP_LOG"
  tail -F "$LIP_LOG"
}

lipsync_unload() {
  load_env
  info "Unloading LatentSync model from VRAM..."
  local response
  local auth_header=""
  if [[ -n "${LIPSYNC_SECRET_TOKEN:-}" ]]; then
    auth_header="-H \"Authorization: Bearer $LIPSYNC_SECRET_TOKEN\""
  fi
  response=$(eval curl -sf -X POST "http://localhost:$LIPSYNC_PORT/unload-model" \
    $auth_header 2>/dev/null) \
    || fail "Request failed. Is Lip Sync sidecar running?"
  echo "$response" | python3 -m json.tool 2>/dev/null || echo "$response"
}

lipsync_sync() {
  local src="$REPO_SIDECARS/lipsync/server_cuda.py"
  [[ -f "$src" ]] || fail "Source not found: $src"
  mkdir -p "$LIP_DIR"
  info "Syncing lipsync/server_cuda.py → $LIP_DIR/server.py"
  cp "$src" "$LIP_DIR/server.py"
  local req="$REPO_SIDECARS/lipsync/requirements-cuda.txt"
  if [[ -f "$req" ]]; then
    info "Syncing lipsync/requirements-cuda.txt → $LIP_DIR/requirements.txt"
    cp "$req" "$LIP_DIR/requirements.txt"
  fi
  ok "Lip Sync synced. Restart to apply: $0 lipsync restart"
}

# ── Unified Commands ──────────────────────────────────────────────────────────

cmd_status_all() {
  flux_status
  echo
  audio_status
  echo
  ltx_status
  echo
  music_status
  echo
  lipsync_status
}

cmd_start_all() {
  flux_start
  echo
  audio_start
  echo
  ltx_start
  echo
  music_start
  echo
  lipsync_start
}

cmd_stop_all() {
  flux_stop
  audio_stop
  ltx_stop
  music_stop
  lipsync_stop
}

cmd_restart_all() {
  cmd_stop_all
  sleep 1
  cmd_start_all
}

cmd_sync_all() {
  info "Syncing all CUDA sidecar files from repo..."
  flux_sync
  echo
  audio_sync
  echo
  ltx_sync
  echo
  music_sync
  echo
  lipsync_sync
}

cmd_switch() {
  local target="${1:-}"
  if [[ -z "$target" ]]; then
    fail "Usage: $0 switch <flux|ltx>"
  fi

  case "$target" in
    flux)
      info "Switching to FluxQ (image gen)..."
      # Unload LTX model first to free VRAM
      if curl -sf --max-time 3 "http://localhost:$LTX_PORT/health" >/dev/null 2>&1; then
        info "Unloading LTX model to free VRAM..."
        ltx_unload 2>/dev/null || warn "LTX unload failed (may not have a model loaded)"
      fi
      flux_load_model "${2:-flux-dev}"
      ;;
    ltx)
      info "Switching to LTX-2 (video gen)..."
      # Unload FluxQ first to free VRAM
      load_env
      if curl -sf --max-time 3 "http://localhost:$FLUX_PORT/health" >/dev/null 2>&1; then
        info "Unloading FluxQ model to free VRAM..."
        flux_unload 2>/dev/null || warn "FluxQ unload failed (may not have a model loaded)"
      fi
      ok "VRAM cleared for LTX-2. Model will load on first video generation job."
      ;;
    *)
      fail "Unknown target: $target. Must be 'flux' or 'ltx'."
      ;;
  esac
}

cmd_help() {
  echo -e "${BOLD}cuda-ctl.sh${NC} — Unified CUDA Media Node Control (WSL)"
  echo
  echo -e "  ${BOLD}Per-service commands:${NC}"
  echo -e "    ${CYAN}flux start${NC}                    Start FluxQ image sidecar"
  echo -e "    ${CYAN}flux stop${NC}                     Stop FluxQ sidecar"
  echo -e "    ${CYAN}flux restart${NC}                  Restart FluxQ sidecar"
  echo -e "    ${CYAN}flux status${NC}                   FluxQ process state + /health"
  echo -e "    ${CYAN}flux logs${NC}                     Tail FluxQ logs"
  echo -e "    ${CYAN}flux load [model]${NC}             Load model (flux-schnell|flux-dev)"
  echo -e "    ${CYAN}flux unload${NC}                   Unload model from VRAM"
  echo -e "    ${CYAN}flux generate [prompt]${NC}        Quick test image generation"
  echo -e "    ${CYAN}flux sync${NC}                     Sync server_cuda.py from repo → $SIDECARS_DIR/image-gen"
  echo -e "    ${CYAN}flux clear-cache${NC}              Guidance for clearing HF model cache"
  echo
  echo -e "    ${CYAN}audio start${NC}                   Start Audio (STT/TTS) sidecar"
  echo -e "    ${CYAN}audio stop${NC}                    Stop Audio sidecar"
  echo -e "    ${CYAN}audio restart${NC}                 Restart Audio sidecar"
  echo -e "    ${CYAN}audio status${NC}                  Audio process state + /health"
  echo -e "    ${CYAN}audio logs${NC}                    Tail Audio logs"
  echo -e "    ${CYAN}audio transcribe <file>${NC}       Quick STT smoke test"
  echo -e "    ${CYAN}audio tts [text]${NC}              Quick TTS smoke test"
  echo -e "    ${CYAN}audio sync${NC}                    Sync server_cuda.py from repo → $SIDECARS_DIR/audio"
  echo
  echo -e "    ${CYAN}ltx start${NC}                     Start LTX video worker"
  echo -e "    ${CYAN}ltx stop${NC}                      Stop LTX worker"
  echo -e "    ${CYAN}ltx restart${NC}                   Restart LTX worker"
  echo -e "    ${CYAN}ltx status${NC}                    LTX process state + /health"
  echo -e "    ${CYAN}ltx logs${NC}                      Tail LTX logs"
  echo -e "    ${CYAN}ltx unload${NC}                    Unload model from VRAM"
  echo -e "    ${CYAN}ltx generate [pipeline] [prompt] [audio] [tiling]${NC}"
  echo -e "                                   Quick test video generation"
  echo -e "    ${CYAN}ltx models${NC}                    List available model catalog"
  echo -e "    ${CYAN}ltx sync${NC}                      Sync server_cuda.py from repo → $SIDECARS_DIR/worker"
  echo
  echo -e "    ${CYAN}music start${NC}                   Start ACE-Step music sidecar"
  echo -e "    ${CYAN}music stop${NC}                    Stop music sidecar"
  echo -e "    ${CYAN}music restart${NC}                 Restart music sidecar"
  echo -e "    ${CYAN}music status${NC}                  Music process state + /health"
  echo -e "    ${CYAN}music logs${NC}                    Tail music logs"
  echo -e "    ${CYAN}music generate [prompt] [dur]${NC} Quick test music generation"
  echo -e "    ${CYAN}music sync${NC}                    Sync server.py from repo → $SIDECARS_DIR/music"
  echo
  echo -e "    ${CYAN}lipsync start${NC}                 Start LatentSync lip-sync sidecar"
  echo -e "    ${CYAN}lipsync stop${NC}                  Stop lip-sync sidecar"
  echo -e "    ${CYAN}lipsync restart${NC}               Restart lip-sync sidecar"
  echo -e "    ${CYAN}lipsync status${NC}                Lip-sync process state + /health"
  echo -e "    ${CYAN}lipsync logs${NC}                  Tail lip-sync logs"
  echo -e "    ${CYAN}lipsync unload${NC}                Unload model from VRAM"
  echo -e "    ${CYAN}lipsync sync${NC}                  Sync server_cuda.py from repo → $SIDECARS_DIR/lipsync"
  echo
  echo -e "  ${BOLD}Unified commands:${NC}"
  echo -e "    ${CYAN}status${NC}                        Show status of all services"
  echo -e "    ${CYAN}start${NC}                         Start all services"
  echo -e "    ${CYAN}stop${NC}                          Stop all services"
  echo -e "    ${CYAN}restart${NC}                       Restart all services"
  echo -e "    ${CYAN}sync${NC}                          Sync all server files from repo"
  echo -e "    ${CYAN}switch flux [model]${NC}           Unload LTX, load FluxQ model"
  echo -e "    ${CYAN}switch ltx${NC}                    Unload FluxQ, LTX loads on first job"
  echo
  echo -e "  ${BOLD}Environment:${NC}"
  echo -e "    SIDECARS_DIR   Sidecar install root  (default: ~/openzigs-sidecars)"
  echo -e "    LOG_DIR        Log directory          (default: ~/.openzigs/logs)"
  echo -e "    PID_DIR        PID file directory     (default: ~/.openzigs/pids)"
  echo -e "    FLUX_PORT      FluxQ port             (default: 5005)"
  echo -e "    AUDIO_PORT     Audio port             (default: 5006)"
  echo -e "    LTX_PORT       LTX worker port        (default: 5007)"
  echo -e "    MUSIC_PORT     Music port             (default: 5009)"
  echo -e "    LIPSYNC_PORT   Lip-sync port          (default: 5010)"
  echo
  echo -e "  ${BOLD}Per-machine overrides:${NC}"
  echo -e "    Edit ${CYAN}~/.openzigs/.env.cuda${NC} to set FLUXQ_SECRET_TOKEN, LTX_SECRET_TOKEN,"
  echo -e "    FLUX_DEFAULT_MODEL, LTX_MODEL_KEY, HF_TOKEN, etc."
  echo
  echo -e "  ${YELLOW}Note:${NC} Image and video models both compete for VRAM (RTX 3060 = 12GB)."
  echo -e "        Use 'switch' to hot-swap between flux and ltx."
  echo -e "        Models lazy-load on first request and auto-unload after idle (300s)."
  echo -e "        Video pipelines: distilled (fast/7-step), dev (photorealistic/30-step),"
  echo -e "          dev-two-stage (quality), dev-two-stage-hq (max — needs 16GB+)."
  echo -e "        Run 'ltx models' to see full catalog with memory requirements."
  echo -e "        Audio does NOT support in-video audio generation on CUDA."
}

# ── Service Dispatch ──────────────────────────────────────────────────────────

dispatch_flux() {
  local cmd="${1:-help}"
  shift || true
  case "$cmd" in
    start)       flux_start ;;
    stop)        flux_stop ;;
    restart)     flux_restart ;;
    status)      flux_status ;;
    logs)        flux_logs ;;
    load)        flux_load_model "$@" ;;
    unload)      flux_unload ;;
    generate)    flux_generate "$@" ;;
    sync)        flux_sync ;;
    clear-cache) flux_clear_cache ;;
    help|--help|-h)
      echo -e "Usage: $0 flux <start|stop|restart|status|logs|load|unload|generate|sync|clear-cache>"
      ;;
    *)
      warn "Unknown flux command: $cmd"
      echo -e "Usage: $0 flux <start|stop|restart|status|logs|load|unload|generate|sync|clear-cache>"
      exit 1
      ;;
  esac
}

dispatch_audio() {
  local cmd="${1:-help}"
  shift || true
  case "$cmd" in
    start)       audio_start ;;
    stop)        audio_stop ;;
    restart)     audio_restart ;;
    status)      audio_status ;;
    logs)        audio_logs ;;
    transcribe)  audio_transcribe "$@" ;;
    tts)         audio_tts "$@" ;;
    sync)        audio_sync ;;
    help|--help|-h)
      echo -e "Usage: $0 audio <start|stop|restart|status|logs|transcribe|tts|sync>"
      ;;
    *)
      warn "Unknown audio command: $cmd"
      echo -e "Usage: $0 audio <start|stop|restart|status|logs|transcribe|tts|sync>"
      exit 1
      ;;
  esac
}

dispatch_ltx() {
  local cmd="${1:-help}"
  shift || true
  case "$cmd" in
    start)    ltx_start ;;
    stop)     ltx_stop ;;
    restart)  ltx_restart ;;
    status)   ltx_status ;;
    logs)     ltx_logs ;;
    unload)   ltx_unload ;;
    sync)     ltx_sync ;;
    generate) ltx_generate "$@" ;;
    models)   ltx_models ;;
    help|--help|-h)
      echo -e "Usage: $0 ltx <start|stop|restart|status|logs|unload|sync|generate|models>"
      ;;
    *)
      warn "Unknown ltx command: $cmd"
      echo -e "Usage: $0 ltx <start|stop|restart|status|logs|unload|sync|generate|models>"
      exit 1
      ;;
  esac
}

dispatch_music() {
  local cmd="${1:-help}"
  shift || true
  case "$cmd" in
    start)    music_start ;;
    stop)     music_stop ;;
    restart)  music_restart ;;
    status)   music_status ;;
    logs)     music_logs ;;
    sync)     music_sync ;;
    generate) music_generate "$@" ;;
    help|--help|-h)
      echo -e "Usage: $0 music <start|stop|restart|status|logs|sync|generate>"
      ;;
    *)
      warn "Unknown music command: $cmd"
      echo -e "Usage: $0 music <start|stop|restart|status|logs|sync|generate>"
      exit 1
      ;;
  esac
}

dispatch_lipsync() {
  local cmd="${1:-help}"
  shift || true
  case "$cmd" in
    start)    lipsync_start ;;
    stop)     lipsync_stop ;;
    restart)  lipsync_restart ;;
    status)   lipsync_status ;;
    logs)     lipsync_logs ;;
    sync)     lipsync_sync ;;
    unload)   lipsync_unload ;;
    help|--help|-h)
      echo -e "Usage: $0 lipsync <start|stop|restart|status|logs|sync|unload>"
      ;;
    *)
      warn "Unknown lipsync command: $cmd"
      echo -e "Usage: $0 lipsync <start|stop|restart|status|logs|sync|unload>"
      exit 1
      ;;
  esac
}

# ── Main Dispatch ─────────────────────────────────────────────────────────────

ARG1="${1:-help}"
shift || true

case "$ARG1" in
  flux)    dispatch_flux "$@" ;;
  audio)   dispatch_audio "$@" ;;
  ltx)     dispatch_ltx "$@" ;;
  music)   dispatch_music "$@" ;;
  lipsync) dispatch_lipsync "$@" ;;
  status)  cmd_status_all ;;
  start)   cmd_start_all ;;
  stop)    cmd_stop_all ;;
  restart) cmd_restart_all ;;
  sync)    cmd_sync_all ;;
  switch)  cmd_switch "$@" ;;
  help|--help|-h) cmd_help ;;
  *)
    warn "Unknown command: $ARG1"
    echo
    cmd_help
    exit 1
    ;;
esac
