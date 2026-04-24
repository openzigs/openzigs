"""
Verify _get_max_frames_for_model returns sane values for both single-GPU and
pooled VRAM configurations after the category-detection bug fix.

Run from the repo root:
  python scripts/_test_caps.py
"""
import sys
import os

# Point at the deployed worker (or the source copy — same file)
sys.path.insert(0, os.path.expanduser("~/openzigs-sidecars/worker"))
os.environ.setdefault("M2_PRO_WORKER_TOKEN", "test")

import server_cuda as wk  # noqa: E402

MODELS = [
    "ltxv-2b-legacy",
    "ltxv-2b-096-distilled",
    "ltxv-2-22b-distilled",
    "ltxv-13b-097-distilled",
]

scenarios = [
    ("Single GPU 11 GB (restart without CUDA_VISIBLE_DEVICES=0,1)", 11),
    ("Pooled 23 GB (both RTX 3060s)", 23),
]

all_ok = True
for label, vram in scenarios:
    wk._get_vram_gb = lambda v=vram: v
    print(f"\n=== {label} ===")
    for key in MODELS:
        frames = wk._get_max_frames_for_model(key)
        secs = round(frames / 24, 1)
        # 2B models must produce at least 4s (97 frames) on any config
        if "2b" in key and "22b" not in key and frames < 97:
            print(f"  FAIL  {key}: {frames} frames = {secs}s  <-- should be >= 97!")
            all_ok = False
        else:
            print(f"  OK    {key}: {frames} frames = {secs}s")

print()
if all_ok:
    print("ALL ASSERTIONS PASSED")
else:
    print("SOME ASSERTIONS FAILED")
    sys.exit(1)
