"""
Fix the SmartCaptions word timings for existing Shorts drafts.
The word timings overshot the actual composition duration.
Also bumps fontSize to 80 for better readability on 9:16.
"""
import json
import sqlite3
import os

db_path = os.path.expanduser("~/.openzigs/openzigs.db")
conn = sqlite3.connect(db_path)
cur = conn.cursor()

cur.execute("""
    SELECT id, manifest FROM director_drafts
    WHERE json_extract(manifest, '$.composition.height') = 1920
""")

def estimate_word_timings(script_text, total_frames):
    import re
    cleaned = re.sub(r'\[PAUSE:\s*[\d.]+s?\]', '', script_text, flags=re.IGNORECASE)
    cleaned = cleaned.replace('*', '')
    words = [w for w in cleaned.split() if w]
    if not words:
        return []
    total_chars = sum(len(w) for w in words)
    MIN_FRAMES = 4
    # Raw durations with floor
    raw = [max(MIN_FRAMES, round(total_frames * (len(w) / total_chars))) for w in words]
    raw_total = sum(raw)
    # Scale to fit
    scale = total_frames / raw_total if raw_total > 0 else 1
    durations = [max(MIN_FRAMES, round(d * scale)) for d in raw]
    dur_sum = sum(durations)
    durations[-1] += total_frames - dur_sum

    results = []
    current = 0
    for i, w in enumerate(words):
        end = min(current + durations[i], total_frames)
        results.append({"word": w, "start": current, "end": end})
        current = end
    return results

for row in cur.fetchall():
    draft_id, manifest_json = row
    m = json.loads(manifest_json)
    tl = m.get("timeline", [])

    # Total frames from scene clips
    total_frames = 0
    for e in tl:
        if e.get("type") in ("video_clip", "image_scene", "intro_card", "outro_card"):
            end = (e.get("startAtFrame", 0) or 0) + (e.get("duration", 0) or 0)
            total_frames = max(total_frames, end)

    changed = False
    for e in tl:
        if e.get("type") == "overlay" and e.get("component") == "SmartCaptions":
            props = e.get("props", {})
            words = props.get("words", [])
            if words and words[-1]["end"] > total_frames:
                # Rebuild word timings from script text in the scene clips
                script_parts = []
                for s in tl:
                    if s.get("type") in ("video_clip", "image_scene") and s.get("scriptText"):
                        script_parts.append(s["scriptText"])
                full_script = " ".join(script_parts)
                if full_script.strip():
                    new_words = estimate_word_timings(full_script, total_frames)
                    props["words"] = new_words
                    # Also bump fontSize for 9:16 readability
                    props["fontSize"] = 80
                    e["duration"] = total_frames
                    changed = True
                    print(f"  Fixed {draft_id}: {len(words)} words frame 0-{words[-1]['end']} -> {len(new_words)} words frame 0-{new_words[-1]['end'] if new_words else 0}")

    if changed:
        cur2 = conn.cursor()
        cur2.execute("UPDATE director_drafts SET manifest = ? WHERE id = ?",
                     (json.dumps(m), draft_id))
        conn.commit()
        print(f"  Updated {draft_id}")

conn.close()
print("Done.")
