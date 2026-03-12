import sys, re, json, urllib.request

url = "https://www.pinterest.com/search/pins/?q=spring+nails"
req = urllib.request.Request(url, headers={
    "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
    "Accept": "text/html",
    "Accept-Encoding": "identity",
})
with urllib.request.urlopen(req, timeout=15) as resp:
    html = resp.read().decode("utf-8", errors="replace")

print(f"HTML size: {len(html)} bytes")

# Try __PWS_DATA__
m = re.search(r'__PWS_DATA__\s*=\s*({.*?});\s*</script>', html, re.DOTALL)
if m:
    try:
        data = json.loads(m.group(1))
        s = json.dumps(data)
        pin_ids = set(re.findall(r'"id"\s*:\s*"(\d{15,20})"', s))
        print(f"Found {len(pin_ids)} pin IDs in __PWS_DATA__")
        for pid in list(pin_ids)[:8]:
            print(f"  {pid}")
        top_keys = list(data.keys()) if isinstance(data, dict) else []
        print(f"Top keys: {top_keys[:10]}")
        # Try to find the resource results
        for key in data:
            val = data[key]
            if isinstance(val, dict):
                for k2, v2 in val.items():
                    if isinstance(v2, dict) and "data" in v2:
                        d = v2["data"]
                        if isinstance(d, dict) and "results" in d:
                            results = d["results"]
                            print(f"  Found results in {key}.{k2}: {len(results)} items")
                            for r in results[:3]:
                                if isinstance(r, dict):
                                    print(f"    Pin {r.get('id','?')}: {str(r.get('grid_title') or r.get('title','?'))[:50]}")
    except Exception as e:
        print(f"Parse error: {e}")
else:
    print("No __PWS_DATA__ found")

# Try script tags
scripts = re.findall(r'<script[^>]*type="application/json"[^>]*>(.*?)</script>', html, re.DOTALL)
print(f"\nFound {len(scripts)} JSON script blocks")
for i, s in enumerate(scripts[:5]):
    try:
        d = json.loads(s)
        ids = set(re.findall(r'"(\d{15,20})"', json.dumps(d)[:10000]))
        print(f"  Block {i}: {len(s)} bytes, {len(ids)} potential IDs")
    except:
        print(f"  Block {i}: {len(s)} bytes, parse failed")

# Also search for pin IDs in the raw HTML
all_pin_ids = set(re.findall(r'/pin/(\d{15,20})', html))
print(f"\nFound {len(all_pin_ids)} pin IDs from URL patterns in HTML")
for pid in list(all_pin_ids)[:10]:
    print(f"  {pid}")
