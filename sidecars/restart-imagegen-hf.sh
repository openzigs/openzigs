#!/usr/bin/env bash
# Restart image-gen sidecar with HuggingFace auth token
# Set HF_TOKEN in ~/.openzigs/.env.cuda or export it before running this script.
if [[ -z "${HF_TOKEN:-}" ]]; then
  ENV_FILE="$HOME/.openzigs/.env.cuda"
  if [[ -f "$ENV_FILE" ]]; then
    set -a; source "$ENV_FILE"; set +a
  fi
fi
if [[ -z "${HF_TOKEN:-}" ]]; then
  echo "ERROR: HF_TOKEN is not set. Add it to ~/.openzigs/.env.cuda or export it." >&2
  exit 1
fi
export HF_TOKEN

SDIR="$HOME/openzigs-sidecars"
LDIR="$HOME/.openzigs/logs"
PID_DIR="$HOME/.openzigs/pids"
mkdir -p "$LDIR" "$PID_DIR"

# Save token to HF cache so all tools pick it up
mkdir -p "$HOME/.cache/huggingface"
echo "$HF_TOKEN" > "$HOME/.cache/huggingface/token"
chmod 600 "$HOME/.cache/huggingface/token"

# Kill existing image-gen
lsof -ti :5005 2>/dev/null | xargs -r kill -9 2>/dev/null || true
sleep 1

echo "Starting image-gen sidecar with HF auth (port 5005)..."
setsid bash -c "cd \"$SDIR/image-gen\" && source venv/bin/activate && export HF_TOKEN=\"$HF_TOKEN\" && exec python server.py --port 5005 >> \"$LDIR/image-gen-cuda.log\" 2>&1" &
echo $! > "$PID_DIR/image-gen.pid"
disown -a

echo "PID: $(cat $PID_DIR/image-gen.pid)"
sleep 3
curl -s http://localhost:5005/health && echo "" || echo "Not up yet (starting in background)"
