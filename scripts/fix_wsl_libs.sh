#!/usr/bin/env bash
# Fix WSL2 NVIDIA driver libraries that crash with glibc 2.39's ld.so
# by rebuilding them with sysv-only hash style using patchelf.
set -e

SRC="/usr/lib/wsl/lib"
DST="/usr/lib/wsl/lib-fixed"

mkdir -p "$DST"

for f in "$SRC"/*; do
    [ -L "$f" ] && continue
    [ -f "$f" ] || continue
    file "$f" | grep -q ELF || continue
    
    bn=$(basename "$f")
    cp "$f" "$DST/$bn"
    chmod 755 "$DST/$bn"
    
    # Rebuild with sysv-only hash to avoid the .gnu.hash assertion
    if patchelf --set-hash-style sysv "$DST/$bn" 2>/dev/null; then
        echo "FIXED: $bn"
    else
        echo "SKIP:  $bn (patchelf failed)"
    fi
done

# Create symlinks
for f in "$SRC"/*; do
    [ -L "$f" ] || continue
    bn=$(basename "$f")
    target=$(readlink "$f")
    target_bn=$(basename "$target")
    ln -sf "$target_bn" "$DST/$bn"
    echo "LINK:  $bn -> $target_bn"
done

echo ""
echo "Done! Now update /etc/ld.so.conf.d/ld.wsl.conf to point to $DST"
echo "Then run: sudo ldconfig"
