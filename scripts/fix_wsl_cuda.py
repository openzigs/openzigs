#!/usr/bin/env python3
"""
Fix WSL2 ld.so crash by patching all ELF libraries in /usr/lib/wsl/lib/
to remove the .gnu.hash section (convert to sysv-only hash style).

The crash: 'Inconsistency detected by ld.so: dl-setup_hash.c: 36: 
_dl_setup_hash: Assertion `(bitmask_nwords & (bitmask_nwords - 1)) == 0' failed!'

This occurs with glibc 2.39+ due to stricter GNU hash table validation
on NVIDIA WSL driver libraries that have some runtime incompatibility.
"""
import subprocess
import glob
import os
import shutil
import sys

PATCHELF = os.path.expanduser("~") + "/openzigs-sidecars/image-gen/venv/bin/patchelf"
WSL_LIB = "/usr/lib/wsl/lib"
FIX_DIR = os.path.expanduser("~") + "/cuda-fix"

os.makedirs(FIX_DIR, exist_ok=True)

fixed = 0
for f in sorted(glob.glob(f"{WSL_LIB}/*")):
    if os.path.islink(f) or not os.path.isfile(f):
        continue
    with open(f, 'rb') as fh:
        magic = fh.read(4)
    if magic != b'\x7fELF':
        continue
    
    basename = os.path.basename(f)
    dest = os.path.join(FIX_DIR, basename)
    
    # Copy and make writable
    shutil.copy2(f, dest)
    os.chmod(dest, 0o755)
    
    # Check if it has .gnu.hash
    result = subprocess.run([PATCHELF, "--print-needed", dest], capture_output=True, text=True)
    
    # Try to strip the GNU hash - patchelf doesn't support this directly
    # Instead, strip the section entirely
    result = subprocess.run(
        ["strip", "--remove-section=.gnu.hash", dest],
        capture_output=True, text=True
    )
    if result.returncode == 0:
        print(f"Stripped .gnu.hash from {basename}")
        fixed += 1
    else:
        print(f"Failed to strip {basename}: {result.stderr}")

# Create symlinks
for f in sorted(glob.glob(f"{WSL_LIB}/*")):
    if not os.path.islink(f):
        continue
    basename = os.path.basename(f)
    target_basename = os.path.basename(os.readlink(f))
    dest = os.path.join(FIX_DIR, basename)
    if os.path.exists(dest):
        os.remove(dest)
    os.symlink(target_basename, dest)
    print(f"Symlinked {basename} -> {target_basename}")

print(f"\nFixed {fixed} libraries in {FIX_DIR}")
print(f"\nTo use: export LD_LIBRARY_PATH={FIX_DIR}:$LD_LIBRARY_PATH")
