"""Backfill existing Shorts drafts: add fitMode and split into per-sentence scenes."""
import sqlite3
import json
import os
import re

db_path = os.path.expanduser("~/.openzigs/openzigs.db")
conn = sqlite3.connect(db_path)
cur = conn.cursor()

cur.execute(
    "SELECT id, manifest FROM director_drafts "
    "WHERE manifest LIKE '%video_clip%' AND manifest LIKE '%1920%'"
)
rows = cur.fetchall()

for draft_id, manifest_json in rows:
    m = json.loads(manifest_json)
    fps = m.get("composition", {}).get("fps", 30)

    new_timeline = []
    for entry in m.get("timeline", []):
        if entry.get("type") == "video_clip":
            entry["fitMode"] = "contain"

            script = entry.get("scriptText", "")
            if script:
                cleaned = re.sub(
                    r"\[PAUSE:\s*[\d.]+s?\]", "", script, flags=re.IGNORECASE
                )
                cleaned = cleaned.replace("*", "")
                sentences = [
                    s.strip()
                    for s in re.split(r"(?<=[.!?])\s+", cleaned)
                    if s.strip()
                ]

                merged = []
                for s in sentences:
                    if merged and len(s) < 20:
                        merged[-1] += " " + s
                    else:
                        merged.append(s)

                if len(merged) > 1:
                    total_frames = entry["duration"]
                    trim_start = entry["trimStart"]
                    total_chars = sum(len(s) for s in merged)
                    current_frame = 0
                    source = entry["source"]
                    volume = entry.get("volume", 0.1)

                    for sentence in merged:
                        frac = len(sentence) / total_chars
                        scene_dur = max(fps, round(total_frames * frac))
                        actual_dur = min(scene_dur, total_frames - current_frame)
                        if actual_dur <= 0:
                            break
                        new_timeline.append(
                            {
                                "type": "video_clip",
                                "source": source,
                                "startAtFrame": current_frame,
                                "trimStart": trim_start + current_frame,
                                "duration": actual_dur,
                                "volume": volume,
                                "horizontalCropOffset": 50,
                                "fitMode": "contain",
                                "scriptText": sentence,
                            }
                        )
                        current_frame += actual_dur
                    continue

            new_timeline.append(entry)
        else:
            new_timeline.append(entry)

    m["timeline"] = new_timeline
    scene_count = sum(1 for e in new_timeline if e.get("type") == "video_clip")

    cur.execute(
        "UPDATE director_drafts SET manifest = ? WHERE id = ?",
        (json.dumps(m), draft_id),
    )
    print(f"Updated {draft_id}: {scene_count} scene(s)")

conn.commit()
conn.close()
