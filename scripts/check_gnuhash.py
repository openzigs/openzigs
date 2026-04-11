#!/usr/bin/env python3
"""Check all ELF libraries in /usr/lib/wsl/lib/ for broken GNU hash tables."""
import struct
import glob
import os

for f in sorted(glob.glob('/usr/lib/wsl/lib/*')):
    if not os.path.isfile(f):
        continue
    try:
        with open(f, 'rb') as fh:
            magic = fh.read(4)
            if magic != b'\x7fELF':
                continue
            fh.seek(0)
            data = fh.read()
            ei_class = data[4]
            if ei_class != 2:
                continue
            e_shoff = struct.unpack_from('<Q', data, 40)[0]
            e_shentsize = struct.unpack_from('<H', data, 58)[0]
            e_shnum = struct.unpack_from('<H', data, 60)[0]
            e_shstrndx = struct.unpack_from('<H', data, 62)[0]
            strtab_off = struct.unpack_from('<Q', data, e_shoff + e_shstrndx * e_shentsize + 24)[0]
            for i in range(e_shnum):
                sh_off = e_shoff + i * e_shentsize
                sh_name_idx = struct.unpack_from('<I', data, sh_off)[0]
                name_start = strtab_off + sh_name_idx
                name_end = data.index(b'\x00', name_start)
                name = data[name_start:name_end].decode()
                if name == '.gnu.hash':
                    sec_offset = struct.unpack_from('<Q', data, sh_off + 24)[0]
                    nb, si, mw, s2 = struct.unpack_from('<IIII', data, sec_offset)
                    ok = (mw & (mw - 1)) == 0 if mw > 0 else True
                    status = 'OK' if ok else 'BROKEN'
                    print(f'{status}: {os.path.basename(f)} maskwords={mw} nbuckets={nb}')
                    break
    except Exception as e:
        print(f'ERROR: {os.path.basename(f)}: {e}')

print('Done')
