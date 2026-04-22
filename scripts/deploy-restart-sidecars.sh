#!/usr/bin/env bash
# Deploy fresh sidecar server_cuda.py files + start script to ~/openzigs-sidecars,
# then restart the sidecars with the new multi-GPU pinning.
set -euo pipefail

REPO="/mnt/c/Users/mgbre/Development/openzigs"
DEST="$HOME/openzigs-sidecars"

echo "=== Deploying fresh sidecar code ==="
for name in image-gen audio worker lipsync sadtalker; do
    src="$REPO/sidecars/$name/server_cuda.py"
    dst="$DEST/$name/server_cuda.py"
    if [ ! -f "$src" ]; then
        echo "  WARN: $src missing, skipping"
        continue
    fi
    cp "$src" "$dst"
    echo "  copied $name/server_cuda.py ($(wc -c < "$dst") bytes)"
done

# start script with CRLF strip
echo "Copying start-cuda-sidecars.sh (CRLF stripped)..."
tr -d '\r' < "$REPO/sidecars/start-cuda-sidecars.sh" > "$DEST/start-cuda-sidecars.sh"
chmod +x "$DEST/start-cuda-sidecars.sh"

echo ""
echo "=== Killing existing sidecar PIDs ==="
for port in 5005 5006 5007 5009 5010 5011; do
    pid=$(lsof -ti :$port 2>/dev/null || true)
    if [ -n "$pid" ]; then
        echo "  killing port $port pid $pid"
        kill -TERM "$pid" 2>/dev/null || true
    fi
done
sleep 3
# force kill any survivors
for port in 5005 5006 5007 5009 5010 5011; do
    pid=$(lsof -ti :$port 2>/dev/null || true)
    if [ -n "$pid" ]; then
        echo "  KILL -9 port $port pid $pid"
        kill -9 "$pid" 2>/dev/null || true
    fi
done
sleep 2

echo ""
echo "=== Starting sidecars with new multi-GPU pinning ==="
bash "$DEST/start-cuda-sidecars.sh"

echo ""
echo "=== Done. Sidecars warming up — will be reachable in ~10-30s ==="
