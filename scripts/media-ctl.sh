#!/usr/bin/env bash
# ─────────────────────────────────────────────────────────────────────────────
# media-ctl.sh — Unified Media Node Control Script
#
# Manages both the FluxQ image-gen sidecar and the LTX video-gen worker
# on the same Mac. Only one model can be loaded at a time (shared VRAM).
#
# Usage:
#   ./scripts/media-ctl.sh <service> <command> [options]
#   ./scripts/media-ctl.sh <command>   (unified commands)
#
# Services:
#   flux               FluxQ image generation sidecar (port 5005)
#   ltx                LTX-2 video generation worker  (port 5007)
#
# Per-service commands:
#   start              Load and start the launchctl job
#   stop               Unload the launchctl job (graceful shutdown)
#   restart            Stop then start
#   status             Show launchctl status + health endpoint
#   logs               Tail server logs (Ctrl+C to exit)
#   unload             Unload the current model from memory
#   sync               Copy server files from the repo to the install dir
#
# Flux-only commands:
#   flux load [model]  Trigger model load (flux-schnell|flux-dev)
#   flux generate [p]  Send a quick test generation request
#   flux clear-cache   Remove cached quantized weights
#
# Unified commands:
#   status             Show status of both services
#   switch <flux|ltx>  Unload competing model and activate the target service
#   help               Show this help message
# ─────────────────────────────────────────────────────────────────────────────
set -euo pipefail

# ── Defaults ──────────────────────────────────────────────────────────────────
FLUXQ_DIR="${FLUXQ_DIR:-$HOME/fluxq-node}"
LTX_DIR="${LTX_DIR:-$HOME/ltx-worker}"

FLUX_PLIST_LABEL="com.openzigs.fluxq"
LTX_PLIST_LABEL="com.openzigs.ltx-worker"
FLUX_PLIST_PATH="$HOME/Library/LaunchAgents/${FLUX_PLIST_LABEL}.plist"
LTX_PLIST_PATH="$HOME/Library/LaunchAgents/${LTX_PLIST_LABEL}.plist"

FLUX_STDOUT_LOG="/tmp/fluxq-stdout.log"
FLUX_STDERR_LOG="/tmp/fluxq-stderr.log"
LTX_STDOUT_LOG="/tmp/ltx-worker-stdout.log"
LTX_STDERR_LOG="/tmp/ltx-worker-stderr.log"

# ── Colors ────────────────────────────────────────────────────────────────────
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
CYAN='\033[0;36m'
BOLD='\033[1m'
NC='\033[0m'

info()    { echo -e "${CYAN}[media]${NC} $*"; }
ok()      { echo -e "${GREEN}[media]${NC} $*"; }
warn()    { echo -e "${YELLOW}[media]${NC} $*"; }
fail()    { echo -e "${RED}[media]${NC} $*" >&2; exit 1; }
section() { echo -e "\n${BOLD}$*${NC}"; }

# ── Helpers ───────────────────────────────────────────────────────────────────

load_flux_env() {
  local env_file="$FLUXQ_DIR/.env"
  if [[ -f "$env_file" ]]; then
    set -a; source "$env_file"; set +a
  fi
}

load_ltx_env() {
  local env_file="$LTX_DIR/.env"
  if [[ -f "$env_file" ]]; then
    set -a; source "$env_file"; set +a
  fi
}

require_flux_token() {
  load_flux_env
  if [[ -z "${FLUXQ_SECRET_TOKEN:-}" ]]; then
    fail "FLUXQ_SECRET_TOKEN not set. Add it to $FLUXQ_DIR/.env"
  fi
}

require_ltx_token() {
  load_ltx_env
  if [[ -z "${LTX_SECRET_TOKEN:-}" ]]; then
    fail "LTX_SECRET_TOKEN not set. Add it to $LTX_DIR/.env"
  fi
}

flux_api_url() {
  load_flux_env
  local host="${IMAGE_GEN_HOST:-0.0.0.0}"
  [[ "$host" == "0.0.0.0" ]] && host="127.0.0.1"
  echo "http://${host}:${IMAGE_GEN_PORT:-5005}"
}

ltx_api_url() {
  load_ltx_env
  local host="${M2_PRO_HOST:-0.0.0.0}"
  [[ "$host" == "0.0.0.0" ]] && host="127.0.0.1"
  echo "http://${host}:${M2_PRO_PORT:-5007}"
}

check_flux_plist() {
  if [[ ! -f "$FLUX_PLIST_PATH" ]]; then
    fail "FluxQ plist not found at $FLUX_PLIST_PATH — run setup-fluxq-node.sh first"
  fi
}

check_ltx_plist() {
  if [[ ! -f "$LTX_PLIST_PATH" ]]; then
    fail "LTX plist not found at $LTX_PLIST_PATH — run setup-ltx-node.sh first"
  fi
}

# ── FluxQ Commands ────────────────────────────────────────────────────────────

flux_start() {
  check_flux_plist
  info "Loading launchctl job: $FLUX_PLIST_LABEL"
  launchctl load "$FLUX_PLIST_PATH" 2>/dev/null || warn "Job may already be loaded"
  # Kickstart bypasses macOS Sequoia speculative spawn scheduling (RunAtLoad alone
  # doesn't guarantee an immediate start for non-interactive LaunchAgents).
  launchctl kickstart -k "gui/$(id -u)/$FLUX_PLIST_LABEL" 2>/dev/null || true
  sleep 3
  flux_status
}

flux_stop() {
  check_flux_plist
  info "Unloading launchctl job: $FLUX_PLIST_LABEL"
  launchctl unload "$FLUX_PLIST_PATH" 2>/dev/null || warn "Job may not have been loaded"
  ok "FluxQ stopped."
}

flux_restart() {
  flux_stop
  sleep 1
  flux_start
}

flux_status() {
  section "── FluxQ (Image Gen) ──"
  local lc_out
  lc_out=$(launchctl list | grep "$FLUX_PLIST_LABEL" 2>/dev/null || true)
  if [[ -z "$lc_out" ]]; then
    warn "Job not loaded."
  else
    echo "$lc_out"
    local pid
    pid=$(echo "$lc_out" | awk '{print $1}')
    [[ "$pid" != "-" ]] && ok "PID: $pid" || warn "Job loaded but not running (last exit: $(echo "$lc_out" | awk '{print $2}'))"
  fi

  local url
  url=$(flux_api_url)
  local health
  if health=$(curl -sf --max-time 3 "$url/health" 2>/dev/null); then
    echo "$health" | python3 -m json.tool 2>/dev/null || echo "$health"
  else
    warn "Health endpoint unreachable at $url/health"
  fi
}

flux_logs() {
  info "Tailing FluxQ logs — Ctrl+C to stop"
  tail -F "$FLUX_STDERR_LOG" "$FLUX_STDOUT_LOG" 2>/dev/null
}

flux_load_model() {
  require_flux_token
  local model="${1:-flux-schnell}"
  local url
  url=$(flux_api_url)
  info "Requesting FluxQ model load: $model"
  local response
  response=$(curl -sf -X POST "$url/model" \
    -H "Authorization: Bearer $FLUXQ_SECRET_TOKEN" \
    -H "Content-Type: application/json" \
    -d "{\"model\":\"$model\"}" 2>/dev/null) \
    || fail "Request failed. Is FluxQ running? Try: $0 flux status"
  echo "$response" | python3 -m json.tool 2>/dev/null || echo "$response"
  echo
  ok "Model load triggered (MFLUX/MLX — typically 30-60s)."
}

flux_unload() {
  require_flux_token
  local url
  url=$(flux_api_url)
  info "Unloading FluxQ model..."
  local response
  response=$(curl -sf -X POST "$url/unload" \
    -H "Authorization: Bearer $FLUXQ_SECRET_TOKEN" \
    -H "Content-Type: application/json" \
    -d '{}' 2>/dev/null) \
    || fail "Request failed. Is FluxQ running?"
  echo "$response" | python3 -m json.tool 2>/dev/null || echo "$response"
}

flux_generate() {
  require_flux_token
  local url
  url=$(flux_api_url)
  local prompt="${1:-A majestic mountain at sunrise, photorealistic}"
  local outfile="/tmp/fluxq-test-$(date +%s).png"
  info "Generating image with prompt: \"$prompt\""
  info "Output: $outfile"
  local http_code
  http_code=$(curl -sf -X POST "$url/generate" \
    -H "Authorization: Bearer $FLUXQ_SECRET_TOKEN" \
    -H "Content-Type: application/json" \
    -d "{\"prompt\":\"$prompt\",\"width\":512,\"height\":512,\"steps\":4}" \
    --output "$outfile" \
    -w "%{http_code}" 2>/dev/null) \
    || fail "Request failed. Is a model loaded? Run: $0 flux load"
  if [[ "$http_code" == "200" ]]; then
    ok "Saved to $outfile"
    command -v open >/dev/null 2>&1 && open "$outfile"
  else
    fail "HTTP $http_code — check logs: $0 flux logs"
  fi
}

flux_sync() {
  local script_dir
  script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
  local src="$script_dir/../sidecars/image-gen/server.py"
  if [[ ! -f "$src" ]]; then
    fail "Source not found: $src"
  fi
  local req_src="$script_dir/../sidecars/image-gen/requirements.txt"
  info "Syncing server.py → $FLUXQ_DIR/server.py"
  cp "$src" "$FLUXQ_DIR/server.py"
  if [[ -f "$req_src" ]]; then
    info "Syncing requirements.txt → $FLUXQ_DIR/requirements.txt"
    cp "$req_src" "$FLUXQ_DIR/requirements.txt"
  fi
  ok "FluxQ synced. Restart to apply: $0 flux restart"
}

flux_clear_cache() {
  local cache_dir="${FLUXQ_CACHE_DIR:-$HOME/.cache/fluxq-quantized}"
  if [[ ! -d "$cache_dir" ]]; then
    info "No quantization cache found at $cache_dir"
    return
  fi
  local size
  size=$(du -sh "$cache_dir" 2>/dev/null | awk '{print $1}')
  info "Removing quantization cache at $cache_dir ($size) ..."
  rm -rf "$cache_dir"
  ok "Cache cleared. Next model load will re-quantize."
}

# ── LTX Worker Commands ──────────────────────────────────────────────────────

ltx_start() {
  check_ltx_plist
  # Apply sysctl GPU wired memory tuning (non-destructive, resets on reboot)
  local current_wired
  current_wired=$(sysctl -n iogpu.wired_limit_mb 2>/dev/null || echo "0")
  if [[ "$current_wired" -lt 28672 ]]; then
    info "Setting iogpu.wired_limit_mb=28672 (currently $current_wired) — may require sudo"
    sudo sysctl iogpu.wired_limit_mb=28672 2>/dev/null || warn "Could not set sysctl — GPU timeouts may occur. Run: sudo sysctl iogpu.wired_limit_mb=28672"
  fi
  info "Loading launchctl job: $LTX_PLIST_LABEL"
  launchctl load "$LTX_PLIST_PATH" 2>/dev/null || warn "Job may already be loaded"
  # Kickstart bypasses macOS Sequoia speculative spawn scheduling.
  launchctl kickstart -k "gui/$(id -u)/$LTX_PLIST_LABEL" 2>/dev/null || true
  sleep 3
  ltx_status
}

ltx_stop() {
  check_ltx_plist
  info "Unloading launchctl job: $LTX_PLIST_LABEL"
  launchctl unload "$LTX_PLIST_PATH" 2>/dev/null || warn "Job may not have been loaded"
  ok "LTX worker stopped."
}

ltx_restart() {
  ltx_stop
  sleep 1
  ltx_start
}

ltx_status() {
  section "── LTX-2 (Video Gen) ──"
  local lc_out
  lc_out=$(launchctl list | grep "$LTX_PLIST_LABEL" 2>/dev/null || true)
  if [[ -z "$lc_out" ]]; then
    warn "Job not loaded."
  else
    echo "$lc_out"
    local pid
    pid=$(echo "$lc_out" | awk '{print $1}')
    [[ "$pid" != "-" ]] && ok "PID: $pid" || warn "Job loaded but not running (last exit: $(echo "$lc_out" | awk '{print $2}'))"
  fi

  local url
  url=$(ltx_api_url)
  local health
  if health=$(curl -sf --max-time 3 "$url/health" 2>/dev/null); then
    echo "$health" | python3 -m json.tool 2>/dev/null || echo "$health"
  else
    warn "Health endpoint unreachable at $url/health"
  fi
}

ltx_logs() {
  info "Tailing LTX worker logs — Ctrl+C to stop"
  tail -F "$LTX_STDERR_LOG" "$LTX_STDOUT_LOG" 2>/dev/null
}

ltx_unload() {
  load_ltx_env
  local url
  url=$(ltx_api_url)
  local headers=""
  if [[ -n "${LTX_SECRET_TOKEN:-}" ]]; then
    headers="-H \"Authorization: Bearer $LTX_SECRET_TOKEN\""
  fi
  info "Unloading LTX model..."
  local response
  response=$(curl -sf -X POST "$url/unload" \
    -H "Content-Type: application/json" \
    ${LTX_SECRET_TOKEN:+-H "Authorization: Bearer $LTX_SECRET_TOKEN"} \
    2>/dev/null) \
    || fail "Request failed. Is LTX worker running?"
  echo "$response" | python3 -m json.tool 2>/dev/null || echo "$response"
}

ltx_sync() {
  local script_dir
  script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
  local src="$script_dir/../sidecars/worker/server.py"
  if [[ ! -f "$src" ]]; then
    fail "Source not found: $src"
  fi
  local req_src="$script_dir/../sidecars/worker/requirements.txt"
  info "Syncing server.py → $LTX_DIR/server.py"
  cp "$src" "$LTX_DIR/server.py"
  if [[ -f "$req_src" ]]; then
    info "Syncing requirements.txt → $LTX_DIR/requirements.txt"
    cp "$req_src" "$LTX_DIR/requirements.txt"
  fi
  ok "LTX worker synced. Restart to apply: $0 ltx restart"
}

ltx_generate() {
  load_ltx_env
  local url
  url=$(ltx_api_url)
  local pipeline="${1:-dev}"
  local prompt="${2:-A cat sitting on a windowsill watching rain fall outside, cozy atmosphere, warm lighting, photorealistic, cinematic}"
  local job_id
  job_id=$(python3 -c "import uuid; print(uuid.uuid4())")

  info "Submitting test job — pipeline=$pipeline"
  info "Prompt: \"$prompt\""

  local response http_code body
  response=$(curl -s -X POST "$url/generate" \
    ${LTX_SECRET_TOKEN:+-H "Authorization: Bearer $LTX_SECRET_TOKEN"} \
    -H "Content-Type: application/json" \
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
    info "Video saves to $(ltx_api_url)/... when complete — or use tmp/test_ltx_video.py for full callback handling"
  else
    fail "HTTP $http_code — $body"
  fi
}

# ── Unified Commands ─────────────────────────────────────────────────────────

cmd_status_all() {
  flux_status
  echo
  ltx_status
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
      local ltx_url
      ltx_url=$(ltx_api_url)
      if curl -sf --max-time 3 "$ltx_url/health" >/dev/null 2>&1; then
        info "Unloading LTX model to free VRAM..."
        ltx_unload 2>/dev/null || warn "LTX unload failed (may not have a model loaded)"
      fi
      # Load FluxQ model
      flux_load_model "${2:-flux-schnell}"
      ;;
    ltx)
      info "Switching to LTX-2 (video gen)..."
      # Unload FluxQ model first to free VRAM
      local flux_url
      flux_url=$(flux_api_url)
      load_flux_env
      if curl -sf --max-time 3 "$flux_url/health" >/dev/null 2>&1; then
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

# ── Unified sync ─────────────────────────────────────────────────────────────

cmd_sync_all() {
  info "Syncing FluxQ files..."
  flux_sync
  echo
  info "Syncing LTX worker files..."
  ltx_sync
}

cmd_help() {
  echo -e "${BOLD}media-ctl.sh${NC} — Unified Media Node Control"
  echo
  echo -e "  ${BOLD}Per-service commands:${NC}"
  echo -e "    ${CYAN}flux start${NC}           Start FluxQ sidecar (launchctl)"
  echo -e "    ${CYAN}flux stop${NC}            Stop FluxQ sidecar"
  echo -e "    ${CYAN}flux restart${NC}         Restart FluxQ sidecar"
  echo -e "    ${CYAN}flux status${NC}          FluxQ launchctl state + /health"
  echo -e "    ${CYAN}flux logs${NC}            Tail FluxQ logs"
  echo -e "    ${CYAN}flux load [model]${NC}    Load a model (flux-schnell|flux-dev)"
  echo -e "    ${CYAN}flux unload${NC}          Unload model from VRAM"
  echo -e "    ${CYAN}flux generate [p]${NC}    Quick test generation"
  echo -e "    ${CYAN}flux sync${NC}            Sync server.py from repo → ~/fluxq-node"
  echo -e "    ${CYAN}flux clear-cache${NC}     Remove quantized weight cache"
  echo
  echo -e "    ${CYAN}ltx start${NC}            Start LTX worker (launchctl + sysctl GPU tuning)"
  echo -e "    ${CYAN}ltx stop${NC}             Stop LTX worker"
  echo -e "    ${CYAN}ltx restart${NC}          Restart LTX worker"
  echo -e "    ${CYAN}ltx status${NC}           LTX launchctl state + /health"
  echo -e "    ${CYAN}ltx logs${NC}             Tail LTX worker logs"
  echo -e "    ${CYAN}ltx unload${NC}           Unload model from VRAM"
  echo -e "    ${CYAN}ltx sync${NC}             Sync server.py from repo → ~/ltx-worker"
  echo -e "    ${CYAN}ltx generate [p] [t]${NC} Quick test: pipeline (dev|distilled) + prompt"
  echo
  echo -e "  ${BOLD}Unified commands:${NC}"
  echo -e "    ${CYAN}status${NC}               Show status of both services"
  echo -e "    ${CYAN}sync${NC}                 Sync both FluxQ and LTX server files from repo"
  echo -e "    ${CYAN}switch flux [model]${NC}  Unload LTX, load FluxQ model"
  echo -e "    ${CYAN}switch ltx${NC}           Unload FluxQ, LTX loads on first job"
  echo
  echo -e "  ${BOLD}Environment:${NC}"
  echo -e "    FLUXQ_DIR   FluxQ install dir  (default: ~/fluxq-node)"
  echo -e "    LTX_DIR     LTX install dir    (default: ~/ltx-worker)"
  echo
  echo -e "  ${YELLOW}Note:${NC} Both services share M2 unified memory."
  echo -e "        Only one model can be loaded at a time."
  echo -e "        Video gen supports 'distilled' (fast) and 'dev' (photorealistic) pipelines."
  echo -e "        On M2 Pro 32GB, DEV pipeline max resolution is 512x320."
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
    help|--help|-h)
      echo -e "Usage: $0 ltx <start|stop|restart|status|logs|unload|sync|generate>"
      ;;
    *)
      warn "Unknown ltx command: $cmd"
      echo -e "Usage: $0 ltx <start|stop|restart|status|logs|unload|sync|generate>"
      exit 1
      ;;
  esac
}

# ── Main Dispatch ─────────────────────────────────────────────────────────────

ARG1="${1:-help}"
shift || true

case "$ARG1" in
  flux)    dispatch_flux "$@" ;;
  ltx)     dispatch_ltx "$@" ;;
  status)  cmd_status_all ;;
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
