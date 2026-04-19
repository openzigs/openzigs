#!/usr/bin/env bash
set -e
ls -la /home/mcronin/openzigs-sidecars/image-gen/server*.py /home/mcronin/openzigs-sidecars/worker/server*.py /home/mcronin/openzigs-sidecars/audio/server*.py /home/mcronin/openzigs-sidecars/lipsync/server*.py 2>&1 | head -20
echo "---"
for p in 5005 5006 5007 5010; do
    pid=$(lsof -ti :$p 2>/dev/null || true)
    if [ -n "$pid" ]; then
        cwd=$(readlink /proc/$pid/cwd 2>/dev/null || echo "?")
        cmd=$(tr '\0' ' ' < /proc/$pid/cmdline 2>/dev/null || echo "?")
        echo "port $p pid $pid cwd=$cwd"
        echo "  cmd: $cmd"
    fi
done
