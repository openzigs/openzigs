import sys, json

data = json.load(sys.stdin)

if 'error' in data:
    print(f"ERROR: {data['error']}")
    sys.exit(1)

print("=== DIAGNOSTICS ===")
if 'diagnostics' in data:
    for k,v in data['diagnostics'].items():
        print(f"  {k}: {v}")

manifest = data.get('manifest', {})
timeline = manifest.get('timeline', [])
print(f"\n=== MANIFEST: {manifest.get('projectTitle', '?')} ===")

video_clips = [e for e in timeline if e['type'] == 'video_clip']
transitions = [e for e in timeline if e['type'] == 'transition']
title_cards = [e for e in timeline if e['type'] == 'title_card']
overlays = [e for e in timeline if e['type'] == 'overlay']

print(f"Video clips: {len(video_clips)}")
print(f"Transitions: {len(transitions)}")
print(f"Title cards: {len(title_cards)}")
print(f"Overlays: {len(overlays)}")

sources = set(c.get('source','') for c in video_clips)
print(f"\nUnique sources: {len(sources)}")
for s in sources:
    cnt = sum(1 for c in video_clips if c.get('source') == s)
    basename = s.split("/")[-1]
    print(f"  {basename}: {cnt} segments")

clips_with_effects = [c for c in video_clips if c.get('effects') and len(c['effects']) > 0]
print(f"\nClips with effects: {len(clips_with_effects)} / {len(video_clips)}")
effect_types = {}
for c in video_clips:
    for e in c.get('effects', []):
        t = e['type']
        effect_types[t] = effect_types.get(t, 0) + 1
print(f"Effect breakdown: {effect_types}")

trans_styles = {}
for t in transitions:
    s = t.get('style','?')
    trans_styles[s] = trans_styles.get(s, 0) + 1
print(f"\nTransition styles: {trans_styles}")

music = manifest.get('audioLayer', {}).get('music')
print(f"\nMusic: {'YES' if music else 'NO'}")
if music:
    print(f"  Track: {music.get('track')}")
    print(f"  Volume: {music.get('volume')}")
    print(f"  Loop: {music.get('loop')}")

json.dump(manifest, open('/tmp/test-manifest-enhanced.json','w'), indent=2)
print("\nManifest saved to /tmp/test-manifest-enhanced.json")
