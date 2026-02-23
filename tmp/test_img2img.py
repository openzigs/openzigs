"""Direct test of MFLUX sidecar img2img endpoint."""
import base64
import json
import os
import time
import urllib.request

INPUT_IMG = os.path.expanduser(
    "~/.openzigs/director/thumbnails/raw_mndz5D6KAJGMTNKh7MpaO_1771880772597.jpg"
)
OUTPUT_IMG = "/tmp/img2img_test_output.png"
SIDECAR_URL = "http://192.168.68.61:5005/img2img"
TOKEN = "0b4b2f89467b4b39cf8388092c78104cd780aa2a4ef405f30db12c8021e8e458"

with open(INPUT_IMG, "rb") as f:
    img_bytes = f.read()
print(f"Input: {len(img_bytes)} bytes ({INPUT_IMG})")

encoded = base64.b64encode(img_bytes).decode()
body = {
    "prompt": "add a woman in a red dress sitting on the hood of the car, photorealistic, high quality",
    "image": encoded,
    "model": "flux-dev",
    "strength": 0.6,
    "width": 1280,
    "height": 720,
    "steps": 20,
    "guidance_scale": 3.5,
}
payload = json.dumps(body).encode()

req = urllib.request.Request(
    SIDECAR_URL,
    data=payload,
    headers={
        "Content-Type": "application/json",
        "Authorization": f"Bearer {TOKEN}",
    },
    method="POST",
)

print(f"Sending img2img request ({len(payload)} bytes) to {SIDECAR_URL} ...")
start = time.time()
try:
    resp = urllib.request.urlopen(req, timeout=300)
    data = resp.read()
    elapsed = time.time() - start
    print(f"Response: HTTP {resp.status}, {len(data)} bytes in {elapsed:.1f}s")
    gen_time = resp.headers.get("X-Generation-Time", "?")
    model = resp.headers.get("X-Model", "?")
    size = resp.headers.get("X-Image-Size", "?")
    seed = resp.headers.get("X-Seed", "?")
    print(f"  Model: {model}, Size: {size}, Seed: {seed}, Gen-Time: {gen_time}")
    with open(OUTPUT_IMG, "wb") as f:
        f.write(data)
    print(f"Saved to {OUTPUT_IMG}")
    # Compare file sizes
    print(f"  Input:  {os.path.getsize(INPUT_IMG):,} bytes")
    print(f"  Output: {os.path.getsize(OUTPUT_IMG):,} bytes")
except urllib.error.HTTPError as e:
    elapsed = time.time() - start
    body_text = e.read().decode()[:500]
    print(f"FAILED after {elapsed:.1f}s: HTTP {e.code}")
    print(f"  Body: {body_text}")
except Exception as e:
    elapsed = time.time() - start
    print(f"FAILED after {elapsed:.1f}s: {e}")
