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
LIPSYNC_DIR="${LIPSYNC_DIR:-$HOME/lipsync-worker}"

FLUX_PLIST_LABEL="com.openzigs.fluxq"
LTX_PLIST_LABEL="com.openzigs.ltx-worker"
LIPSYNC_PLIST_LABEL="com.openzigs.lipsync"
FLUX_PLIST_PATH="$HOME/Library/LaunchAgents/${FLUX_PLIST_LABEL}.plist"
LTX_PLIST_PATH="$HOME/Library/LaunchAgents/${LTX_PLIST_LABEL}.plist"
LIPSYNC_PLIST_PATH="$HOME/Library/LaunchAgents/${LIPSYNC_PLIST_LABEL}.plist"

FLUX_STDOUT_LOG="/tmp/fluxq-stdout.log"
FLUX_STDERR_LOG="/tmp/fluxq-stderr.log"
LTX_STDOUT_LOG="/tmp/ltx-worker-stdout.log"
LTX_STDERR_LOG="/tmp/ltx-worker-stderr.log"
LIPSYNC_STDOUT_LOG="/tmp/lipsync-stdout.log"
LIPSYNC_STDERR_LOG="/tmp/lipsync-stderr.log"

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

load_lipsync_env() {
  local env_file="$LIPSYNC_DIR/.env"
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

require_lipsync_token() {
  load_lipsync_env
  if [[ -z "${LIPSYNC_SECRET_TOKEN:-}" ]]; then
    fail "LIPSYNC_SECRET_TOKEN not set. Add it to $LIPSYNC_DIR/.env"
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

lipsync_api_url() {
  load_lipsync_env
  echo "http://127.0.0.1:5012"
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

check_lipsync_plist() {
  if [[ ! -f "$LIPSYNC_PLIST_PATH" ]]; then
    info "Lipsync plist not found — creating $LIPSYNC_PLIST_PATH"
    local venv="$LIPSYNC_DIR/.venv-mps/bin/python"
    if [[ ! -f "$venv" ]]; then
      fail "Venv not found at $LIPSYNC_DIR/.venv-mps — run: lipsync setup first"
    fi
    mkdir -p ~/Library/LaunchAgents
    cat > "$LIPSYNC_PLIST_PATH" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN"
  "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>       <string>${LIPSYNC_PLIST_LABEL}</string>
  <key>ProgramArguments</key>
  <array>
    <string>${venv}</string>
    <string>${LIPSYNC_DIR}/server.py</string>
    <string>--port</string><string>5012</string>
  </array>
  <key>WorkingDirectory</key> <string>${LIPSYNC_DIR}</string>
  <key>EnvironmentVariables</key>
  <dict>
    <key>PATH</key><string>/usr/bin:/bin:/usr/sbin:/sbin:/opt/homebrew/bin</string>
    <key>PYTORCH_ENABLE_MPS_FALLBACK</key><string>1</string>
  </dict>
  <key>KeepAlive</key>    <true/>
  <key>RunAtLoad</key>    <false/>
  <key>StandardOutPath</key> <string>${LIPSYNC_STDOUT_LOG}</string>
  <key>StandardErrorPath</key><string>${LIPSYNC_STDERR_LOG}</string>
  <key>ThrottleInterval</key><integer>10</integer>
</dict>
</plist>
PLIST
    ok "Created plist at $LIPSYNC_PLIST_PATH"
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
  local path_utils_src="$script_dir/../sidecars/image-gen/path_utils.py"
  local shared_dir="$script_dir/../sidecars/_shared"
  info "Syncing server.py → $FLUXQ_DIR/server.py"
  cp "$src" "$FLUXQ_DIR/server.py"
  if [[ -f "$req_src" ]]; then
    info "Syncing requirements.txt → $FLUXQ_DIR/requirements.txt"
    cp "$req_src" "$FLUXQ_DIR/requirements.txt"
  fi
  if [[ -f "$path_utils_src" ]]; then
    info "Syncing path_utils.py → $FLUXQ_DIR/path_utils.py"
    cp "$path_utils_src" "$FLUXQ_DIR/path_utils.py"
  fi
  for _shared_mod in signed_callback.py callback_validator.py; do
    if [[ -f "$shared_dir/$_shared_mod" ]]; then
      info "Syncing $_shared_mod → $FLUXQ_DIR/$_shared_mod"
      cp "$shared_dir/$_shared_mod" "$FLUXQ_DIR/$_shared_mod"
    fi
  done
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
  local -a curl_opts=(-sf -X POST "$url/unload" -H "Content-Type: application/json")
  if [[ -n "${LTX_SECRET_TOKEN:-}" ]]; then
    curl_opts+=(-H "Authorization: Bearer $LTX_SECRET_TOKEN")
  fi
  info "Unloading LTX model..."
  local response
  response=$(curl "${curl_opts[@]}" 2>/dev/null) \
    || fail "Request failed. Is LTX worker running?"
  echo "$response" | python3 -m json.tool 2>/dev/null || echo "$response"
}

# ── Lipsync Commands ──────────────────────────────────────────────────────────

lipsync_setup() {
  # Bootstrap ~/lipsync-worker from repo sources.  Idempotent — safe to re-run.
  local script_dir
  script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
  local src_dir="$script_dir/../sidecars/lipsync"
  local shared_dir="$script_dir/../sidecars/_shared"

  info "Setting up lipsync-worker at $LIPSYNC_DIR"
  mkdir -p "$LIPSYNC_DIR"

  # Core files
  cp "$src_dir/server.py"               "$LIPSYNC_DIR/server.py"
  cp "$src_dir/requirements-mps.txt"    "$LIPSYNC_DIR/requirements-mps.txt"
  [[ -f "$src_dir/.env.example" ]] && cp "$src_dir/.env.example" "$LIPSYNC_DIR/.env.example"
  for _m in signed_callback.py callback_validator.py; do
    [[ -f "$shared_dir/$_m" ]] && cp "$shared_dir/$_m" "$LIPSYNC_DIR/$_m"
  done

  # .env — create if missing
  if [[ ! -f "$LIPSYNC_DIR/.env" ]]; then
    local token
    token=$(python3 -c "import secrets; print(secrets.token_hex(32))")
    local cb_secret=""
    [[ -f "$HOME/.openzigs/worker-secret" ]] && cb_secret=$(cat "$HOME/.openzigs/worker-secret")
    {
      echo "LIPSYNC_SECRET_TOKEN=$token"
      echo "CALLBACK_SECRET=${cb_secret}"
      echo "CALLBACK_URL=http://localhost:3000/api/queue/complete"
      echo "PROGRESS_URL=http://localhost:3000/api/queue/progress"
    } > "$LIPSYNC_DIR/.env"
    chmod 600 "$LIPSYNC_DIR/.env"
    ok "Generated .env with new LIPSYNC_SECRET_TOKEN (edit CALLBACK_URL if using tunnel)"
  else
    info ".env already exists — not overwriting"
  fi

  # Venv
  local venv="$LIPSYNC_DIR/.venv-mps"
  if [[ ! -f "$venv/bin/python" ]]; then
    info "Creating .venv-mps..."
    local py=""
    # LatentSync's dependency stack still needs Python 3.11 on macOS arm64:
    # decord has no usable wheels for Python 3.12/3.14 here.
    for c in python3.11 python3.10 python3.12 python3; do
      command -v "$c" >/dev/null 2>&1 && py="$c" && break
    done
    [[ -z "$py" ]] && fail "Python 3.10+ not found. Install: brew install python@3.11"
    "$py" -m venv "$venv"
  fi

  info "Installing requirements-mps.txt (first run takes a few minutes)..."
  "$venv/bin/python" -m pip install --upgrade pip --quiet 2>/dev/null
  if ! "$venv/bin/python" -m pip install -r "$LIPSYNC_DIR/requirements-mps.txt" --quiet 2>&1 | tail -5; then
    warn "Full requirements install failed; retrying without decord (no macOS arm64 PyPI wheel)."
    local filtered_req
    filtered_req="$TMPDIR/lipsync-requirements-mps-no-decord.txt"
    grep -v '^decord' "$LIPSYNC_DIR/requirements-mps.txt" > "$filtered_req"
    "$venv/bin/python" -m pip install -r "$filtered_req" --quiet 2>&1 | tail -5
  fi

  # MPS check
  if "$venv/bin/python" -c "import torch; assert torch.backends.mps.is_available()" 2>/dev/null; then
    ok "MPS available"
  else
    warn "torch reports MPS unavailable — will fall back to CPU (slow)"
  fi

  # ── Model setup ─────────────────────────────────────────────────────────────
  # The sidecar's subprocess fallback needs:
  #   $LATENTSYNC_DIR/inference.py          ← from GitHub source clone
  #   $LATENTSYNC_DIR/configs/latentsync_unet_v1.5.yaml  ← versioned symlink
  #   $LATENTSYNC_DIR/checkpoints/latentsync_unet_v1.5.pt ← versioned symlink
  local latentsync_dir="${LATENTSYNC_DIR:-$HOME/.openzigs/models/latentsync}"

  # 1. Clone LatentSync source (scripts/inference.py, configs/, latentsync/ package, etc.)
  # inference.py lives in scripts/ subdirectory, not the repo root.
  if [[ ! -f "$latentsync_dir/scripts/inference.py" ]]; then
    info "Cloning LatentSync source → $latentsync_dir ..."
    if command -v git >/dev/null 2>&1; then
      if [[ -d "$latentsync_dir/.git" ]]; then
        git -C "$latentsync_dir" pull --ff-only --quiet 2>/dev/null || true
      else
        rm -rf "$latentsync_dir"
        git clone --depth 1 https://github.com/bytedance/LatentSync "$latentsync_dir" 2>&1 | tail -3 \
          || warn "git clone failed — jobs will error until LatentSync source is available"
      fi
    else
      warn "git not found — install git and re-run 'lipsync setup'"
    fi
  else
    info "LatentSync source already present at $latentsync_dir"
  fi

  # 1b. Apply MPS compatibility patches to the LatentSync source clone.
  # These fix:
  #   - decord (unavailable on macOS ARM) — wrapped in try/except with stubs
  #   - device hardcoded to "cuda" → auto-detected (mps/cuda/cpu)
  #   - cuda_to_int() + insightface providers for MPS/CPU
  #   - ImageProcessor receives actual pipeline device instead of "cuda"
  if [[ -f "$latentsync_dir/scripts/inference.py" ]]; then
    "$venv/bin/python" - "$latentsync_dir" <<'PATCHEOF'
import os, sys, re, py_compile

base = sys.argv[1]

def patch(relpath, old, new, label):
    p = os.path.join(base, relpath)
    if not os.path.exists(p): return
    src = open(p).read()
    if old in src:
        open(p, "w").write(src.replace(old, new))
        print(f"  patched: {relpath} ({label})")

# util.py — decord stub
decord_stub = (
    "try:\n"
    "    from decord import AudioReader, VideoReader\n"
    "except ImportError:\n"
    "    class AudioReader:\n"
    "        def __init__(self, *a, **kw): raise RuntimeError(\"decord unavailable\")\n"
    "    class VideoReader:\n"
    "        def __init__(self, *a, **kw): raise RuntimeError(\"decord unavailable\")"
)
patch("latentsync/utils/util.py", "from decord import AudioReader, VideoReader", decord_stub, "decord stub")

# inference.py — MPS device detection
inf_path = os.path.join(base, "scripts", "inference.py")
if os.path.exists(inf_path):
    src = open(inf_path).read()
    if "MPS_PATCH_APPLIED" not in src:
        src = src.replace("import torch\n",
            'import torch\n# MPS_PATCH_APPLIED\n'
            '_device = "mps" if torch.backends.mps.is_available() else ("cuda" if torch.cuda.is_available() else "cpu")\n'
            'print(f"LatentSync using device: {_device}")\n')
        src = src.replace('device="cuda"', 'device=_device')
        src = src.replace('.to("cuda")', '.to(_device)')
        open(inf_path, "w").write(src)
        print("  patched: scripts/inference.py (MPS device)")

# face_detector.py — cuda_to_int + providers
patch("latentsync/utils/face_detector.py",
    'if device.type != "cuda":\n        raise ValueError(f"Device type must be \'cuda\', got: {device.type}")\n    return device.index',
    'if device.type == "cuda":\n        return device.index if device.index is not None else 0\n    return -1  # CPU/MPS',
    "cuda_to_int MPS")
patch("latentsync/utils/face_detector.py",
    'providers=["CUDAExecutionProvider"],',
    'providers=(["CUDAExecutionProvider", "CoreMLExecutionProvider", "CPUExecutionProvider"] if __import__("torch").cuda.is_available() else ["CoreMLExecutionProvider", "CPUExecutionProvider"]),',
    "providers MPS")

# lipsync_pipeline.py — fix ImageProcessor device
patch("latentsync/pipelines/lipsync_pipeline.py",
    'ImageProcessor(height, device="cuda", mask_image=mask_image)',
    'ImageProcessor(height, device=str(device), mask_image=mask_image)',
    "ImageProcessor device")

print("  MPS patches complete.")
PATCHEOF
  else
    warn "LatentSync source not present — skipping patches. Re-run setup after clone."
  fi

  # 2. Download checkpoint weights to expected path
  # HF repo names it latentsync_unet.pt; the inference script (configs/unet/stage2.yaml) also
  # expects checkpoints/latentsync_unet.pt — no versioned rename needed.
  mkdir -p "$latentsync_dir/checkpoints"
  local ckpt="$latentsync_dir/checkpoints/latentsync_unet.pt"
  if [[ ! -e "$ckpt" ]]; then
    info "Downloading LatentSync-1.5 checkpoint weights..."
    HF_TOKEN="${HF_TOKEN:-}" "$venv/bin/python" - <<'PYEOF'
import os, sys
from pathlib import Path
latentsync_dir = os.environ.get("LATENTSYNC_DIR", str(Path.home() / ".openzigs" / "models" / "latentsync"))
dst = Path(latentsync_dir) / "checkpoints"
dst.mkdir(parents=True, exist_ok=True)
try:
    from huggingface_hub import hf_hub_download
    hf_hub_download("ByteDance/LatentSync-1.5", filename="latentsync_unet.pt",
                    local_dir=str(dst), local_dir_use_symlinks=True)
    hf_hub_download("ByteDance/LatentSync-1.5", filename="stable_syncnet.pt",
                    local_dir=str(dst), local_dir_use_symlinks=True)
    print("Checkpoints ready.")
except Exception as e:
    print(f"WARNING: {e}", file=sys.stderr)
    sys.exit(1)
PYEOF
    [[ $? -ne 0 ]] && warn "Checkpoint download failed — jobs will fail until checkpoints/ are populated"
  else
    info "Checkpoint already present at $ckpt"
  fi

  # 3. Download auxiliary files (whisper encoder, syncnet scorer)
  HF_TOKEN="${HF_TOKEN:-}" "$venv/bin/python" - <<'PYEOF'
import os
from pathlib import Path
latentsync_dir = os.environ.get("LATENTSYNC_DIR", str(Path.home() / ".openzigs" / "models" / "latentsync"))
d = Path(latentsync_dir)
try:
    from huggingface_hub import hf_hub_download
    for fname in ["whisper/tiny.pt", "auxiliary/syncnet_v2.model"]:
        dest = d / fname
        if not dest.exists():
            dest.parent.mkdir(parents=True, exist_ok=True)
            hf_hub_download("ByteDance/LatentSync-1.5", filename=fname,
                            local_dir=str(d), local_dir_use_symlinks=True)
            print(f"Downloaded: {dest}")
except Exception as e:
    print(f"Warning: auxiliary download failed ({e}) — some metrics may be unavailable")
PYEOF

  check_lipsync_plist
  ok "Lipsync-worker ready. Start with: $0 lipsync start"
}

lipsync_sync() {
  local script_dir
  script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
  local src_dir="$script_dir/../sidecars/lipsync"
  local shared_dir="$script_dir/../sidecars/_shared"
  [[ ! -f "$src_dir/server.py" ]] && fail "Source not found: $src_dir/server.py"
  info "Syncing server.py → $LIPSYNC_DIR/server.py"
  cp "$src_dir/server.py" "$LIPSYNC_DIR/server.py"
  [[ -f "$src_dir/requirements-mps.txt" ]] && {
    info "Syncing requirements-mps.txt"
    cp "$src_dir/requirements-mps.txt" "$LIPSYNC_DIR/requirements-mps.txt"
  }
  for _m in signed_callback.py callback_validator.py; do
    [[ -f "$shared_dir/$_m" ]] && {
      info "Syncing $_m"
      cp "$shared_dir/$_m" "$LIPSYNC_DIR/$_m"
    }
  done
  ok "Lipsync synced. Restart to apply: $0 lipsync restart"
}

lipsync_start() {
  check_lipsync_plist
  info "Loading launchctl job: $LIPSYNC_PLIST_LABEL"
  launchctl load "$LIPSYNC_PLIST_PATH" 2>/dev/null || warn "Job may already be loaded"
  launchctl kickstart -k "gui/$(id -u)/$LIPSYNC_PLIST_LABEL" 2>/dev/null || true
  sleep 3
  lipsync_status
}

lipsync_stop() {
  check_lipsync_plist
  info "Unloading launchctl job: $LIPSYNC_PLIST_LABEL"
  launchctl unload "$LIPSYNC_PLIST_PATH" 2>/dev/null || warn "Job may not have been loaded"
  ok "Lipsync stopped."
}

lipsync_restart() {
  lipsync_stop
  sleep 1
  lipsync_start
}

lipsync_status() {
  load_lipsync_env
  section "── Lipsync (LatentSync, port 5012) ──"
  local lc_out
  lc_out=$(launchctl list | grep "$LIPSYNC_PLIST_LABEL" 2>/dev/null || true)
  if [[ -z "$lc_out" ]]; then
    warn "Job not loaded."
  else
    echo "$lc_out"
    local pid
    pid=$(echo "$lc_out" | awk '{print $1}')
    [[ "$pid" != "-" ]] && ok "PID: $pid" || \
      warn "Job loaded but not running (last exit: $(echo "$lc_out" | awk '{print $2}'))"
  fi
  local url
  url=$(lipsync_api_url)
  local health
  local -a curl_opts=(-sf --max-time 3 "$url/health")
  if [[ -n "${LIPSYNC_SECRET_TOKEN:-}" ]]; then
    curl_opts+=(-H "Authorization: Bearer $LIPSYNC_SECRET_TOKEN")
  fi
  if health=$(curl "${curl_opts[@]}" 2>/dev/null); then
    echo "$health" | python3 -m json.tool 2>/dev/null || echo "$health"
  else
    warn "Health endpoint unreachable at $url/health"
  fi
}

lipsync_logs() {
  info "Tailing lipsync logs — Ctrl+C to stop"
  tail -F "$LIPSYNC_STDERR_LOG" "$LIPSYNC_STDOUT_LOG" 2>/dev/null
}

lipsync_unload() {
  require_lipsync_token
  local url
  url=$(lipsync_api_url)
  info "Unloading lipsync model..."
  local response
  response=$(curl -sf -X POST "$url/unload-model" \
    -H "Authorization: Bearer $LIPSYNC_SECRET_TOKEN" \
    -H "Content-Type: application/json" \
    -d '{}' 2>/dev/null) \
    || fail "Request failed. Is lipsync running?"
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
  local pipeline="${1:-distilled}"
  local prompt="${2:-A cat sitting on a windowsill watching rain fall outside, cozy atmosphere, warm lighting, photorealistic, cinematic}"
  local audio="${3:-false}"
  local tiling="${4:-aggressive}"
  local job_id
  job_id=$(python3 -c "import uuid; print(uuid.uuid4())")

  # Validate pipeline
  case "$pipeline" in
    distilled|dev|dev-two-stage|dev-two-stage-hq) ;;
    *) fail "Unknown pipeline: $pipeline. Valid: distilled|dev|dev-two-stage|dev-two-stage-hq" ;;
  esac

  info "Submitting test job — pipeline=$pipeline audio=$audio tiling=$tiling"
  info "Prompt: \"$prompt\""

  local -a curl_opts=(-s -X POST "$url/generate" -H "Content-Type: application/json")
  if [[ -n "${LTX_SECRET_TOKEN:-}" ]]; then
    curl_opts+=(-H "Authorization: Bearer $LTX_SECRET_TOKEN")
  fi

  # Use low resolution/frames for quick smoke test
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
    info "Video saves when sidecar POSTs to callback_url. Use a real callback for full output."
  else
    fail "HTTP $http_code — $body"
  fi
}

ltx_models() {
  local url
  url=$(ltx_api_url)
  info "Fetching model catalog from $url/models"
  local response
  response=$(curl -sf --max-time 5 "$url/models" 2>/dev/null) \
    || fail "Could not reach $url/models — is the LTX worker running?"
  echo "$response" | python3 -m json.tool 2>/dev/null || echo "$response"
}

# ── Unified Commands ─────────────────────────────────────────────────────────

cmd_status_all() {
  flux_status
  echo
  ltx_status
  echo
  lipsync_status
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
  echo
  info "Syncing lipsync files..."
  lipsync_sync
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
  echo -e "    ${CYAN}ltx generate [pipeline] [prompt] [audio] [tiling]${NC} Quick test generation"
  echo -e "    ${CYAN}ltx models${NC}           List available LTX model catalog from worker"
  echo
  echo -e "    ${CYAN}lipsync setup${NC}        Bootstrap ~/lipsync-worker (venv + deps + model)"
  echo -e "    ${CYAN}lipsync start${NC}        Start lipsync sidecar (launchctl)"
  echo -e "    ${CYAN}lipsync stop${NC}         Stop lipsync sidecar"
  echo -e "    ${CYAN}lipsync restart${NC}      Restart lipsync sidecar"
  echo -e "    ${CYAN}lipsync status${NC}       Launchctl state + /health"
  echo -e "    ${CYAN}lipsync logs${NC}         Tail lipsync logs"
  echo -e "    ${CYAN}lipsync unload${NC}       Unload model from RAM"
  echo -e "    ${CYAN}lipsync sync${NC}         Sync server.py from repo → ~/lipsync-worker"
  echo
  echo -e "  ${BOLD}Unified commands:${NC}"
  echo -e "    ${CYAN}status${NC}               Show status of all three services"
  echo -e "    ${CYAN}sync${NC}                 Sync all three server files from repo"
  echo -e "    ${CYAN}switch flux [model]${NC}  Unload LTX, load FluxQ model"
  echo -e "    ${CYAN}switch ltx${NC}           Unload FluxQ, LTX loads on first job"
  echo
  echo -e "  ${BOLD}Environment:${NC}"
  echo -e "    FLUXQ_DIR      FluxQ install dir     (default: ~/fluxq-node)"
  echo -e "    LTX_DIR        LTX install dir       (default: ~/ltx-worker)"
  echo -e "    LIPSYNC_DIR    Lipsync install dir   (default: ~/lipsync-worker)"
  echo
  echo -e "  ${YELLOW}Note:${NC} All three services share M2 unified memory."
  echo -e "        Only one model can be loaded at a time."
  echo -e "        Video gen pipelines: distilled (fast), dev (photorealistic),"
  echo -e "          dev-two-stage (quality), dev-two-stage-hq (max quality)."
  echo -e "        Run 'ltx models' to see the full model catalog with memory requirements."
  echo -e "        On M2 Pro 32GB, 2-stage pipelines max out at 768x512."
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

dispatch_lipsync() {
  local cmd="${1:-help}"
  shift || true
  case "$cmd" in
    setup)   lipsync_setup ;;
    start)   lipsync_start ;;
    stop)    lipsync_stop ;;
    restart) lipsync_restart ;;
    status)  lipsync_status ;;
    logs)    lipsync_logs ;;
    unload)  lipsync_unload ;;
    sync)    lipsync_sync ;;
    help|--help|-h)
      echo -e "Usage: $0 lipsync <setup|start|stop|restart|status|logs|unload|sync>"
      ;;
    *)
      warn "Unknown lipsync command: $cmd"
      echo -e "Usage: $0 lipsync <setup|start|stop|restart|status|logs|unload|sync>"
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
  lipsync) dispatch_lipsync "$@" ;;
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
