import json, sys

d = json.load(open('/tmp/director-test-vision.json'))
m = d['manifest']
fps = m['composition']['fps']
total_frames = 0
for e in m['timeline']:
    if e['type'] in ('video_clip', 'title_card'):
        end = e['startAtFrame'] + e.get('duration', 0)
        if end > total_frames:
            total_frames = end

print(f"Output video duration: {total_frames/fps:.1f}s ({total_frames} frames @ {fps}fps)")
print(f"Total source duration: {d.get('totalDuration', 0):.1f}s")
print(f"Source clips processed: {d.get('clipsProcessed', 0)}")
print()

video_clips = [e for e in m['timeline'] if e['type'] == 'video_clip']
for i, c in enumerate(video_clips):
    src = c['source'].split('/')[-1]
    dur_sec = c['duration'] / fps
    trim_sec = c.get('trimStart', 0) / fps
    print(f"  Clip {i}: {src}  trim={trim_sec:.1f}s  dur={dur_sec:.1f}s  (trimFrames={c.get('trimStart',0)} durFrames={c['duration']})")

source_coverage = {}
for c in video_clips:
    src = c['source'].split('/')[-1]
    if src not in source_coverage:
        source_coverage[src] = {'total_used': 0, 'segments': 0, 'trims': []}
    source_coverage[src]['total_used'] += c['duration'] / fps
    source_coverage[src]['segments'] += 1
    source_coverage[src]['trims'].append(c.get('trimStart', 0) / fps)

print()
print("Coverage analysis:")
for src, info in source_coverage.items():
    trims = [f"{t:.1f}s" for t in info['trims']]
    print(f"  {src}: {info['segments']} segments, {info['total_used']:.1f}s used, trims at: {trims}")

# Check for duplicate trim points
print()
print("Duplicate trim detection:")
for src, info in source_coverage.items():
    trims = info['trims']
    unique = set(trims)
    if len(unique) < len(trims):
        print(f"  WARNING: {src} has duplicate trim points!")
    else:
        print(f"  {src}: {len(unique)} unique trim points (good)")

# Output ratio
total_used = sum(info['total_used'] for info in source_coverage.values())
total_source = d.get('totalDuration', 1)
print(f"\nTotal video content used: {total_used:.1f}s out of {total_source:.1f}s source ({total_used/total_source*100:.0f}%)")
print(f"Output video length: {total_frames/fps:.1f}s")
