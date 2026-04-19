#!/bin/bash
# Restart audio sidecar with fixed code
truncate -s 0 /home/mcronin/.openzigs/logs/audio-cuda.log 2>/dev/null || true

cd /home/mcronin/openzigs-sidecars/audio
source venv/bin/activate

echo "Starting audio sidecar on port 5006..."
setsid python3 server_cuda.py --port 5006 >> /home/mcronin/.openzigs/logs/audio-cuda.log 2>&1 &
SIDECAR_PID=$!
echo "Sidecar PID: $SIDECAR_PID"

sleep 8

if lsof -ti :5006 >/dev/null 2>&1; then
    echo "AUDIO SIDECAR UP on port 5006"
    curl -s http://localhost:5006/health | python3 -m json.tool
else
    echo "SIDECAR FAILED TO START - logs:"
    cat /home/mcronin/.openzigs/logs/audio-cuda.log
fi
