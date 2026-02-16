/**
 * Test: Director pipeline — verify vision analysis, effects, transitions, multi-clip
 * Uses the demo files: zig1.mp4, zigs2.mp4, music1.mp3
 */
import { ingest } from "../src/video/ingestion/index.js";
import { ProducerService } from "../src/video/producer/producer-service.js";
import { formatContextForPrompt } from "../src/video/ingestion/context-assembler.js";
import { CopilotWrapperService } from "../src/copilot/copilot-wrapper.js";
import fs from "node:fs/promises";

async function main() {
  const copilot = new CopilotWrapperService();
  await copilot.authenticate();

  const clips = [
    "/Users/matthewcronin/Director_Demo/zig1.mp4",
    "/Users/matthewcronin/Director_Demo/zigs2.mp4",
  ];
  const musicPath = "/Users/matthewcronin/Director_Demo/music1.mp3";

  console.log("=== PHASE 1: INGESTION ===");
  console.log(`Ingesting ${clips.length} clips...`);

  const ingestionResult = await ingest({ clips, mode: "highlight" }, {
    copilot,
    visionAnalysis: {
      maxKeyframes: 10,
      delayMs: 1500,
    },
    onProgress: (event) => {
      console.log(`  [${event.phase}] ${event.message} (${((event.progress ?? 0) * 100).toFixed(0)}%)`);
    },
  });

  console.log("\n=== INGESTION RESULTS ===");
  console.log(`Clips processed: ${ingestionResult.clips.length}`);
  console.log(`Total duration: ${ingestionResult.totalDuration.toFixed(1)}s`);
  for (const clip of ingestionResult.clips) {
    const richDescriptions = clip.keyframes.filter((kf) =>
      kf.description &&
      !kf.description.startsWith("Major visual") &&
      !kf.description.startsWith("Scene change") &&
      !kf.description.startsWith("Visual sample"),
    );
    console.log(`  Clip: ${clip.sourcePath.split("/").pop()}`);
    console.log(`    Duration: ${clip.duration.toFixed(1)}s`);
    console.log(
      `    Keyframes: ${clip.keyframes.length} total, ${richDescriptions.length} with vision descriptions`,
    );
    if (richDescriptions.length > 0) {
      console.log("    Sample vision descriptions:");
      for (const kf of richDescriptions.slice(0, 3)) {
        console.log(`      [${kf.timestamp.toFixed(1)}s] ${kf.description?.slice(0, 100)}`);
      }
    }
  }

  console.log("\n=== CONTEXT FOR LLM ===");
  const contextText = formatContextForPrompt(ingestionResult.contextPayload);
  const contextLines = contextText.split("\n");
  console.log(`Context payload: ${contextLines.length} lines`);
  console.log(contextLines.slice(0, 40).join("\n"));

  console.log("\n=== PHASE 2: PRODUCE MANIFEST ===");
  const producer = new ProducerService(copilot);
  const result = await producer.produce({
    mode: "highlight",
    contextPayload: ingestionResult.contextPayload,
    musicTrackPath: musicPath,
    sourceClips: clips,
  });

  const manifest = result.manifest;

  console.log("\n=== MANIFEST ANALYSIS ===");
  console.log(`Project: ${manifest.projectTitle}`);
  console.log(`Template: ${manifest.templateId}`);
  console.log(`Timeline entries: ${manifest.timeline.length}`);

  const videoClips = manifest.timeline.filter((e) => e.type === "video_clip");
  const transitions = manifest.timeline.filter((e) => e.type === "transition");
  const titleCards = manifest.timeline.filter((e) => e.type === "title_card");
  const overlays = manifest.timeline.filter((e) => e.type === "overlay");

  console.log(`  Video clips: ${videoClips.length}`);
  console.log(`  Transitions: ${transitions.length}`);
  console.log(`  Title cards: ${titleCards.length}`);
  console.log(`  Overlays: ${overlays.length}`);

  // Check multi-clip coverage
  const uniqueSources = new Set(videoClips.map((c) => (c as any).source));
  console.log(`\nSource clips used: ${uniqueSources.size} of ${clips.length}`);
  for (const src of uniqueSources) {
    const count = videoClips.filter((c) => (c as any).source === src).length;
    console.log(`  ${(src as string).split("/").pop()}: ${count} segments`);
  }

  // Check effects
  const clipsWithEffects = videoClips.filter(
    (c) => (c as any).effects && (c as any).effects.length > 0,
  );
  console.log(`\nClips with effects: ${clipsWithEffects.length} of ${videoClips.length}`);
  const effectTypes: Record<string, number> = {};
  for (const c of videoClips) {
    for (const e of ((c as any).effects || [])) {
      effectTypes[e.type] = (effectTypes[e.type] || 0) + 1;
    }
  }
  console.log("Effect breakdown:", effectTypes);

  // Check transitions
  console.log(`\nTransitions: ${transitions.length}`);
  const transitionStyles: Record<string, number> = {};
  for (const t of transitions) {
    transitionStyles[(t as any).style] = (transitionStyles[(t as any).style] || 0) + 1;
  }
  console.log("Transition styles:", transitionStyles);

  // Music
  console.log(`\nMusic: ${manifest.audioLayer?.music ? "YES" : "NO"}`);
  if (manifest.audioLayer?.music) {
    console.log(`  Track: ${manifest.audioLayer.music.track}`);
    console.log(`  Volume: ${manifest.audioLayer.music.volume}`);
    console.log(`  Loop: ${manifest.audioLayer.music.loop}`);
    console.log(`  Ducking: ${manifest.audioLayer.music.ducking}`);
  }

  // Write manifest for inspection
  await fs.writeFile("/tmp/test-manifest-enhanced.json", JSON.stringify(manifest, null, 2));
  console.log("\nManifest written to /tmp/test-manifest-enhanced.json");
}

main().catch((err) => {
  console.error("FATAL:", err);
  process.exit(1);
});
