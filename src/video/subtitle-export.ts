/**
 * SRT/VTT Subtitle Export — generates subtitle files from manifest narration segments.
 * Issue #521: Export subtitles in SRT and WebVTT formats.
 */

export interface SubtitleSegment {
  /** Narration text for this segment */
  text: string;
  /** Duration in milliseconds */
  durationMs: number;
}

export interface TimelineSceneForSubtitles {
  type?: string;
  scriptText?: string;
  duration?: number;
  durationInFrames?: number;
  [key: string]: unknown;
}

export interface ManifestForSubtitles {
  composition?: { fps: number };
  timeline?: TimelineSceneForSubtitles[];
}

/**
 * Extract subtitle segments from a Director manifest's timeline.
 * Only scenes with `scriptText` contribute subtitle entries.
 */
export function extractSubtitleSegments(
  manifest: ManifestForSubtitles,
): SubtitleSegment[] {
  const timeline = manifest.timeline;
  if (!timeline || timeline.length === 0) return [];

  const fps = manifest.composition?.fps ?? 30;
  const segments: SubtitleSegment[] = [];

  for (const scene of timeline) {
    const durationMs = getSceneDurationMs(scene, fps);
    if (
      scene.scriptText &&
      typeof scene.scriptText === "string" &&
      scene.scriptText.trim()
    ) {
      segments.push({ text: scene.scriptText.trim(), durationMs });
    }
  }

  return segments;
}

/**
 * Format milliseconds to SRT timestamp: `HH:MM:SS,mmm`
 */
export function formatSrtTimestamp(ms: number): string {
  const totalMs = Math.max(0, Math.round(ms));
  const hours = Math.floor(totalMs / 3_600_000);
  const minutes = Math.floor((totalMs % 3_600_000) / 60_000);
  const seconds = Math.floor((totalMs % 60_000) / 1000);
  const millis = totalMs % 1000;
  return `${String(hours).padStart(2, "0")}:${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")},${String(millis).padStart(3, "0")}`;
}

/**
 * Format milliseconds to VTT timestamp: `HH:MM:SS.mmm`
 */
export function formatVttTimestamp(ms: number): string {
  return formatSrtTimestamp(ms).replace(",", ".");
}

/**
 * Generate an SRT subtitle file from segments.
 * Each segment becomes a numbered entry with accumulated timestamps.
 */
export function generateSrt(segments: SubtitleSegment[]): string {
  if (segments.length === 0) return "";

  const lines: string[] = [];
  let currentMs = 0;

  for (let i = 0; i < segments.length; i++) {
    const seg = segments[i];
    const startMs = currentMs;
    const endMs = currentMs + seg.durationMs;

    lines.push(String(i + 1));
    lines.push(
      `${formatSrtTimestamp(startMs)} --> ${formatSrtTimestamp(endMs)}`,
    );
    lines.push(seg.text);
    lines.push("");

    currentMs = endMs;
  }

  return lines.join("\n");
}

/**
 * Generate a WebVTT subtitle file from segments.
 * Includes `WEBVTT` header and accumulated timestamps.
 */
export function generateVtt(segments: SubtitleSegment[]): string {
  if (segments.length === 0) return "WEBVTT\n";

  const lines: string[] = ["WEBVTT", ""];
  let currentMs = 0;

  for (const seg of segments) {
    const startMs = currentMs;
    const endMs = currentMs + seg.durationMs;

    lines.push(
      `${formatVttTimestamp(startMs)} --> ${formatVttTimestamp(endMs)}`,
    );
    lines.push(seg.text);
    lines.push("");

    currentMs = endMs;
  }

  return lines.join("\n");
}

/**
 * Generate subtitles from a manifest in the specified format.
 */
export function generateSubtitles(
  manifest: ManifestForSubtitles,
  format: "srt" | "vtt",
): string {
  const segments = extractSubtitleSegments(manifest);
  return format === "srt" ? generateSrt(segments) : generateVtt(segments);
}

function getSceneDurationMs(
  scene: TimelineSceneForSubtitles,
  fps: number,
): number {
  if (typeof scene.duration === "number" && scene.duration > 0) {
    return scene.duration < 1000 ? scene.duration * 1000 : scene.duration;
  }
  if (
    typeof scene.durationInFrames === "number" &&
    scene.durationInFrames > 0
  ) {
    return (scene.durationInFrames / fps) * 1000;
  }
  return 5000;
}
