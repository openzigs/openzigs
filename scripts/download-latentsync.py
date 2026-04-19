#!/usr/bin/env python3
"""Download LatentSync checkpoints from HuggingFace."""
import os
from huggingface_hub import hf_hub_download

local_dir = os.path.join(os.path.expanduser("~"), ".openzigs", "models", "latentsync", "checkpoints")
os.makedirs(os.path.join(local_dir, "whisper"), exist_ok=True)

print(f"Downloading to {local_dir}")
print("Downloading whisper/tiny.pt...")
hf_hub_download("ByteDance/LatentSync-1.6", "whisper/tiny.pt", local_dir=local_dir)
print("whisper/tiny.pt done")

print("Downloading latentsync_unet.pt...")
hf_hub_download("ByteDance/LatentSync-1.6", "latentsync_unet.pt", local_dir=local_dir)
print("latentsync_unet.pt done")
print("All downloads complete!")
