/**
 * YouTube Chapter Generator — generates chapter timestamps from manifest timeline.
 * Issue #516: Auto-generates YouTube chapter markers from scene/narration segments.
 */

export interface ChapterEntry {
  /** Timestamp string formatted for YouTube (e.g. "0:00", "1:30") */
  timestamp: string;
  /** Chapter title / label */
  label: string;
}

/**
 * Format a duration in milliseconds to a YouTube chapter timestamp.
 * Uses "M:SS" for < 60 minutes, "H:MM:SS" for >= 60 minutes.
 */
export function formatTimestamp(ms: number): string {
  const totalSeconds = Math.floor(ms / 1000);
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;

  if (hours > 0) {
    return `${hours}:${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}`;
  }
  return `${minutes}:${String(seconds).padStart(2, "0")}`;
}

export interface TimelineScene {
  type?: string;
  title?: string;
  scriptText?: string;
  duration?: number;
  durationInFrames?: number;
  [key: string]: unknown;
}

export interface ManifestForChapters {
  projectTitle?: string;
  composition?: { fps: number };
  timeline?: TimelineScene[];
}

/**
 * Generate YouTube chapter entries from a manifest's timeline scenes.
 * Accumulates durations to produce timestamps. Requires at least 3 chapters
 * (YouTube's minimum) for the output to be valid.
 */
export function generateChapters(manifest: ManifestForChapters): ChapterEntry[] {
  const timeline = manifest.timeline;
  if (!timeline || timeline.length === 0) return [];

  const fps = manifest.composition?.fps ?? 30;
  const chapters: ChapterEntry[] = [];
  let currentMs = 0;

  for (const scene of timeline) {
    // Only generate chapters for visual scenes, not transitions/overlays
    if (scene.type === "transition" || scene.type === "overlay") {
      // Still accumulate duration
      const durationMs = getSceneDurationMs(scene, fps);
      currentMs += durationMs;
      continue;
    }

    const label = deriveLabel(scene, chapters.length);
    chapters.push({
      timestamp: formatTimestamp(currentMs),
      label,
    });

    const durationMs = getSceneDurationMs(scene, fps);
    currentMs += durationMs;
  }

  return chapters;
}

/**
 * Format chapters as a YouTube description block.
 * YouTube requires the first chapter to start at 0:00 and at least 3 chapters.
 */
export function formatChaptersForDescription(chapters: ChapterEntry[]): string {
  if (chapters.length < 3) return "";

  // Ensure first chapter starts at 0:00
  if (chapters[0].timestamp !== "0:00") {
    chapters = [{ timestamp: "0:00", label: chapters[0].label }, ...chapters.slice(1)];
  }

  return chapters.map((c) => `${c.timestamp} ${c.label}`).join("\n");
}

function getSceneDurationMs(scene: TimelineScene, fps: number): number {
  if (typeof scene.duration === "number" && scene.duration > 0) {
    // duration could be in seconds or ms — if < 1000, treat as seconds
    return scene.duration < 1000 ? scene.duration * 1000 : scene.duration;
  }
  if (typeof scene.durationInFrames === "number" && scene.durationInFrames > 0) {
    return (scene.durationInFrames / fps) * 1000;
  }
  return 5000; // default 5s per scene
}

function deriveLabel(scene: TimelineScene, index: number): string {
  if (scene.title && typeof scene.title === "string" && scene.title.trim().length > 0) {
    return scene.title.trim();
  }
  if (scene.scriptText && typeof scene.scriptText === "string") {
    // Use first ~50 chars of script as label
    const clean = scene.scriptText.trim().replace(/\n/g, " ");
    return clean.length > 50 ? clean.slice(0, 47) + "..." : clean;
  }
  if (scene.type === "intro_card" || scene.type === "title_card") {
    return "Intro";
  }
  if (scene.type === "outro_card") {
    return "Outro";
  }
  return `Part ${index + 1}`;
}
