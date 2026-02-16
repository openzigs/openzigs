/**
 * Director Mode — Context Assembler
 * Issue #237: Assembles ingested clip data into an interleaved ContextPayload
 * suitable for inclusion in the LLM system/user prompt.
 */

import type { ClipAnalysis, ContextPayload, ClipContext, TimelineContextEntry } from "./types.js";

/**
 * Assemble ClipAnalysis data into a ContextPayload for the LLM.
 * Interleaves visual keyframe descriptions and audio transcript segments
 * in chronological order per clip.
 */
export function assembleContext(clips: ClipAnalysis[]): ContextPayload {
  if (clips.length === 0) {
    return { clips: [], totalDuration: 0, resolution: { width: 0, height: 0 } };
  }

  const totalDuration = clips.reduce((sum, c) => sum + c.duration, 0);

  // Use the resolution of the first clip as the "reference" resolution
  const resolution = clips[0].resolution;

  const clipContexts: ClipContext[] = clips.map((clip, index) => {
    const timeline = interleaveTimeline(clip);

    return {
      index,
      source: clip.sourcePath,
      duration: clip.duration,
      timeline,
    };
  });

  return { clips: clipContexts, totalDuration, resolution };
}

/**
 * Interleave visual keyframe descriptions and transcript segments
 * in chronological order for a single clip.
 */
function interleaveTimeline(clip: ClipAnalysis): TimelineContextEntry[] {
  const entries: TimelineContextEntry[] = [];

  // Convert keyframes to visual entries with enriched descriptions
  for (const kf of clip.keyframes) {
    // Build a meaningful description from scene detection metadata
    let description = kf.description;
    if (!description) {
      if (kf.sceneScore > 0.5) {
        description = `Major visual transition (confidence: ${(kf.sceneScore * 100).toFixed(0)}%) at ${formatTimestamp(kf.timestamp)}`;
      } else if (kf.sceneScore > 0) {
        description = `Scene change (confidence: ${(kf.sceneScore * 100).toFixed(0)}%) at ${formatTimestamp(kf.timestamp)}`;
      } else {
        description = `Visual sample at ${formatTimestamp(kf.timestamp)}`;
      }
    }
    entries.push({
      type: "visual",
      timestamp: kf.timestamp,
      description,
      framePath: kf.framePath,
    });
  }

  // Convert transcript segments to audio entries
  for (const seg of clip.transcript) {
    entries.push({
      type: "audio",
      start: seg.start,
      end: seg.end,
      speech: seg.speech,
    });
  }

  // Sort by timestamp (visual timestamp directly, audio by parsing start time)
  entries.sort((a, b) => {
    const tA = a.type === "visual" ? a.timestamp : parseTimestamp(a.start);
    const tB = b.type === "visual" ? b.timestamp : parseTimestamp(b.start);
    return tA - tB;
  });

  return entries;
}

/**
 * Format a timestamp (seconds) as HH:MM:SS for the LLM context.
 */
function formatTimestamp(seconds: number): string {
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = Math.floor(seconds % 60);
  return `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`;
}

/**
 * Parse a timestamp string "HH:MM:SS.mmm" to seconds.
 */
function parseTimestamp(ts: string): number {
  const parts = ts.split(":");
  if (parts.length === 3) {
    return parseFloat(parts[0]) * 3600 + parseFloat(parts[1]) * 60 + parseFloat(parts[2]);
  }
  if (parts.length === 2) {
    return parseFloat(parts[0]) * 60 + parseFloat(parts[1]);
  }
  return parseFloat(ts) || 0;
}

/**
 * Format the ContextPayload as a human-readable string for inclusion in LLM prompts.
 * Output format per clip:
 *   CLIP 0: intro.mp4 (duration: 45.2s)
 *   [00:05] (Visual: Slide titled "Q3 Goals") (Audio: "Let's talk about Q3...")
 *   [00:12] (Visual: Speaker at podium)
 */
export function formatContextForPrompt(payload: ContextPayload): string {
  const lines: string[] = [];
  lines.push(`Total Source Clips: ${payload.clips.length}`);
  lines.push(`Combined Duration: ${payload.totalDuration.toFixed(1)}s`);
  lines.push(`Resolution: ${payload.resolution.width}x${payload.resolution.height}`);
  lines.push("");

  for (const clip of payload.clips) {
    const basename = clip.source.split("/").pop() ?? clip.source;
    lines.push(`CLIP ${clip.index}: "${basename}" (source: ${clip.source}, duration: ${clip.duration.toFixed(1)}s)`);

    const visualEntries = clip.timeline.filter((e) => e.type === "visual");
    const audioEntries = clip.timeline.filter((e) => e.type === "audio");
    lines.push(`  Visual keyframes: ${visualEntries.length}, Audio segments: ${audioEntries.length}`);

    for (const entry of clip.timeline) {
      if (entry.type === "visual") {
        lines.push(`  [${formatTimestamp(entry.timestamp)}] (Visual: ${entry.description})`);
      } else {
        lines.push(`  [${entry.start}] (Audio: "${entry.speech}")`);
      }
    }

    lines.push("");
  }

  return lines.join("\n");
}
