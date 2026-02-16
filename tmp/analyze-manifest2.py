#!/usr/bin/env python3
"""Analyze a Director manifest JSON for duration and coverage."""
import json
import sys
from collections import defaultdict

path = sys.argv[1] if len(sys.argv) > 1 else "/tmp/director-test-duration2.json"
with open(path) as f:
    data = json.load(f)

manifest = data.get("manifest", data)
timeline = manifest.get("timeline", [])

video_clips = [e for e in timeline if e.get("type") == "video_clip"]
transitions = [e for e in timeline if e.get("type") == "transition"]
title_cards = [e for e in timeline if e.get("type") == "title_card"]

print(f"Total timeline entries: {len(timeline)}")
print(f"  video_clips: {len(video_clips)}")
print(f"  transitions: {len(transitions)}")
print(f"  title_cards: {len(title_cards)}")

fps = manifest.get("composition", {}).get("fps", 30)
max_frame = 0
for entry in timeline:
    end = entry.get("startAtFrame", 0) + entry.get("duration", 0)
    if end > max_frame:
        max_frame = end

total_dur = max_frame / fps
print(f"\nOutput duration: {total_dur:.1f}s ({max_frame} frames @ {fps}fps)")

print("\nVideo clips:")
for i, clip in enumerate(video_clips):
    src = clip.get("source", "").split("/")[-1]
    trim_sec = clip.get("trimStart", 0) / fps
    dur_sec = clip.get("duration", 0) / fps
    effects = clip.get("effects", [])
    effect_types = [e.get("type", "?") for e in effects]
    print(f"  [{i:2d}] {src:12s} trim={trim_sec:6.1f}s dur={dur_sec:4.1f}s effects={effect_types}")

# Source coverage
by_source = defaultdict(list)
for clip in video_clips:
    src = clip.get("source", "").split("/")[-1]
    by_source[src].append(clip)

print("\nCoverage per source:")
total_used = 0
for src, clips in by_source.items():
    used = sum(c.get("duration", 0) / fps for c in clips)
    total_used += used
    trims = sorted(set(round(c.get("trimStart", 0) / fps, 1) for c in clips))
    print(f"  {src}: {len(clips)} segments, {used:.1f}s used, trims at: {trims}")

source_duration = 78.0
print(f"\nTotal video used: {total_used:.1f}s of {source_duration}s source ({total_used/source_duration*100:.0f}%)")
print(f"Output video length: {total_dur:.1f}s")
