import sys, re

html = sys.stdin.read()
print(f"HTML size: {len(html)} bytes")

# All meta tags
metas = re.findall(r'<meta\s+([^>]+)>', html)
for m in metas:
    name = re.search(r'(?:name|property)="([^"]+)"', m)
    content = re.search(r'content="([^"]*)"', m)
    if name and content:
        print(f"  {name.group(1)}: {content.group(1)[:120]}")

# Link tags with pin URLs
links = re.findall(r'<link\s+([^>]+/pin/[^>]+)>', html)
for l in links[:5]:
    print(f"  link: {l[:200]}")

# Any pin URLs in the page
pin_urls = set(re.findall(r'(https?://(?:www\.)?pinterest\.com/pin/\d+)', html))
print(f"\nPin URLs found: {len(pin_urls)}")
for u in sorted(pin_urls)[:10]:
    print(f"  {u}")

# Check for JSON-LD
jsonld = re.findall(r'<script\s+type="application/ld\+json"[^>]*>(.*?)</script>', html, re.DOTALL)
for j in jsonld[:2]:
    print(f"\nJSON-LD: {j[:500]}")

# Check for significant noscript content
noscripts = re.findall(r'<noscript>(.*?)</noscript>', html, re.DOTALL)
for ns in noscripts:
    if len(ns) > 50:
        print(f"\nnoscript ({len(ns)} chars): {ns[:300]}")
