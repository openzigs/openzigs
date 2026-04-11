#!/usr/bin/env bash
# Fix WSL2 ld.so crash by copying NVIDIA driver libs from 9p mount to native ext4.
# The WSL /usr/lib/wsl/lib/ is a 9p-mounted directory from the Windows host.
# glibc 2.39's ld.so has issues when mmap()ing ELF .gnu.hash sections from 9p mounts.
# Copying to native ext4 fixes the alignment/mapping issue.
set -e

SRC="/usr/lib/wsl/lib"
DST="/opt/wsl-nvidia-lib"

echo "Copying WSL NVIDIA libraries from $SRC to $DST..."
mkdir -p "$DST"

for f in "$SRC"/*; do
    bn=$(basename "$f")
    if [ -L "$f" ]; then
        target=$(readlink "$f")
        ln -sf "$target" "$DST/$bn"
        echo "  LINK: $bn -> $target"
    elif [ -f "$f" ]; then
        cp "$f" "$DST/$bn"
        chmod 755 "$DST/$bn"
        echo "  COPY: $bn"
    fi
done

echo ""
echo "Updating ldconfig..."
# Add our fixed path BEFORE the WSL path so it takes priority
echo "/opt/wsl-nvidia-lib" > /etc/ld.so.conf.d/00-nvidia-wsl-fix.conf
ldconfig

echo ""
echo "Verifying..."
ldconfig -p | grep -c libcuda
ldconfig -p | grep libcuda
echo ""
echo "Testing nvidia-smi..."
"$DST/nvidia-smi" || echo "(nvidia-smi test failed, but library fix may still work)"
echo ""
echo "Done!"
