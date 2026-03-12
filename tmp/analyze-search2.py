import sys, re, json, urllib.request

url = "https://www.pinterest.com/search/pins/?q=spring+nails"
req = urllib.request.Request(url, headers={
    "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
    "Accept": "text/html",
    "Accept-Encoding": "identity",
})
with urllib.request.urlopen(req, timeout=15) as resp:
    html = resp.read().decode("utf-8", errors="replace")

scripts = re.findall(r'<script[^>]*type="application/json"[^>]*>(.*?)</script>', html, re.DOTALL)
for i, s in enumerate(scripts[:5]):
    try:
        d = json.loads(s)
        # Print structure keys
        if isinstance(d, dict):
            print(f"\n=== Block {i} ({len(s)} bytes) ===")
            for k, v in d.items():
                vtype = type(v).__name__
                vlen = len(v) if hasattr(v, '__len__') else '?'
                print(f"  {k}: {vtype} ({vlen})")
                if isinstance(v, dict):
                    for k2, v2 in list(v.items())[:5]:
                        v2type = type(v2).__name__
                        v2str = str(v2)[:100]
                        print(f"    {k2}: {v2type} = {v2str}")
    except:
        print(f"\nBlock {i}: parse failed")

# Also check for __NEXT_DATA__ or similar
m = re.search(r'__NEXT_DATA__\s*=\s*({.*?})\s*;?\s*</script>', html, re.DOTALL)
if m:
    print("\n=== __NEXT_DATA__ found ===")
    nd = json.loads(m.group(1))
    print(f"Keys: {list(nd.keys())[:10]}")

# Check for window.__REDUX
m = re.search(r'window\.__pids\s*=\s*(\[.*?\])', html)
if m:
    print(f"\n=== window.__pids found: {m.group(1)[:200]} ===")
    
# Check for any var with pin data
for pattern in [r'initialReduxState\s*=\s*({.*?});', r'window\.initialState\s*=\s*({.*?});', r'__SERVER_DATA__\s*=\s*({.*?});']:
    m = re.search(pattern, html, re.DOTALL)
    if m:
        print(f"\nFound: {pattern[:30]} ({len(m.group(1))} bytes)")
