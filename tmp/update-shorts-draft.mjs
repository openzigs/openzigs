import Database from "better-sqlite3";
import os from "node:os";

const db = new Database(os.homedir() + "/.openzigs/openzigs.db");
const row = db.prepare("SELECT manifest FROM director_drafts WHERE id = ?").get("gWzqCTRs780TrPFD_4Ynn");
const manifest = JSON.parse(row.manifest);

// Source image map: frame range -> image path
const imageScenes = [
  { start: 210, end: 815, src: os.homedir() + "/.openzigs/director/blog/blog-img-_WVDesIy.jpg" },
  { start: 905, end: 1430, src: os.homedir() + "/.openzigs/director/blog/blog-img-1rquycx-.jpg" },
  { start: 1430, end: 1950, src: os.homedir() + "/.openzigs/director/blog/blog-img-UrsqdBoG.png" },
  { start: 1950, end: 2430, src: os.homedir() + "/.openzigs/director/blog/blog-img-qNEOi1Ux.jpg" },
];

function findImage(trimStart) {
  for (const s of imageScenes) {
    if (trimStart >= s.start && trimStart < s.end) return s.src;
  }
  // Default to closest if in a gap (title card transition area)
  let closest = imageScenes[0];
  let minDist = Infinity;
  for (const s of imageScenes) {
    const d = Math.min(Math.abs(trimStart - s.start), Math.abs(trimStart - s.end));
    if (d < minDist) { minDist = d; closest = s; }
  }
  return closest.src;
}

// Replace video_clip entries with image_scene entries
const newTimeline = [];
let imgIdx = 0;
for (const entry of manifest.timeline) {
  if (entry.type === "video_clip") {
    imgIdx++;
    newTimeline.push({
      type: "image_scene",
      src: findImage(entry.trimStart),
      startAtFrame: entry.startAtFrame,
      duration: entry.duration,
      scriptText: entry.scriptText,
      kenBurns: {
        scaleFrom: 1.0,
        scaleTo: 1.15,
        translateXFrom: imgIdx % 2 === 0 ? 0 : -5,
        translateXTo: imgIdx % 2 === 0 ? -10 : 5,
        translateYFrom: 0,
        translateYTo: -5,
      },
    });
  } else {
    newTimeline.push(entry);
  }
}

manifest.timeline = newTimeline;

// Update in DB
const now = new Date().toISOString();
db.prepare("UPDATE director_drafts SET manifest = ?, updated_at = ?, status = ? WHERE id = ?")
  .run(JSON.stringify(manifest), now, "draft", "gWzqCTRs780TrPFD_4Ynn");

console.log("Updated draft with", newTimeline.length, "entries:");
for (const e of newTimeline) {
  if (e.type === "image_scene") {
    const imgName = e.src.split("/").pop();
    console.log("  image_scene [" + e.startAtFrame + "-" + (e.startAtFrame + e.duration) + "] " + imgName + " | " + (e.scriptText || "").slice(0, 60));
  } else {
    console.log("  " + e.type);
  }
}
db.close();
console.log("Done — draft updated. Re-render from the Studio UI.");
