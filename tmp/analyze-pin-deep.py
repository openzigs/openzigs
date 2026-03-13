import sys, re, json

html = sys.stdin.read()
m = re.search(r'<script\s+id="__PWS_DATA__"[^>]*>(.*?)</script>', html, re.DOTALL)
if not m:
    print("No __PWS_DATA__")
    sys.exit(1)

data = json.loads(m.group(1))
s = json.dumps(data)

# Look for pin IDs in various formats
for pattern_name, pattern in [
    ("id: digits", r'"id"\s*:\s*"(\d{10,25})"'),
    ("id: number", r'"id"\s*:\s*(\d{10,25})'),
    ("/pin/ URL", r'/pin/(\d{10,25})'),
    ("pin_id", r'"pin_id"\s*:\s*"?(\d{10,25})"?'),
    ("pinId", r'"pinId"\s*:\s*"?(\d{10,25})"?'),
]:
    ids = set(re.findall(pattern, s))
    if ids:
        print(f"{pattern_name}: {len(ids)} → {sorted(ids)[:5]}")

# Show top-level keys
print(f"\nTop keys: {list(data.keys())[:15]}")

# Walk the JSON tree to find interesting structures
def find_paths(obj, path="", depth=0, max_depth=4):
    if depth > max_depth:
        return
    if isinstance(obj, dict):
        for k, v in obj.items():
            p = f"{path}.{k}"
            if k.lower() in ("pin", "pins", "related", "relatedpins", "related_pins", "annotations", 
                             "interests", "closeup", "closeupunified", "pinpage"):
                vtype = type(v).__name__
                if isinstance(v, (list, dict)):
                    size = len(v) if isinstance(v, list) else len(v.keys())
                    print(f"  {p} → {vtype}[{size}]")
                else:
                    print(f"  {p} → {vtype}: {str(v)[:80]}")
            find_paths(v, p, depth+1, max_depth)
    elif isinstance(obj, list) and len(obj) > 0:
        find_paths(obj[0], f"{path}[0]", depth+1, max_depth)

print("\nInteresting paths:")
find_paths(data)

# Extract annotations specifically
ann_matches = re.findall(r'"annotations"\s*:\s*(\[[^\]]{2,500}\])', s)
for i, am in enumerate(ann_matches[:2]):
    print(f"\nAnnotations #{i}: {am[:300]}")

# Extract title/description
title_m = re.findall(r'"title"\s*:\s*"([^"]{2,200})"', s)
desc_m = re.findall(r'"description"\s*:\s*"([^"]{2,300})"', s)
print(f"\nTitles: {title_m[:3]}")
print(f"Descriptions: {[d[:80] for d in desc_m[:3]]}")
