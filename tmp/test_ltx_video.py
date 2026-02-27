"""
Quick smoke test for the LTX-2 video generation worker.

Spins up a temporary HTTP server to receive the async callback,
sends a /generate request, and waits for the result.

Usage:
    python tmp/test_ltx_video.py
"""
import base64
import json
import os
import socket
import threading
import time
import uuid
from http.server import HTTPServer, BaseHTTPRequestHandler
from urllib.request import Request, urlopen
from urllib.error import HTTPError

# ── Configuration ────────────────────────────────────────────
LTX_HOST = os.getenv("LTX_HOST", "localhost")
LTX_PORT = int(os.getenv("LTX_PORT", "5007"))
LTX_TOKEN = os.getenv("LTX_SECRET_TOKEN", "634577cda2cdfff31e3325f806bca4f40b51d08d00cb02e4d1daa14acf0a6c6d")
OUTPUT_DIR = "/tmp"
TIMEOUT_SEC = 5400  # 90 minutes max wait

# ── Callback server ──────────────────────────────────────────
result_event = threading.Event()
result_data: dict = {}


class CallbackHandler(BaseHTTPRequestHandler):
    def do_POST(self):
        global result_data
        length = int(self.headers.get("Content-Length", 0))
        body = self.rfile.read(length)
        result_data = json.loads(body)
        self.send_response(200)
        self.end_headers()
        self.wfile.write(b"OK")
        result_event.set()

    def log_message(self, format, *args):
        pass  # suppress logs


def get_free_port() -> int:
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as s:
        s.bind(("", 0))
        return s.getsockname()[1]


# ── Main ─────────────────────────────────────────────────────
def main():
    # 1. Check worker health
    print(f"Checking LTX worker at {LTX_HOST}:{LTX_PORT}...")
    try:
        resp = urlopen(f"http://{LTX_HOST}:{LTX_PORT}/health", timeout=10)
        health = json.loads(resp.read())
        print(f"  Health: {health}")
    except Exception as e:
        print(f"  FAILED: Worker not reachable: {e}")
        return

    # 2. Check status
    resp = urlopen(f"http://{LTX_HOST}:{LTX_PORT}/status", timeout=10)
    status = json.loads(resp.read())
    print(f"  Status: {status}")
    if status.get("is_busy"):
        print("  Worker is busy — aborting.")
        return

    # 3. Start callback server
    cb_port = get_free_port()
    server = HTTPServer(("0.0.0.0", cb_port), CallbackHandler)
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    print(f"  Callback server listening on port {cb_port}")

    # 4. Send generate request
    job_id = str(uuid.uuid4())
    payload = {
        "job_id": job_id,
        "type": "txt2video",
        "prompt": "a cat sitting on a windowsill watching rain fall outside, cozy atmosphere, warm lighting, photorealistic, cinematic, 4k",
        "width": 512,
        "height": 320,
        "num_frames": 33,  # 1.4s at 24fps — safe resolution (proven at 512x320), more frames + steps for quality
        "fps": 24,
        "model": "ltx-2",
        "pipeline": "dev",
        "cfg_scale": 4.5,
        "num_inference_steps": 25,
        "negative_prompt": "worst quality, inconsistent motion, blurry, jittery, distorted, cartoon, anime, illustration, low quality, ugly",
        "callback_url": f"http://localhost:{cb_port}/callback",
        "seed": 42,
    }

    body = json.dumps(payload).encode()
    req = Request(
        f"http://{LTX_HOST}:{LTX_PORT}/generate",
        data=body,
        headers={
            "Content-Type": "application/json",
            "Authorization": f"Bearer {LTX_TOKEN}",
        },
        method="POST",
    )

    print(f"\nSubmitting job {job_id}...")
    print(f"  Prompt: {payload['prompt']}")
    print(f"  Frames: {payload['num_frames']} @ {payload['fps']}fps")
    print(f"  Resolution: {payload['width']}x{payload['height']}")
    print(f"  Pipeline: {payload['pipeline']}, cfg_scale: {payload.get('cfg_scale', 'n/a')}")

    start = time.time()
    try:
        resp = urlopen(req, timeout=30)
        accept_data = json.loads(resp.read())
        print(f"  Accepted: {accept_data}")
    except HTTPError as e:
        body_text = e.read().decode()[:500]
        print(f"  REJECTED: HTTP {e.code} — {body_text}")
        server.shutdown()
        return

    # 5. Wait for callback
    print(f"\nWaiting for generation (timeout {TIMEOUT_SEC}s)...")
    if not result_event.wait(timeout=TIMEOUT_SEC):
        elapsed = time.time() - start
        print(f"  TIMEOUT after {elapsed:.0f}s — no callback received.")
        server.shutdown()
        return

    elapsed = time.time() - start
    server.shutdown()

    # 6. Process result
    status = result_data.get("status")
    if status == "complete":
        media_b64 = result_data.get("media_base64", "")
        media_bytes = base64.b64decode(media_b64)
        metadata = result_data.get("metadata", {})
        out_path = os.path.join(OUTPUT_DIR, f"ltx_test_{job_id[:8]}.mp4")
        with open(out_path, "wb") as f:
            f.write(media_bytes)

        # Also copy to Desktop for easy access
        import shutil, subprocess
        desktop_path = os.path.expanduser(f"~/Desktop/ltx_dev_{job_id[:8]}.mp4")
        shutil.copy2(out_path, desktop_path)

        print(f"\nSUCCESS in {elapsed:.1f}s")
        print(f"  Output: {out_path} ({len(media_bytes):,} bytes)")
        print(f"  Desktop: {desktop_path}")
        print(f"  Metadata: {json.dumps(metadata, indent=2)}")
        subprocess.run(["open", desktop_path])  # auto-open in QuickTime
    elif status == "failed":
        error = result_data.get("error", "unknown")
        print(f"\nFAILED after {elapsed:.1f}s: {error}")
    else:
        print(f"\nUNEXPECTED RESPONSE after {elapsed:.1f}s:")
        # Don't dump the full base64 blob
        safe = {k: v for k, v in result_data.items() if k != "media_base64"}
        print(f"  {json.dumps(safe, indent=2)}")


if __name__ == "__main__":
    main()
