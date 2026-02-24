import Database from "better-sqlite3";
import os from "node:os";

const db = new Database(os.homedir() + "/.openzigs/openzigs.db");
const row = db.prepare("SELECT manifest FROM director_drafts WHERE id = ?").get("gWzqCTRs780TrPFD_4Ynn");
if (!row) { console.log("Draft not found"); process.exit(1); }

const manifest = JSON.parse(row.manifest);
const fps = manifest.composition?.fps ?? 30;
const MIN_FRAMES = 4;

// Derive word timings from image_scene scriptText fields
function deriveWordTimings(timeline) {
  const scenes = timeline
    .filter(e => e.type !== "overlay" && e.type !== "transition" && e.scriptText)
    .sort((a, b) => (a.startAtFrame ?? 0) - (b.startAtFrame ?? 0));

  const results = [];
  for (const scene of scenes) {
    const text = scene.scriptText.replace(/\[PAUSE:\s*[\d.]+s?\]/gi, "").replace(/\*/g, "");
    const words = text.split(/\s+/).filter(w => w.length > 0);
    if (!words.length) continue;

    const dur = scene.duration ?? fps;
    const start = scene.startAtFrame ?? 0;
    const totalChars = words.reduce((n, w) => n + w.length, 0);

    const raw = words.map(w => Math.max(MIN_FRAMES, Math.round(dur * (w.length / totalChars))));
    const rawTotal = raw.reduce((a, b) => a + b, 0);
    const scale = dur / rawTotal;
    const durations = raw.map(d => Math.max(MIN_FRAMES, Math.round(d * scale)));
    durations[durations.length - 1] += dur - durations.reduce((a, b) => a + b, 0);

    let frame = start;
    for (let i = 0; i < words.length; i++) {
      const end = Math.min(frame + durations[i], start + dur);
      results.push({ word: words[i], start: frame, end });
      frame = end;
    }
  }
  return results;
}

const words = deriveWordTimings(manifest.timeline);
console.log(`Derived ${words.length} word timings`);

// Patch the SmartCaptions overlay
manifest.timeline = manifest.timeline.map(e => {
  if (e.type === "overlay" && e.component === "SmartCaptions") {
    return { ...e, props: { ...e.props, words } };
  }
  return e;
});

const now = new Date().toISOString();
db.prepare("UPDATE director_drafts SET manifest = ?, updated_at = ? WHERE id = ?")
  .run(JSON.stringify(manifest), now, "gWzqCTRs780TrPFD_4Ynn");

console.log("Done — SmartCaptions words patched in draft gWzqCTRs780TrPFD_4Ynn");
db.close();
