import sys, re, json

html = sys.stdin.read()

# Extract __PWS_DATA__
m = re.search(r'<script\s+id="__PWS_DATA__"[^>]*>(.*?)</script>', html, re.DOTALL)
if not m:
    m = re.search(r'__PWS_DATA__\s*=\s*(\{.*?\});\s*</script>', html, re.DOTALL)

if m:
    try:
        data = json.loads(m.group(1))
        if isinstance(data, dict):
            print("__PWS_DATA__ top keys:", list(data.keys())[:15])
            for k in list(data.keys())[:5]:
                val = data[k]
                if isinstance(val, dict):
                    print(f"  {k} keys: {list(val.keys())[:10]}")
                elif isinstance(val, str):
                    print(f"  {k}: {val[:200]}")
                else:
                    t = type(val).__name__
                    print(f"  {k}: type={t}")
            
            # Deep search for pin-like data
            s = json.dumps(data)
            pin_ids = set(re.findall(r'"id"\s*:\s*"(\d{10,25})"', s))
            print(f"\nPin IDs in __PWS_DATA__: {len(pin_ids)}")
            for pid in sorted(pin_ids)[:10]:
                print(f"  {pid}")
            
            # Look for search results or pins arrays
            for key_path in ["props", "context", "data", "cache", "resourceResponses"]:
                if key_path in data:
                    inner = data[key_path]
                    if isinstance(inner, dict):
                        print(f"\n{key_path} sub-keys: {list(inner.keys())[:15]}")
    except Exception as e:
        print(f"Parse error: {e}")
        print(m.group(1)[:300])
else:
    print("__PWS_DATA__ not found as script tag")

# Check for initialReduxState data
print("\n--- initialReduxState ---")
idx = html.find("initialReduxState")
if idx >= 0:
    snippet = html[idx:idx+300]
    print(f"Found at position {idx}")
    print(snippet[:200])
