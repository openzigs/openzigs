import sys, re, json

html = sys.stdin.read()
m = re.search(r'<script\s+id="__PWS_DATA__"[^>]*>(.*?)</script>', html, re.DOTALL)
if m:
    data = json.loads(m.group(1))
    s = json.dumps(data)
    pin_ids = set(re.findall(r'"id"\s*:\s*"(\d{10,25})"', s))
    print(f"Pin IDs found: {len(pin_ids)}")
    for pid in sorted(pin_ids)[:15]:
        print(f"  {pid}")
    titles = re.findall(r'"title"\s*:\s*"([^"]{5,100})"', s)
    print(f"Titles: {titles[:3]}")
    if "relatedPins" in s or "related_pins" in s:
        print("Has related pins data!")
    if "annotations" in s or "interest" in s:
        print("Has annotation/interest data!")
else:
    print("No __PWS_DATA__ found")

# og meta tags
og_title = re.search(r'property="og:title"\s+content="([^"]+)"', html)
og_desc = re.search(r'property="og:description"\s+content="([^"]+)"', html)
og_image = re.search(r'property="og:image"\s+content="([^"]+)"', html)
pin_source = re.search(r'name="pinterestapp:source"\s+content="([^"]+)"', html)
if og_title: print(f"og:title: {og_title.group(1)[:100]}")
if og_desc: print(f"og:desc: {og_desc.group(1)[:150]}")
if og_image: print(f"og:image: {og_image.group(1)[:100]}")
if pin_source: print(f"pin:source: {pin_source.group(1)[:100]}")

# Save ratio  
saves = re.search(r'(\d[\d,.]*k?)\s*Saves?', html)
if saves: print(f"Saves: {saves.group(1)}")
