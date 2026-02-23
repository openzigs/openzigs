#!/usr/bin/env bash
# ─────────────────────────────────────────────────────────────────────────────
# fluxq-ctl.sh — FluxQ Node Control Script
#
# Convenience wrapper for managing the local FluxQ image-generation sidecar.
# Assumes the node is installed at ~/fluxq-node (default) or FLUXQ_DIR.
#
# Usage:
#   ./scripts/fluxq-ctl.sh <command> [options]
#
# Commands:
#   start          Load and start the launchctl job
#   stop           Unload the launchctl job (graceful shutdown)
#   restart        Stop then start
#   status         Show launchctl status + health endpoint
#   logs           Tail server logs (Ctrl+C to exit)
#   load [model]   Trigger model load (flux|sdxl-turbo, default: flux)
#   unload         Unload the current model from memory
#   generate       Send a quick test generation request
#   sync           Copy server.py from the repo to ~/fluxq-node
# ─────────────────────────────────────────────────────────────────────────────
set -euo pipefail

FLUXQ_DIR="${FLUXQ_DIR:-$HOME/fluxq-node}"
PLIST_LABEL="com.openzigs.fluxq"
PLIST_PATH="$HOME/Library/LaunchAgents/${PLIST_LABEL}.plist"
STDOUT_LOG="/tmp/fluxq-stdout.log"
STDERR_LOG="/tmp/fluxq-stderr.log"

# ── Colors ────────────────────────────────────────────────────────────────────
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
CYAN='\033[0;36m'
BOLD='\033[1m'
NC='\033[0m'

info()    { echo -e "${CYAN}[fluxq]${NC} $*"; }
ok()      { echo -e "${GREEN}[fluxq]${NC} $*"; }
warn()    { echo -e "${YELLOW}[fluxq]${NC} $*"; }
fail()    { echo -e "${RED}[fluxq]${NC} $*" >&2; exit 1; }
section() { echo -e "\n${BOLD}$*${NC}"; }

# ── Helpers ───────────────────────────────────────────────────────────────────

load_env() {
  local env_file="$FLUXQ_DIR/.env"
  if [[ -f "$env_file" ]]; then
    # shellcheck source=/dev/null
    set -a; source "$env_file"; set +a
  else
    warn ".env not found at $env_file — some commands may fail"
  fi
}

require_token() {
  load_env
  if [[ -z "${FLUXQ_SECRET_TOKEN:-}" ]]; then
    fail "FLUXQ_SECRET_TOKEN not set. Add it to $FLUXQ_DIR/.env"
  fi
}

api_url() {
  local host="${IMAGE_GEN_HOST:-0.0.0.0}"
  # Use localhost for curl even when server binds to 0.0.0.0
  [[ "$host" == "0.0.0.0" ]] && host="127.0.0.1"
  echo "http://${host}:${IMAGE_GEN_PORT:-5005}"
}

check_plist() {
  if [[ ! -f "$PLIST_PATH" ]]; then
    fail "Plist not found at $PLIST_PATH — run setup-fluxq-node.sh first"
  fi
}

# ── Commands ──────────────────────────────────────────────────────────────────

cmd_start() {
  check_plist
  info "Loading launchctl job: $PLIST_LABEL"
  launchctl load "$PLIST_PATH" 2>/dev/null || warn "Job may already be loaded"
  sleep 1
  cmd_status
}

cmd_stop() {
  check_plist
  info "Unloading launchctl job: $PLIST_LABEL"
  launchctl unload "$PLIST_PATH" 2>/dev/null || warn "Job may not have been loaded"
  ok "Stopped."
}

cmd_restart() {
  cmd_stop
  sleep 1
  cmd_start
}

cmd_status() {
  section "── launchctl ──"
  local lc_out
  lc_out=$(launchctl list | grep "$PLIST_LABEL" 2>/dev/null || true)
  if [[ -z "$lc_out" ]]; then
    warn "Job not loaded."
  else
    echo "$lc_out"
    local pid
    pid=$(echo "$lc_out" | awk '{print $1}')
    [[ "$pid" != "-" ]] && ok "PID: $pid" || warn "Job loaded but not running (last exit: $(echo "$lc_out" | awk '{print $2}'))"
  fi

  section "── health ──"
  load_env
  local url
  url=$(api_url)
  local health
  if health=$(curl -sf --max-time 3 "$url/health" 2>/dev/null); then
    echo "$health" | python3 -m json.tool 2>/dev/null || echo "$health"
  else
    warn "Health endpoint unreachable at $url/health"
  fi
}

cmd_logs() {
  info "Tailing $STDERR_LOG and $STDOUT_LOG — Ctrl+C to stop"
  tail -F "$STDERR_LOG" "$STDOUT_LOG" 2>/dev/null
}

cmd_load_model() {
  require_token
  local model="${1:-flux-schnell}"
  local url
  url=$(api_url)
  info "Requesting model load: $model"
  local response
  response=$(curl -sf -X POST "$url/model" \
    -H "Authorization: Bearer $FLUXQ_SECRET_TOKEN" \
    -H "Content-Type: application/json" \
    -d "{\"model\":\"$model\"}" 2>/dev/null) \
    || fail "Request failed. Is the server running? Try: ./scripts/fluxq-ctl.sh status"
  echo "$response" | python3 -m json.tool 2>/dev/null || echo "$response"
  echo
  ok "Model load triggered (MFLUX/MLX — typically 30-60s)."
  info "Watch progress: ./scripts/fluxq-ctl.sh logs"
}

cmd_unload() {
  require_token
  local url
  url=$(api_url)
  info "Unloading model..."
  local response
  response=$(curl -sf -X POST "$url/unload" \
    -H "Authorization: Bearer $FLUXQ_SECRET_TOKEN" \
    -H "Content-Type: application/json" \
    -d '{}' 2>/dev/null) \
    || fail "Request failed. Is the server running?"
  echo "$response" | python3 -m json.tool 2>/dev/null || echo "$response"
}

cmd_generate() {
  require_token
  local url
  url=$(api_url)
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
    || fail "Request failed. Is a model loaded? Run: ./scripts/fluxq-ctl.sh load"
  if [[ "$http_code" == "200" ]]; then
    ok "Saved to $outfile"
    command -v open >/dev/null 2>&1 && open "$outfile"
  else
    fail "HTTP $http_code — check logs: ./scripts/fluxq-ctl.sh logs"
  fi
}

cmd_sync() {
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
  ok "Synced. Restart to apply: ./scripts/fluxq-ctl.sh restart"
}

cmd_clear_cache() {
  local cache_dir="${FLUXQ_CACHE_DIR:-$HOME/.cache/fluxq-quantized}"
  if [[ ! -d "$cache_dir" ]]; then
    info "No quantization cache found at $cache_dir"
    return
  fi
  local size
  size=$(du -sh "$cache_dir" 2>/dev/null | awk '{print $1}')
  info "Removing quantization cache at $cache_dir ($size) ..."
  rm -rf "$cache_dir"
  ok "Cache cleared. Next model load will re-quantize and rebuild cache."
}

cmd_help() {
  echo -e "${BOLD}fluxq-ctl.sh${NC} — FluxQ Node Control"
  echo
  echo "  ${CYAN}start${NC}              Load launchctl job and start server"
  echo "  ${CYAN}stop${NC}               Unload launchctl job (graceful)"
  echo "  ${CYAN}restart${NC}            Stop then start"
  echo "  ${CYAN}status${NC}             launchctl state + /health endpoint"
  echo "  ${CYAN}logs${NC}               Tail stdout + stderr logs"
  echo "  ${CYAN}load [model]${NC}       Trigger model load (flux-schnell|flux-dev) [default: flux-schnell]"
  echo "  ${CYAN}unload${NC}             Release model from memory"
  echo "  ${CYAN}generate [prompt]${NC}  Send a test generation request"
  echo "  ${CYAN}sync${NC}               Copy server.py from repo to ~/fluxq-node"
  echo "  ${CYAN}clear-cache${NC}        Remove cached quantized weights (forces re-quantization)"
  echo
  echo "Environment:"
  echo "  FLUXQ_DIR   Installation directory (default: ~/fluxq-node)"
}

# ── Dispatch ──────────────────────────────────────────────────────────────────

COMMAND="${1:-help}"
shift || true

case "$COMMAND" in
  start)    cmd_start ;;
  stop)     cmd_stop ;;
  restart)  cmd_restart ;;
  status)   cmd_status ;;
  logs)     cmd_logs ;;
  load)     cmd_load_model "$@" ;;
  unload)   cmd_unload ;;
  generate) cmd_generate "$@" ;;
  sync)     cmd_sync ;;
  clear-cache) cmd_clear_cache ;;
  help|--help|-h) cmd_help ;;
  *)
    warn "Unknown command: $COMMAND"
    echo
    cmd_help
    exit 1
    ;;
esac
