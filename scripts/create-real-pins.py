#!/usr/bin/env python3
"""
Create real Pinterest pins for the OpenZigs AI board and register them in the tracker.

Usage:
  source .env && python3 scripts/create-real-pins.py

Requires: PINTEREST_ACCESS_TOKEN env var
"""

import base64
import gzip
import json
import os
import sys
import time
import urllib.request
import urllib.error

BOARD_ID = "1106478270890593622"
BASE_URL = "https://api.pinterest.com/v5"
TRACKER_URL = "http://localhost:3000/api/pinterest/tracker"
OPENZIGS_TOKEN = os.environ.get("OPENZIGS_TOKEN")
if not OPENZIGS_TOKEN:
    print("Error: OPENZIGS_TOKEN environment variable is required", file=sys.stderr)
    sys.exit(1)
PROJECT_ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))

PINS = [
    {
        "image": os.path.join(PROJECT_ROOT, "hero-top.png"),
        "title": "OpenZigs: AI Coding Assistant & Automation Platform 2026",
        "description": (
            "Meet OpenZigs — an open-source AI assistant that writes code, automates tasks, "
            "and manages multi-step workflows. Built with MCP tools, real-time streaming, "
            "and a beautiful dashboard. #AITools #CodingAssistant #OpenSource #DeveloperTools "
            "#Automation #AI2026 #SoftwareEngineering"
        ),
        "link": "https://github.com/mbrennan01/openzigs",
        "alt_text": "OpenZigs AI coding assistant hero banner showing the platform interface with chat, tools, and automation features",
        "topic": "AI Tools",
    },
    {
        "image": os.path.join(PROJECT_ROOT, "automation-architecture-section.png"),
        "title": "AI Task Automation Architecture — How OpenZigs Works",
        "description": (
            "Behind the scenes of OpenZigs: task engine with DAG scheduling, "
            "MCP tool registry, approval queues, and autonomous Sentinel monitoring. "
            "See how modern AI agents coordinate complex multi-step workflows. "
            "#AIArchitecture #TaskAutomation #SystemDesign #AIAgents #DevOps "
            "#MLOps #TechArchitecture"
        ),
        "link": "https://github.com/mbrennan01/openzigs",
        "alt_text": "OpenZigs automation architecture diagram showing task engine, tool registry, approval queue, and Sentinel monitoring system",
        "topic": "AI Architecture",
    },
    {
        "image": os.path.join(PROJECT_ROOT, "architecture-integrations-cta.png"),
        "title": "10+ MCP Integrations for AI-Powered Developer Workflows",
        "description": (
            "OpenZigs connects to GitHub, file systems, web browsers, shell, Docker, "
            "social media APIs, and more through the Model Context Protocol. "
            "One AI assistant, unlimited tool integrations. "
            "#MCPTools #AIIntegrations #DeveloperWorkflow #GitHub #DevTools "
            "#APIIntegration #ProductivityTools"
        ),
        "link": "https://github.com/mbrennan01/openzigs",
        "alt_text": "OpenZigs MCP integrations showing connections to GitHub, Docker, social media, file systems, and web browsing tools",
        "topic": "Developer Tools",
    },
]


def pinterest_api(method: str, endpoint: str, data: dict | None = None) -> dict:
    """Call Pinterest API v5."""
    token = os.environ.get("PINTEREST_ACCESS_TOKEN")
    if not token:
        print("ERROR: PINTEREST_ACCESS_TOKEN not set. Run: source .env", file=sys.stderr)
        sys.exit(1)

    url = f"{BASE_URL}{endpoint}"
    headers = {
        "Authorization": f"Bearer {token}",
        "Content-Type": "application/json",
        "Accept-Encoding": "gzip",
    }

    body = json.dumps(data).encode() if data else None
    req = urllib.request.Request(url, data=body, headers=headers, method=method)

    try:
        with urllib.request.urlopen(req) as resp:
            raw = resp.read()
            if resp.headers.get("Content-Encoding") == "gzip":
                raw = gzip.decompress(raw)
            return json.loads(raw.decode())
    except urllib.error.HTTPError as e:
        raw = e.read()
        try:
            raw = gzip.decompress(raw)
        except Exception:
            pass
        error_body = raw.decode("utf-8", errors="replace")
        print(f"Pinterest API error {e.code}: {error_body}", file=sys.stderr)
        raise


def tracker_api(method: str, path: str, data: dict | None = None) -> dict | None:
    """Call local OpenZigs tracker API."""
    url = f"{TRACKER_URL}{path}"
    headers = {
        "Authorization": f"Bearer {OPENZIGS_TOKEN}",
        "Content-Type": "application/json",
    }

    body = json.dumps(data).encode() if data else None
    req = urllib.request.Request(url, data=body, headers=headers, method=method)

    try:
        with urllib.request.urlopen(req) as resp:
            return json.loads(resp.read().decode())
    except urllib.error.HTTPError as e:
        error_body = e.read().decode()
        print(f"Tracker API error {e.code}: {error_body}", file=sys.stderr)
        return None


def create_pin(pin_config: dict) -> dict | None:
    """Create a single pin on Pinterest."""
    image_path = pin_config["image"]
    if not os.path.exists(image_path):
        print(f"  Image not found: {image_path}", file=sys.stderr)
        return None

    # Read and base64-encode the image
    with open(image_path, "rb") as f:
        image_data = base64.b64encode(f.read()).decode()

    ext = os.path.splitext(image_path)[1].lower()
    content_types = {".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg"}
    content_type = content_types.get(ext, "image/png")

    payload = {
        "board_id": BOARD_ID,
        "title": pin_config["title"],
        "description": pin_config["description"],
        "link": pin_config["link"],
        "alt_text": pin_config["alt_text"],
        "media_source": {
            "source_type": "image_base64",
            "content_type": content_type,
            "data": image_data,
        },
    }

    print(f"  Creating pin: {pin_config['title'][:60]}...")
    result = pinterest_api("POST", "/pins", payload)
    return result


def register_in_tracker(pin_data: dict, topic: str, score: int = 70) -> None:
    """Add the real pin to the local tracker and take an initial snapshot."""
    pin_id = pin_data["id"]
    title = pin_data.get("title", "")

    # Register the pin
    tracker_api("POST", "/pins", {
        "pin_id": pin_id,
        "title": title,
        "topic": topic,
        "board_id": BOARD_ID,
        "link": pin_data.get("link", ""),
        "initial_score": score,
    })
    print(f"  Registered in tracker: {pin_id}")

    # Take initial snapshot (new pin = zeros)
    tracker_api("POST", f"/pins/{pin_id}/snapshots", {
        "impressions": 0,
        "pin_clicks": 0,
        "saves": 0,
        "outbound_clicks": 0,
        "reactions": 0,
        "comments": 0,
    })
    print(f"  Initial snapshot recorded")


def main() -> None:
    print("=" * 60)
    print("Creating Real Pinterest Pins for OpenZigs AI Board")
    print("=" * 60)
    print(f"Board: OpenZigs AI ({BOARD_ID})")
    print(f"Pins to create: {len(PINS)}")
    print()

    created = []
    for i, pin_config in enumerate(PINS, 1):
        print(f"[{i}/{len(PINS)}] {pin_config['title'][:50]}...")
        try:
            result = create_pin(pin_config)
            if result and "id" in result:
                pin_id = result["id"]
                pin_url = f"https://www.pinterest.com/pin/{pin_id}/"
                print(f"  ✅ Created! Pin ID: {pin_id}")
                print(f"  📌 URL: {pin_url}")

                # Register in tracker
                register_in_tracker(result, pin_config["topic"])
                created.append({"id": pin_id, "url": pin_url, "title": pin_config["title"]})
            else:
                print(f"  ❌ Failed — unexpected response")
        except Exception as e:
            print(f"  ❌ Failed: {e}")

        # Rate limit: Pinterest recommends spacing API calls
        if i < len(PINS):
            print("  (waiting 2s for rate limit...)")
            time.sleep(2)
        print()

    print("=" * 60)
    print(f"Summary: {len(created)}/{len(PINS)} pins created")
    print("=" * 60)
    for p in created:
        print(f"  {p['id']} — {p['title'][:50]}")
        print(f"    {p['url']}")
    print()
    if created:
        print("All pins registered in the Pin Tracker with initial snapshots.")
        print("Visit /social/pinterest in the UI to see them in the dashboard.")


if __name__ == "__main__":
    main()
