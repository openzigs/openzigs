#!/bin/bash
set -e

# ── ANSI Colors ───────────────────────────────────────────────────────────────
RED='\033[0;31m'
YELLOW='\033[1;33m'
GREEN='\033[0;32m'
CYAN='\033[0;36m'
BOLD='\033[1m'
RESET='\033[0m'

# ── Banner ────────────────────────────────────────────────────────────────────
print_banner() {
  echo ""
  echo -e "${CYAN}${BOLD}"
  echo "   ___                ______              "
  echo "  / _ \\ _ __  ___ _ _|__  (_) __ _ ___   "
  echo " | | | | '_ \\/ _ \\ '_ \\/ /| |/ _\` / __| "
  echo " | |_| | |_) |  __/ | | / /_| | (_| \\__ \\"
  echo "  \\___/| .__/ \\___|_| /_\\__|_|\\__, |___/ "
  echo "       |_|                    |___/       "
  echo -e "${RESET}"
  echo "  Local-first AI agent platform"
  echo ""
}

# ── Prerequisites ─────────────────────────────────────────────────────────────
check_prerequisites() {
  local failed=0

  if ! command -v docker >/dev/null 2>&1; then
    echo -e "${RED}Error: Docker is required. Install from https://docker.com${RESET}"
    failed=1
  fi

  if ! docker compose version >/dev/null 2>&1; then
    echo -e "${RED}Error: Docker Compose v2 is required. Install Docker Desktop or the Compose plugin.${RESET}"
    failed=1
  fi

  if ! command -v git >/dev/null 2>&1; then
    echo -e "${RED}Error: git is required to clone the repository.${RESET}"
    failed=1
  fi

  [ "$failed" -eq 1 ] && exit 1
}

# ── Converter tool prerequisites ──────────────────────────────────────────────
install_converter_deps_with_brew() {
  echo ""
  echo -e "${BOLD}=== Converter Tool Dependencies ===${RESET}"
  echo "  ffmpeg, imagemagick, and ghostscript are needed for media/document conversion."
  echo "  (Required for local pnpm dev; bundled in Docker for container usage.)"
  echo ""

  local missing=0
  command -v ffmpeg >/dev/null 2>&1 || missing=1
  command -v magick >/dev/null 2>&1 || missing=1
  command -v gs     >/dev/null 2>&1 || missing=1

  if [ "$missing" -eq 0 ]; then
    echo -e "  ${GREEN}✓ All converter dependencies already installed${RESET}"
    return
  fi

  if command -v brew >/dev/null 2>&1; then
    printf "  Install missing converter dependencies with Homebrew? [Y/n]: "
    read -r install_now
    if [ -z "$install_now" ] || [ "$install_now" = "y" ] || [ "$install_now" = "Y" ]; then
      brew install ffmpeg imagemagick ghostscript || true
    else
      echo -e "  ${YELLOW}⚠ Skipped — install manually: brew install ffmpeg imagemagick ghostscript${RESET}"
    fi
  else
    echo -e "  ${YELLOW}⚠ Homebrew not found. Install manually:${RESET}"
    echo "      brew install ffmpeg imagemagick ghostscript"
  fi
}

install_converter_deps_with_brew

# ── Sidecar Selection Menu ────────────────────────────────────────────────────
INSTALL_AUDIO=0
INSTALL_IMAGE_GEN=0
INSTALL_MUSIC=0
INSTALL_MUSIC_STUDIO=0
INSTALL_WORKER=0
INSTALL_GPTSOVITS=0
INSTALL_LIPSYNC=0

show_sidecar_menu() {
  echo ""
  echo -e "${BOLD}=== AI Sidecar Selection ===${RESET}"
  echo ""
  echo "  OpenZigs ships with optional AI capability sidecars."
  echo "  All are optimised for Apple Silicon (MLX / Metal)."
  echo "  Any sidecar can be installed later by re-running install.sh."
  echo ""
  echo "  # | Sidecar                  | Port | ~Disk    | Features"
  echo "  --+--------------------------+------+----------+----------------------------------------------"
  echo "  1 | Audio (STT + TTS)        | 5006 | ~2 GB    | Voice input/output, Whisper transcription,"
  echo "    |                          |      |          | Kokoro TTS, Engine A voice gen"
  echo "  --+--------------------------+------+----------+----------------------------------------------"
  echo "  2 | Image Generation (MFLUX) | 5005 | ~25+ GB  | Flux.1 Schnell/Dev, LoRA (DreamBooth),"
  echo "    |                          |      | per model| ControlNet (Canny/Depth)"
  echo "  --+--------------------------+------+----------+----------------------------------------------"
  echo "  3 | Music Generation         | 5009 | ~10+ GB  | ACE-Step 1.5 AI music from text/lyrics"
  echo "    | (ACE-Step 1.5)           |      |          | REQUIRES Python 3.11.x exactly"
  echo "  --+--------------------------+------+----------+----------------------------------------------"
  echo "  4 | Music Studio             | 5010 | ~5 GB    | Demucs stem separation, Seed-VC voice"
  echo "    |                          |      |          | conversion, AI Remix Lab, mastering"
  echo "  --+--------------------------+------+----------+----------------------------------------------"
  echo "  5 | Video Generation (LTX)   | 5007 | ~10+ GB  | LTX-Video on Apple Silicon"
  echo "    |                          |      |          | Recommended: M2 Pro or higher, 32+ GB RAM"
  echo "  --+--------------------------+------+----------+----------------------------------------------"
  echo "  6 | Voice Cloning            |  --  | ~4 GB    | GPT-SoVITS Engine B: high-fidelity custom"
  echo "    | (GPT-SoVITS)             |      |          | voice models from short audio clips"
  echo "  --+--------------------------+------+----------+----------------------------------------------"
  echo "  7 | Lip Sync (LatentSync)    | 5012 | ~3 GB    | LatentSync v1.5 (8 GB resident) on MPS;"
  echo "    |                          |      |          | v1.6 requires ≥24 GB RAM — use remote node."
  echo "  --+--------------------------+------+----------+----------------------------------------------"
  echo ""
  echo -e "  ${YELLOW}Total disk if all selected: ~52+ GB of model downloads.${RESET}"
  echo -e "  ${YELLOW}Models stored in ~/.cache/huggingface and ~/.openzigs/.${RESET}"
  echo ""
  echo "  Enter sidecar numbers (e.g.  1 4  or  1,4,6), [A]ll, or [S]kip all:"
  printf "  Selection: "
  read -r sidecar_choice

  case "$sidecar_choice" in
    [Aa]*)
      INSTALL_AUDIO=1
      INSTALL_IMAGE_GEN=1
      INSTALL_MUSIC=1
      INSTALL_MUSIC_STUDIO=1
      INSTALL_WORKER=1
      INSTALL_GPTSOVITS=1
      INSTALL_LIPSYNC=1
      ;;
    [Ss]*)
      echo ""
      echo -e "  ${YELLOW}Skipping all sidecars. Core text/tool agent will work without them.${RESET}"
      ;;
    *)
      local nums="${sidecar_choice//,/ }"
      for n in $nums; do
        case "$n" in
          1) INSTALL_AUDIO=1 ;;
          2) INSTALL_IMAGE_GEN=1 ;;
          3) INSTALL_MUSIC=1 ;;
          4) INSTALL_MUSIC_STUDIO=1 ;;
          5) INSTALL_WORKER=1 ;;
          6) INSTALL_GPTSOVITS=1 ;;
          7) INSTALL_LIPSYNC=1 ;;
          *) echo -e "  ${YELLOW}Warning: Unknown option '$n' — skipped.${RESET}" ;;
        esac
      done
      ;;
  esac

  echo ""
  echo -e "${BOLD}  Selected for installation:${RESET}"
  [ "$INSTALL_AUDIO" -eq 1 ]        && echo -e "    ${GREEN}✓${RESET} Audio (STT + TTS)"
  [ "$INSTALL_IMAGE_GEN" -eq 1 ]    && echo -e "    ${GREEN}✓${RESET} Image Generation (MFLUX / Flux.1)"
  [ "$INSTALL_MUSIC" -eq 1 ]        && echo -e "    ${GREEN}✓${RESET} Music Generation (ACE-Step 1.5)"
  [ "$INSTALL_MUSIC_STUDIO" -eq 1 ] && echo -e "    ${GREEN}✓${RESET} Music Studio (Voice2Voice + Remix Lab)"
  [ "$INSTALL_WORKER" -eq 1 ]       && echo -e "    ${GREEN}✓${RESET} Video Generation (LTX-Video)"
  [ "$INSTALL_GPTSOVITS" -eq 1 ]    && echo -e "    ${GREEN}✓${RESET} Voice Cloning (GPT-SoVITS)"
  [ "$INSTALL_LIPSYNC" -eq 1 ]      && echo -e "    ${GREEN}✓${RESET} Lip Sync (LatentSync, MPS)"

  local any_selected=$(( INSTALL_AUDIO + INSTALL_IMAGE_GEN + INSTALL_MUSIC + \
                         INSTALL_MUSIC_STUDIO + INSTALL_WORKER + INSTALL_GPTSOVITS + \
                         INSTALL_LIPSYNC ))
  [ "$any_selected" -eq 0 ] && echo -e "    ${YELLOW}None — core text/tool agent only${RESET}"
}

# ── Sidecar: Audio (STT + TTS) ────────────────────────────────────────────────
install_sidecar_audio() {
  local BASE_DIR="$1"
  local AUDIO_DIR="$BASE_DIR/sidecars/audio"

  if [ ! -f "$AUDIO_DIR/server.py" ]; then
    echo -e "  ${RED}✗ Audio sidecar source not found at $AUDIO_DIR${RESET}"
    return 1
  fi

  echo ""
  echo -e "${BOLD}=== Installing Audio Sidecar (STT + TTS) — port 5006 ===${RESET}"
  echo "  Speech-to-text: Whisper distil-large-v3 (~1.5 GB, downloads on first use)"
  echo "  Text-to-speech: Kokoro-82M (~330 MB, downloads on first use)"
  echo "  Runtime: Apple Silicon MLX (lightning-whisper-mlx, mlx-audio)"
  echo ""

  local VENV_DIR="$AUDIO_DIR/.venv"
  local PY=""
  for candidate in python3.12 python3.11 python3.10 python3; do
    if command -v "$candidate" >/dev/null 2>&1; then
      PY="$candidate"
      break
    fi
  done

  if [ -z "$PY" ]; then
    echo -e "  ${RED}✗ Python 3.10+ not found. Install: brew install python@3.12${RESET}"
    return 1
  fi

  local REQ_FILE="$AUDIO_DIR/requirements-mac.txt"
  [ ! -f "$REQ_FILE" ] && REQ_FILE="$AUDIO_DIR/requirements.txt"

  if [ ! -d "$VENV_DIR" ]; then
    echo "  Creating venv with $PY..."
    "$PY" -m venv "$VENV_DIR"
  fi

  echo "  Installing dependencies (first run may take a few minutes)..."
  "$VENV_DIR/bin/python" -m pip install --upgrade pip --quiet 2>/dev/null
  "$VENV_DIR/bin/python" -m pip install -r "$REQ_FILE" --quiet 2>&1 | tail -5

  echo -e "  ${GREEN}✓ Audio sidecar ready${RESET}"
  echo "    Both models (~2 GB total) download automatically on first use."
  echo "    Start: $AUDIO_DIR/.venv/bin/python $AUDIO_DIR/server.py"
}

# ── Sidecar: Image Generation (MFLUX / Flux.1) ───────────────────────────────
install_sidecar_image_gen() {
  local BASE_DIR="$1"
  local IG_DIR="$BASE_DIR/sidecars/image-gen"

  if [ ! -f "$IG_DIR/server.py" ]; then
    echo -e "  ${RED}✗ Image gen sidecar not found at $IG_DIR${RESET}"
    return 1
  fi

  echo ""
  echo -e "${BOLD}=== Installing Image Generation Sidecar (MFLUX / Flux.1) — port 5005 ===${RESET}"
  echo "  AI image generation using Apple Silicon MLX (MFLUX)."
  echo "  Supports: Flux.1 Schnell (~20 GB fast), Flux.1 Dev (~23 GB quality),"
  echo "            LoRA fine-tuning (DreamBooth), ControlNet (Canny/Depth)."
  echo ""

  local VENV_DIR="$IG_DIR/.venv"
  local PY=""
  for candidate in python3.12 python3.11 python3.10 python3; do
    if command -v "$candidate" >/dev/null 2>&1; then
      PY="$candidate"
      break
    fi
  done

  if [ -z "$PY" ]; then
    echo -e "  ${RED}✗ Python 3.10+ not found. Install: brew install python@3.12${RESET}"
    return 1
  fi

  if [ ! -d "$VENV_DIR" ]; then
    echo "  Creating venv with $PY..."
    "$PY" -m venv "$VENV_DIR"
  fi

  echo "  Installing MFLUX and dependencies..."
  "$VENV_DIR/bin/python" -m pip install --upgrade pip --quiet 2>/dev/null
  "$VENV_DIR/bin/python" -m pip install -r "$IG_DIR/requirements.txt" --quiet 2>&1 | tail -5

  echo ""
  echo -e "  ${YELLOW}Flux.1 model pre-download (optional — models are ~20-23 GB each):${RESET}"
  echo "    Flux.1 Schnell (~20 GB) — fast generation, commercial-friendly licence"
  echo "    Flux.1 Dev     (~23 GB) — higher quality, non-commercial licence"
  echo "  Models download from Hugging Face automatically on first generate request."
  echo ""
  printf "  Pre-download Flux.1 Schnell (~20 GB) now? [y/N]: "
  read -r dl_flux
  if [ "$dl_flux" = "y" ] || [ "$dl_flux" = "Y" ]; then
    echo "  Downloading Flux.1 Schnell (4-bit quantized) — this will take a while..."
    "$VENV_DIR/bin/python" -c \
      "from mflux import Flux1; Flux1.from_name('flux-schnell', quantize=4)" \
      || echo -e "  ${YELLOW}⚠ Download failed or interrupted. Run manually later.${RESET}"
  else
    echo -e "  ${YELLOW}Skipped — Flux.1 downloads automatically on first generate request.${RESET}"
  fi

  echo -e "  ${GREEN}✓ Image generation sidecar ready${RESET}"
  echo "    Start: $IG_DIR/.venv/bin/python $IG_DIR/server.py"
  echo "    Configure: Admin → Image Generation (port 5005)"
}

# ── Sidecar: Music Generation (ACE-Step 1.5) ─────────────────────────────────
install_sidecar_music() {
  local BASE_DIR="$1"
  local MUSIC_DIR="$BASE_DIR/sidecars/music"

  if [ ! -f "$MUSIC_DIR/server.py" ]; then
    echo -e "  ${RED}✗ Music sidecar not found at $MUSIC_DIR${RESET}"
    return 1
  fi

  echo ""
  echo -e "${BOLD}=== Installing Music Generation Sidecar (ACE-Step 1.5) — port 5009 ===${RESET}"
  echo "  AI music generation from text and lyric prompts on Apple Silicon."
  echo "  Model: ACE-Step 1.5 (~10-15 GB, downloads on first request)."
  echo ""
  echo -e "  ${YELLOW}REQUIREMENT: Python 3.11.x (exactly) + uv package manager${RESET}"
  echo "  Uses a forked ACE-Step repo optimised for Apple Silicon."
  echo ""

  local PY311=""
  for candidate in python3.11 /opt/homebrew/bin/python3.11 /usr/local/bin/python3.11; do
    if command -v "$candidate" >/dev/null 2>&1; then
      local ver
      ver=$("$candidate" --version 2>&1 | grep -oE '3\.11\.[0-9]+' || true)
      if [ -n "$ver" ]; then
        PY311="$candidate"
        break
      fi
    fi
  done

  if [ -z "$PY311" ]; then
    echo -e "  ${YELLOW}Python 3.11.x not found.${RESET}"
    if command -v brew >/dev/null 2>&1; then
      printf "  Install Python 3.11 via Homebrew now? [Y/n]: "
      read -r install_py311
      if [ -z "$install_py311" ] || [ "$install_py311" = "y" ] || [ "$install_py311" = "Y" ]; then
        brew install python@3.11
        PY311="/opt/homebrew/bin/python3.11"
      else
        echo -e "  ${RED}✗ Skipping Music Generation — Python 3.11.x is required.${RESET}"
        echo "    To install later: brew install python@3.11, then re-run install.sh."
        return 1
      fi
    else
      echo -e "  ${RED}✗ Install Python 3.11.x manually, then re-run install.sh.${RESET}"
      return 1
    fi
  fi

  if ! command -v uv >/dev/null 2>&1; then
    echo "  uv package manager not found — installing..."
    if command -v brew >/dev/null 2>&1; then
      brew install uv || curl -LsSf https://astral.sh/uv/install.sh | sh
    else
      curl -LsSf https://astral.sh/uv/install.sh | sh
    fi
  fi

  local ACE_DIR="$HOME/ace-step-apple-silicon"
  if [ ! -d "$ACE_DIR" ]; then
    echo "  Cloning ACE-Step Apple Silicon fork to $ACE_DIR..."
    git clone --depth 1 \
      https://github.com/clockworksquirrel/ace-step-apple-silicon.git \
      "$ACE_DIR"
  else
    echo -e "  ${GREEN}✓ ACE-Step fork already at $ACE_DIR${RESET}"
  fi

  echo "  Running uv sync in ACE-Step directory (may take a few minutes)..."
  (cd "$ACE_DIR" && uv sync) || {
    echo -e "  ${RED}✗ uv sync failed in $ACE_DIR — check the output above.${RESET}"
    return 1
  }

  local VENV_DIR="$MUSIC_DIR/.venv"
  if [ ! -d "$VENV_DIR" ]; then
    echo "  Creating Music sidecar venv with Python 3.11..."
    "$PY311" -m venv "$VENV_DIR"
  fi

  echo "  Installing sidecar dependencies..."
  "$VENV_DIR/bin/python" -m pip install --upgrade pip --quiet 2>/dev/null
  "$VENV_DIR/bin/python" -m pip install -r "$MUSIC_DIR/requirements.txt" --quiet 2>&1 | tail -5

  echo -e "  ${GREEN}✓ Music generation sidecar ready${RESET}"
  echo "    ACE-Step model (~10-15 GB) downloads automatically on first request."
  echo "    Start: $MUSIC_DIR/.venv/bin/python $MUSIC_DIR/server.py"
  echo "    Configure: Admin → Music Generation Node (port 5009)"
}

# ── Sidecar: Music Studio (Voice2Voice + Remix Lab) ───────────────────────────
install_sidecar_music_studio() {
  local BASE_DIR="$1"
  local MS_DIR="$BASE_DIR/sidecars/music-studio"

  if [ ! -f "$MS_DIR/server.py" ]; then
    echo -e "  ${RED}✗ Music Studio sidecar not found at $MS_DIR${RESET}"
    return 1
  fi

  echo ""
  echo -e "${BOLD}=== Installing Music Studio Sidecar — port 5010 ===${RESET}"
  echo "  Provides:"
  echo "    * Stem separation (Demucs v4) — vocals, drums, bass, other"
  echo "    * Voice-to-Voice conversion (Seed-VC, ~2 GB Hugging Face download)"
  echo "    * AI Remix Lab — instrument replacement, FX presets, track analysis"
  echo "    * Audio mastering (matchering + pyloudnorm)"
  echo "  System tools required: ffmpeg, fluidsynth"
  echo ""

  local VENV_DIR="$MS_DIR/.venv"
  local PY=""
  for candidate in python3.12 python3.11 python3.10 python3; do
    if command -v "$candidate" >/dev/null 2>&1; then
      PY="$candidate"
      break
    fi
  done

  if [ -z "$PY" ]; then
    echo -e "  ${RED}✗ Python 3.10+ not found. Install: brew install python@3.12${RESET}"
    return 1
  fi

  if [ ! -d "$VENV_DIR" ]; then
    echo "  Creating venv with $PY..."
    "$PY" -m venv "$VENV_DIR"
  fi

  local VENV_PY="$VENV_DIR/bin/python"
  echo "  Installing Python dependencies (~5 GB, includes PyTorch for MPS)..."
  "$VENV_PY" -m pip install --upgrade pip --quiet 2>/dev/null
  "$VENV_PY" -m pip install -r "$MS_DIR/requirements.txt" --quiet 2>&1 | tail -5

  local host_missing=""
  command -v ffmpeg     >/dev/null 2>&1 || host_missing="ffmpeg"
  command -v fluidsynth >/dev/null 2>&1 || host_missing="$host_missing fluidsynth"

  if [ -n "$host_missing" ]; then
    echo -e "  ${YELLOW}⚠ Missing system tools:${RESET}$host_missing"
    if command -v brew >/dev/null 2>&1; then
      printf "    Install with Homebrew? [Y/n]: "
      read -r install_host
      if [ -z "$install_host" ] || [ "$install_host" = "y" ] || [ "$install_host" = "Y" ]; then
        # shellcheck disable=SC2086
        brew install $host_missing || true
      fi
    else
      echo "    Install manually: brew install$host_missing"
    fi
  fi

  mkdir -p "$HOME/.openzigs/voice-references"
  mkdir -p "$HOME/.openzigs/remix"
  mkdir -p "$HOME/.openzigs/remix-references"
  mkdir -p "$HOME/.openzigs/soundfonts"
  mkdir -p "$HOME/.openzigs/rvc-models"

  echo -e "  ${GREEN}✓ Music Studio sidecar ready${RESET}"
  echo "    Seed-VC model (~2 GB) downloads on first voice conversion request."
  echo "    Place soundfonts (.sf2) in:  ~/.openzigs/soundfonts/"
  echo "    Place RVC models in:         ~/.openzigs/rvc-models/<voice-name>/ (.pth + .index)"
  echo "    Start: $MS_DIR/.venv/bin/python $MS_DIR/server.py"
}

# ── Sidecar: Video Generation Worker (LTX-Video) ─────────────────────────────
install_sidecar_worker() {
  local BASE_DIR="$1"
  local WORKER_DIR="$BASE_DIR/sidecars/worker"

  if [ ! -f "$WORKER_DIR/server.py" ]; then
    echo -e "  ${RED}✗ Worker sidecar not found at $WORKER_DIR${RESET}"
    return 1
  fi

  echo ""
  echo -e "${BOLD}=== Installing Video Generation Worker (LTX-Video) — port 5007 ===${RESET}"
  echo "  AI video generation on Apple Silicon via mlx-video."
  echo "  LTX-Video model (~10 GB) downloads automatically on first request."
  echo -e "  ${YELLOW}Note: Best performance on M2 Pro or higher with 32+ GB unified memory.${RESET}"
  echo ""

  local VENV_DIR="$WORKER_DIR/.venv"
  local PY=""
  for candidate in python3.12 python3.11 python3.10 python3; do
    if command -v "$candidate" >/dev/null 2>&1; then
      PY="$candidate"
      break
    fi
  done

  if [ -z "$PY" ]; then
    echo -e "  ${RED}✗ Python 3.10+ not found. Install: brew install python@3.12${RESET}"
    return 1
  fi

  if [ ! -d "$VENV_DIR" ]; then
    echo "  Creating venv with $PY..."
    "$PY" -m venv "$VENV_DIR"
  fi

  echo "  Installing dependencies (includes mlx-video from GitHub)..."
  "$VENV_DIR/bin/python" -m pip install --upgrade pip --quiet 2>/dev/null
  "$VENV_DIR/bin/python" -m pip install -r "$WORKER_DIR/requirements.txt" --quiet 2>&1 | tail -5

  echo -e "  ${GREEN}✓ Video generation worker ready${RESET}"
  echo "    Start: $WORKER_DIR/.venv/bin/python $WORKER_DIR/server.py"
  echo "    Configure: Admin → Video Generation Node (port 5007)"
}

# ── Sidecar: Voice Cloning (GPT-SoVITS Engine B) ─────────────────────────────
install_sidecar_gptsovits() {
  local BASE_DIR="$1"
  local SETUP_SCRIPT="$BASE_DIR/scripts/setup-gptsovits.sh"

  echo ""
  echo -e "${BOLD}=== Installing Voice Cloning (GPT-SoVITS Engine B) ===${RESET}"
  echo "  High-fidelity custom voice cloning from short reference audio clips."
  echo "  Downloads ~4 GB to ~/.openzigs/sidecars/gptsovits"
  echo ""

  if [ ! -f "$SETUP_SCRIPT" ]; then
    echo -e "  ${RED}✗ Setup script not found at $SETUP_SCRIPT${RESET}"
    return 1
  fi

  bash "$SETUP_SCRIPT" || {
    echo -e "  ${RED}✗ GPT-SoVITS setup failed. Run manually: bash scripts/setup-gptsovits.sh${RESET}"
    return 1
  }

  echo -e "  ${GREEN}✓ GPT-SoVITS installed${RESET}"
  echo "    Start:  ~/.openzigs/sidecars/gptsovits/start.sh"
  echo "    Or use: bash scripts/dev-clean.sh  (auto-starts all sidecars)"
}

# ── Sidecar: Lip Sync (LatentSync, MPS) ──────────────────────────────────────
# Issue #1103 — first-class Apple Silicon installer for LatentSync.
install_sidecar_lipsync() {
  local BASE_DIR="$1"
  local LIP_DIR="$BASE_DIR/sidecars/lipsync"

  if [ ! -f "$LIP_DIR/server.py" ]; then
    echo -e "  ${RED}✗ Lip-sync sidecar source not found at $LIP_DIR${RESET}"
    return 1
  fi

  # Apple Silicon only — refuse on Intel Macs and non-Darwin hosts.
  local OS_NAME ARCH_NAME
  OS_NAME="$(uname -s)"
  ARCH_NAME="$(uname -m)"
  if [ "$OS_NAME" != "Darwin" ] || [ "$ARCH_NAME" != "arm64" ]; then
    echo -e "  ${YELLOW}⚠ Lip Sync MPS sidecar requires macOS / Apple Silicon (got ${OS_NAME}/${ARCH_NAME}). Skipping.${RESET}"
    echo "    On Linux + NVIDIA, install via sidecars/setup-cuda-sidecars.sh instead."
    return 0
  fi

  echo ""
  echo -e "${BOLD}=== Installing Lip Sync (LatentSync) — port 5012 ===${RESET}"
  echo "  Model:   ByteDance/LatentSync-1.5 (~3 GB on first run, cached in HF_HOME)"
  echo "  Runtime: PyTorch MPS (torch==2.5.1)"
  echo "  Memory:  ~8 GB resident for v1.5; v1.6 (~18 GB) needs a 32 GB host."
  echo ""

  # Soft RAM warning — install proceeds either way; the sidecar enforces the
  # gate at runtime (issue #1106).
  local TOTAL_RAM_BYTES TOTAL_RAM_GB
  TOTAL_RAM_BYTES="$(sysctl -n hw.memsize 2>/dev/null || echo 0)"
  TOTAL_RAM_GB=$(( TOTAL_RAM_BYTES / 1024 / 1024 / 1024 ))
  if [ "$TOTAL_RAM_GB" -gt 0 ] && [ "$TOTAL_RAM_GB" -lt 24 ]; then
    echo -e "  ${YELLOW}⚠ Detected ${TOTAL_RAM_GB} GB unified memory.${RESET}"
    echo "    LatentSync v1.6 will be refused at /generate (HTTP 507) on this host."
    echo "    v1.5 will run locally; route v1.6 jobs to a remote 32 GB / GPU node."
    echo ""
  fi

  if [ "${OPENZIGS_INSTALL_DRY_RUN:-0}" = "1" ]; then
    echo -e "  ${YELLOW}OPENZIGS_INSTALL_DRY_RUN=1 — skipping venv + pip install.${RESET}"
    echo "    Would create:  $LIP_DIR/.venv-mps"
    echo "    Would install: requirements-mps.txt"
    echo "    Would prefetch: ByteDance/LatentSync-1.5 -> \${HF_HOME:-~/.cache/huggingface}"
    return 0
  fi

  local VENV_DIR="$LIP_DIR/.venv-mps"
  local PY=""
  for candidate in python3.12 python3.11 python3.10 python3; do
    if command -v "$candidate" >/dev/null 2>&1; then
      PY="$candidate"
      break
    fi
  done
  if [ -z "$PY" ]; then
    echo -e "  ${RED}✗ Python 3.10+ not found. Install: brew install python@3.11${RESET}"
    return 1
  fi

  if [ ! -d "$VENV_DIR" ]; then
    echo "  Creating venv with $PY..."
    "$PY" -m venv "$VENV_DIR"
  fi

  echo "  Installing dependencies (first run can take several minutes)..."
  "$VENV_DIR/bin/python" -m pip install --upgrade pip --quiet 2>/dev/null
  "$VENV_DIR/bin/python" -m pip install -r "$LIP_DIR/requirements-mps.txt" --quiet 2>&1 | tail -10

  # MPS smoke test — fast, surfaces a clear error if torch can't see Metal.
  echo "  Verifying MPS availability..."
  if ! "$VENV_DIR/bin/python" -c "import torch; assert torch.backends.mps.is_available(), 'MPS unavailable'" 2>/dev/null; then
    echo -e "  ${YELLOW}⚠ torch reports MPS unavailable. Sidecar will fall back to CPU (slow).${RESET}"
  fi

  # Clone LatentSync-1.5 source + weights to ~/.openzigs/models/latentsync so
  # the sidecar's subprocess fallback can locate inference.py and checkpoints.
  local LATENTSYNC_MODEL_DIR="$HOME/.openzigs/models/latentsync"
  echo "  Downloading ByteDance/LatentSync-1.5 to $LATENTSYNC_MODEL_DIR ..."
  mkdir -p "$LATENTSYNC_MODEL_DIR"
  "$VENV_DIR/bin/python" -c \
    "from huggingface_hub import snapshot_download; snapshot_download('ByteDance/LatentSync-1.5', local_dir='$LATENTSYNC_MODEL_DIR')" \
    2>&1 | tail -3 || \
    echo -e "  ${YELLOW}⚠ Model download failed — run manually: huggingface-cli download ByteDance/LatentSync-1.5 --local-dir ~/.openzigs/models/latentsync${RESET}"

  # Download Whisper tiny checkpoint required by LatentSync's inference.py audio encoder.
  # inference.py calls Audio2Feature(model_path="checkpoints/whisper/tiny.pt") relative to latentsync_dir.
  local WHISPER_CKPT_DIR="$LATENTSYNC_MODEL_DIR/checkpoints/whisper"
  if [[ ! -f "$WHISPER_CKPT_DIR/tiny.pt" ]]; then
    echo "  Downloading Whisper tiny.pt for LatentSync audio encoder ..."
    mkdir -p "$WHISPER_CKPT_DIR"
    "$VENV_DIR/bin/python" -c "
import urllib.request, pathlib, sys
url = 'https://openaipublic.azureedge.net/main/whisper/models/65147644a518d12f04e32d6f3b26facc3f8dd46e5390956a9424a650c0ce22b9/tiny.pt'
dest = pathlib.Path('$WHISPER_CKPT_DIR/tiny.pt')
print(f'  Downloading {url} ...')
urllib.request.urlretrieve(url, dest)
print(f'  Saved to {dest} ({dest.stat().st_size // 1024} KB)')
" 2>&1 || echo -e "  ${YELLOW}⚠ Whisper download failed — download manually: curl -L <url> -o $WHISPER_CKPT_DIR/tiny.pt${RESET}"
  else
    echo "  Whisper tiny.pt already present — skipping."
  fi

  echo -e "  ${GREEN}✓ Lip Sync sidecar ready${RESET}"
  echo "    Start: $VENV_DIR/bin/python $LIP_DIR/server.py --port 5012"
}

# ── Update GPT-SoVITS runtime deps (for re-runs on existing installs) ─────────
update_gptsovits_runtime_deps() {
  local SOVITS_VENV="$HOME/.openzigs/sidecars/gptsovits/.venv"
  [ ! -d "$SOVITS_VENV" ] && return

  local SOVITS_PY="$SOVITS_VENV/bin/python"
  if [ -x "$SOVITS_PY" ]; then
    "$SOVITS_PY" -m pip install --quiet torchcodec 2>/dev/null || true
    "$SOVITS_PY" -c \
      "import nltk; nltk.download('averaged_perceptron_tagger_eng', quiet=True)" \
      2>/dev/null || true
    echo -e "  ${GREEN}✓ GPT-SoVITS runtime deps updated${RESET}"
  fi
}

# ── Credential helpers ────────────────────────────────────────────────────────
read_credential() {
  local prompt="$1"
  local var_name="$2"
  printf "  %s: " "$prompt"
  read -r value
  if [ -n "$value" ]; then
    if grep -q "^${var_name}=" .env 2>/dev/null; then
      sed -i.bak "s|^${var_name}=.*|${var_name}=${value}|" .env && rm -f .env.bak
    else
      echo "${var_name}=${value}" >> .env
    fi
    echo -e "    ${GREEN}✓ ${var_name} saved${RESET}"
  fi
}

setup_credentials() {
  echo ""
  echo -e "${BOLD}=== MCP Sidecar Credentials ===${RESET}"
  echo "  OpenZigs auto-provisions social media and productivity MCP servers."
  echo "  Enter credentials below, or press Enter to skip each."
  echo ""

  echo "  LinkedIn (OAuth — or set manually in admin UI):"
  read_credential "Client ID"     "LINKEDIN_CLIENT_ID"
  read_credential "Client Secret" "LINKEDIN_CLIENT_SECRET"

  echo ""
  echo "  Twitter/X:"
  read_credential "Bearer Token" "TWITTER_BEARER_TOKEN"
  read_credential "API Key"      "TWITTER_API_KEY"
  read_credential "API Secret"   "TWITTER_API_SECRET"

  echo ""
  echo "  Reddit:"
  read_credential "Client ID"     "REDDIT_CLIENT_ID"
  read_credential "Client Secret" "REDDIT_CLIENT_SECRET"
  read_credential "Username"      "REDDIT_USERNAME"
  read_credential "Password"      "REDDIT_PASSWORD"

  echo ""
  echo "  TikTok (TikNeuron — get key at https://tikneuron.com):"
  read_credential "MCP API Key"  "TIKNEURON_MCP_API_KEY"

  echo ""
  echo "  YouTube:"
  read_credential "API Key"      "YOUTUBE_API_KEY"

  echo ""
  echo "  Pinterest:"
  read_credential "App ID"       "PINTEREST_APP_ID"
  read_credential "App Secret"   "PINTEREST_APP_SECRET"

  echo ""
  echo "  Brave Search (web search tool):"
  read_credential "API Key"      "BRAVE_API_KEY"
}

# ── Summary ───────────────────────────────────────────────────────────────────

# ── Auto-provision Python MCP server venvs ────────────────────────────────────
setup_python_mcp_venvs() {
  local base_dir="$1"
  echo ""
  echo -e "${BOLD}=== Setting up Python MCP server environments ===${RESET}"

  for server_dir in "$base_dir"/external/*/; do
    [ -d "$server_dir" ] || continue
    local req="$server_dir/requirements.txt"
    [ -f "$req" ] || continue

    local name
    name="$(basename "$server_dir")"
    local venv="$server_dir/.venv"

    if [ -d "$venv" ]; then
      echo -e "  ${GREEN}✓ $name venv already exists${RESET}"
      continue
    fi

    local PY=""
    for candidate in python3.12 python3.11 python3.10 python3; do
      if command -v "$candidate" >/dev/null 2>&1; then PY="$candidate"; break; fi
    done
    if [ -z "$PY" ]; then
      echo -e "  ${RED}✗ $name: Python 3 not found, skipping${RESET}"
      continue
    fi

    echo "  Creating venv for $name..."
    "$PY" -m venv "$venv"
    "$venv/bin/python" -m pip install --upgrade pip --quiet 2>/dev/null
    "$venv/bin/python" -m pip install -r "$req" --quiet 2>&1 | tail -3
    echo -e "  ${GREEN}✓ $name venv ready${RESET}"
  done
}

# ── Summary ───────────────────────────────────────────────────────────────────
print_summary() {
  local install_dir="$1"

  echo ""
  echo -e "${BOLD}${GREEN}╔══════════════════════════════════════════════════════════════╗${RESET}"
  echo -e "${BOLD}${GREEN}║          OpenZigs installed and running!                     ║${RESET}"
  echo -e "${BOLD}${GREEN}╚══════════════════════════════════════════════════════════════╝${RESET}"
  echo ""
  echo -e "  ${BOLD}Web UI:${RESET}       http://localhost:3000"
  echo -e "  ${BOLD}Admin panel:${RESET}  http://localhost:3000/admin"
  echo ""
  echo -e "${BOLD}  Installed AI Sidecars:${RESET}"
  [ "$INSTALL_AUDIO" -eq 1 ]        && echo -e "    ${GREEN}✓${RESET} Audio (STT + TTS)              — port 5006"
  [ "$INSTALL_IMAGE_GEN" -eq 1 ]    && echo -e "    ${GREEN}✓${RESET} Image Generation (MFLUX)       — port 5005"
  [ "$INSTALL_MUSIC" -eq 1 ]        && echo -e "    ${GREEN}✓${RESET} Music Generation (ACE-Step)    — port 5009"
  [ "$INSTALL_MUSIC_STUDIO" -eq 1 ] && echo -e "    ${GREEN}✓${RESET} Music Studio (Remix + V2V)     — port 5010"
  [ "$INSTALL_WORKER" -eq 1 ]       && echo -e "    ${GREEN}✓${RESET} Video Generation (LTX-Video)   — port 5007"
  [ "$INSTALL_GPTSOVITS" -eq 1 ]    && echo -e "    ${GREEN}✓${RESET} Voice Cloning (GPT-SoVITS)     — see ~/sidecars/gptsovits"

  local any=$(( INSTALL_AUDIO + INSTALL_IMAGE_GEN + INSTALL_MUSIC + \
                INSTALL_MUSIC_STUDIO + INSTALL_WORKER + INSTALL_GPTSOVITS ))
  if [ "$any" -eq 0 ]; then
    echo -e "    ${YELLOW}None — core text/tool agent only${RESET}"
    echo ""
    echo -e "  ${YELLOW}Add sidecars later by re-running install.sh from $install_dir${RESET}"
  fi

  echo ""
  echo -e "${BOLD}  Useful commands:${RESET}"
  echo "    cd $install_dir"
  echo "    docker compose logs -f        # View logs"
  echo "    docker compose restart        # Restart all services"
  echo "    docker compose down           # Stop all services"
  echo "    vim .env                      # Update API credentials"
  echo ""
  echo "  MCP sidecars auto-provisioned — add credentials to .env and restart."
  echo ""
  echo -e "${BOLD}  Starting sidecars:${RESET}"
  echo "    bash scripts/dev-clean.sh     # Start all installed sidecars"
  echo ""
  echo -e "  ${CYAN}Knowledge converter:${RESET} Excel, PDF, DOCX bundled."
  echo "    Local media transcription: pnpm exec whisper-node download"
  echo ""
}

# ════════════════════════════════════════════════════════════════════════════════
# MAIN
# ════════════════════════════════════════════════════════════════════════════════

print_banner
check_prerequisites

install_dir="$HOME/.openzigs"

# ── Handle existing installation ──────────────────────────────────────────────
if [ -d "$install_dir" ]; then
  echo ""
  echo -e "${YELLOW}OpenZigs is already installed at $install_dir${RESET}"
  echo ""
  echo "  What would you like to do?"
  echo "  1) Install / update AI sidecars only"
  echo "  2) Exit"
  echo ""
  printf "  Choice [1/2]: "
  read -r existing_choice

  if [ "$existing_choice" = "1" ]; then
    cd "$install_dir"
    install_converter_deps_with_brew
    show_sidecar_menu
    [ "$INSTALL_AUDIO" -eq 1 ]        && install_sidecar_audio        "$install_dir"
    [ "$INSTALL_IMAGE_GEN" -eq 1 ]    && install_sidecar_image_gen    "$install_dir"
    [ "$INSTALL_MUSIC" -eq 1 ]        && install_sidecar_music        "$install_dir"
    [ "$INSTALL_MUSIC_STUDIO" -eq 1 ] && install_sidecar_music_studio "$install_dir"
    [ "$INSTALL_WORKER" -eq 1 ]       && install_sidecar_worker       "$install_dir"
    [ "$INSTALL_GPTSOVITS" -eq 1 ]    && install_sidecar_gptsovits    "$install_dir"
    [ "$INSTALL_LIPSYNC" -eq 1 ]      && install_sidecar_lipsync      "$install_dir"
    update_gptsovits_runtime_deps
    print_summary "$install_dir"
    exit 0
  else
    echo "Exiting."
    exit 0
  fi
fi

# ── Fresh install ─────────────────────────────────────────────────────────────
echo ""
echo -e "${BOLD}Installing OpenZigs to $install_dir...${RESET}"
echo ""

git clone --recurse-submodules https://github.com/openzigs/openzigs.git "$install_dir"
cd "$install_dir"
git submodule update --init

if [ -f .env.example ]; then
  cp .env.example .env
fi

install_converter_deps_with_brew
show_sidecar_menu
setup_credentials
setup_python_mcp_venvs "$install_dir"

# ── Build and start core services ─────────────────────────────────────────────
echo ""
echo -e "${BOLD}Building Docker images...${RESET}"
docker compose build

echo ""
echo -e "${BOLD}Starting OpenZigs...${RESET}"
docker compose up -d

echo "Waiting for services to start..."
sleep 5

echo ""
echo -e "${BOLD}=== Service Status ===${RESET}"
docker compose ps --format "table {{.Name}}\t{{.Status}}\t{{.Ports}}"

# ── Install selected sidecars ─────────────────────────────────────────────────
[ "$INSTALL_AUDIO" -eq 1 ]        && install_sidecar_audio        "$install_dir"
[ "$INSTALL_IMAGE_GEN" -eq 1 ]    && install_sidecar_image_gen    "$install_dir"
[ "$INSTALL_MUSIC" -eq 1 ]        && install_sidecar_music        "$install_dir"
[ "$INSTALL_MUSIC_STUDIO" -eq 1 ] && install_sidecar_music_studio "$install_dir"
[ "$INSTALL_WORKER" -eq 1 ]       && install_sidecar_worker       "$install_dir"
[ "$INSTALL_GPTSOVITS" -eq 1 ]    && install_sidecar_gptsovits    "$install_dir"
[ "$INSTALL_LIPSYNC" -eq 1 ]      && install_sidecar_lipsync      "$install_dir"
update_gptsovits_runtime_deps

print_summary "$install_dir"
