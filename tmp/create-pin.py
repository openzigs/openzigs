import json, base64, urllib.request, urllib.error, subprocess

with open("/Users/matthewcronin/Development/openzigs/docs/images/dashboard.png", "rb") as f:
    img_b64 = base64.b64encode(f.read()).decode()

print(f"Image base64 length: {len(img_b64)}")

token_line = subprocess.run(
    ["grep", "PINTEREST_ACCESS_TOKEN=", "/Users/matthewcronin/Development/openzigs/.env"],
    capture_output=True, text=True
).stdout.strip().split("\n")[0]
token = token_line.split("=", 1)[1]
print(f"Token: {token[:20]}...")

desc = (
    "OpenZigs is an open-source AI coding assistant that combines chat, "
    "task automation, MCP tools, and multi-channel support. Features include "
    "real-time streaming, Pinterest SEO analytics, scheduled jobs, agent "
    "orchestration, and a comprehensive admin dashboard. Built with Next.js, "
    "TypeScript, and Tailwind CSS. "
    "#AIAssistant #CodingTools #OpenSource #DeveloperTools #Automation #AI "
    "#MachineLearning #TechTools"
)

pin = {
    "board_id": "1106478270890593622",
    "title": "OpenZigs - AI-Powered Coding Assistant & Automation Platform",
    "description": desc,
    "alt_text": "Screenshot of the OpenZigs AI dashboard showing chat interface, admin tools, and task management features",
    "link": "https://github.com/openzigs/openzigs",
    "media_source": {
        "source_type": "image_base64",
        "content_type": "image/png",
        "data": img_b64
    }
}

req = urllib.request.Request(
    "https://api.pinterest.com/v5/pins",
    data=json.dumps(pin).encode(),
    headers={"Authorization": f"Bearer {token}", "Content-Type": "application/json"},
    method="POST"
)
try:
    import gzip
    with urllib.request.urlopen(req, timeout=30) as resp:
        raw = resp.read()
        # Handle gzip response
        if resp.headers.get("Content-Encoding") == "gzip":
            raw = gzip.decompress(raw)
        result = json.loads(raw)
        print(json.dumps(result, indent=2)[:3000])
except urllib.error.HTTPError as e:
    raw = e.read()
    try:
        import gzip
        raw = gzip.decompress(raw)
    except Exception:
        pass
    print(f"Error {e.code}: {raw.decode('utf-8', errors='replace')[:1000]}")
except Exception as ex:
    import traceback
    traceback.print_exc()
