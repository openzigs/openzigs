/**
 * Scene Graph — Timestamped data structure combining transcript, visual descriptions,
 * and audio features for intelligent clip boundary decisions.
 * Issue #821: Multi-modal AI clip extraction.
 */

export interface TranscriptWord {
  word: string;
  start: number;
  end: number;
  confidence: number;
}

export interface TranscriptSegment {
  text: string;
  start: number;
  end: number;
  words: TranscriptWord[];
}

export interface VisualFrame {
  timestamp: number;
  description: string;
  subjects: string[];
  onScreenText: string[];
  sceneType: string;
  emotionalTone: string;
}

export interface SceneChange {
  timestamp: number;
  score: number;
}

export interface SceneGraphSegment {
  start: number;
  end: number;
  transcript: string;
  visualDescriptions: string[];
  subjects: string[];
  emotionalTone: string;
  sceneType: string;
  hasSceneChange: boolean;
  hookStrength: number;
}

export interface SceneGraph {
  duration: number;
  transcript: TranscriptSegment[];
  frames: VisualFrame[];
  sceneChanges: SceneChange[];
  segments: SceneGraphSegment[];
}

/**
 * Build a scene graph from multi-modal analysis data.
 * Combines transcript, visual frames, and scene changes into coherent segments.
 */
export function buildSceneGraph(params: {
  duration: number;
  transcript: TranscriptSegment[];
  frames: VisualFrame[];
  sceneChanges: SceneChange[];
  segmentDuration?: number;
}): SceneGraph {
  const {
    duration,
    transcript,
    frames,
    sceneChanges,
    segmentDuration = 30,
  } = params;

  if (duration <= 0) {
    return {
      duration: 0,
      transcript: [],
      frames: [],
      sceneChanges: [],
      segments: [],
    };
  }

  const boundaries = computeSegmentBoundaries(
    duration,
    sceneChanges,
    segmentDuration,
  );
  const segments: SceneGraphSegment[] = [];

  for (let i = 0; i < boundaries.length - 1; i++) {
    const start = boundaries[i];
    const end = boundaries[i + 1];

    const segTranscript = transcript
      .filter((t) => t.start < end && t.end > start)
      .map((t) => t.text)
      .join(" ");

    const segFrames = frames.filter(
      (f) => f.timestamp >= start && f.timestamp < end,
    );

    const segSceneChanges = sceneChanges.filter(
      (sc) => sc.timestamp >= start && sc.timestamp < end,
    );

    const subjects = [...new Set(segFrames.flatMap((f) => f.subjects))];

    const emotionalTone =
      segFrames.length > 0 ? getMostCommonTone(segFrames) : "neutral";

    const sceneType =
      segFrames.length > 0 ? getMostCommonSceneType(segFrames) : "unknown";

    segments.push({
      start,
      end,
      transcript: segTranscript,
      visualDescriptions: segFrames.map((f) => f.description),
      subjects,
      emotionalTone,
      sceneType,
      hasSceneChange: segSceneChanges.length > 0,
      hookStrength: computeHookStrength(
        segTranscript,
        segFrames,
        segSceneChanges,
      ),
    });
  }

  return { duration, transcript, frames, sceneChanges, segments };
}

/**
 * Compute segment boundaries based on scene changes and a target segment duration.
 * Prefers splitting at scene changes for natural boundaries.
 */
export function computeSegmentBoundaries(
  duration: number,
  sceneChanges: SceneChange[],
  targetDuration: number,
): number[] {
  if (duration <= 0) return [0];
  if (duration <= targetDuration) return [0, duration];

  const boundaries = [0];
  let current = 0;

  while (current < duration) {
    const target = current + targetDuration;
    if (target >= duration) {
      boundaries.push(duration);
      break;
    }

    // Find the nearest scene change within ±10s of the target
    const nearby = sceneChanges.filter(
      (sc) =>
        sc.timestamp > current + targetDuration * 0.5 &&
        sc.timestamp <= target + 10 &&
        sc.timestamp < duration,
    );

    if (nearby.length > 0) {
      // Pick the scene change closest to our target
      const best = nearby.reduce((a, b) =>
        Math.abs(a.timestamp - target) < Math.abs(b.timestamp - target) ? a : b,
      );
      boundaries.push(best.timestamp);
      current = best.timestamp;
    } else {
      boundaries.push(target);
      current = target;
    }
  }

  return boundaries;
}

function getMostCommonTone(frames: VisualFrame[]): string {
  const counts = new Map<string, number>();
  for (const f of frames) {
    const tone = f.emotionalTone || "neutral";
    counts.set(tone, (counts.get(tone) ?? 0) + 1);
  }
  let best = "neutral";
  let bestCount = 0;
  for (const [tone, count] of counts) {
    if (count > bestCount) {
      best = tone;
      bestCount = count;
    }
  }
  return best;
}

function getMostCommonSceneType(frames: VisualFrame[]): string {
  const counts = new Map<string, number>();
  for (const f of frames) {
    const type = f.sceneType || "unknown";
    counts.set(type, (counts.get(type) ?? 0) + 1);
  }
  let best = "unknown";
  let bestCount = 0;
  for (const [type, count] of counts) {
    if (count > bestCount) {
      best = type;
      bestCount = count;
    }
  }
  return best;
}

/**
 * Compute a hook strength score (0-100) for a segment.
 * Higher scores indicate stronger potential as a clip intro.
 */
export function computeHookStrength(
  transcript: string,
  frames: VisualFrame[],
  sceneChanges: SceneChange[],
): number {
  let score = 50; // baseline

  // Transcript hook indicators
  const hookPhrases = [
    "you won't believe",
    "here's the thing",
    "let me show you",
    "the secret",
    "number one",
    "most important",
    "biggest mistake",
    "game changer",
    "this is why",
    "watch this",
    "check this out",
    "?", // questions are hooks
  ];
  const lower = transcript.toLowerCase();
  for (const phrase of hookPhrases) {
    if (lower.includes(phrase)) {
      score += 8;
    }
  }

  // Emotional frames boost
  const emotionalTones = [
    "excited",
    "surprised",
    "passionate",
    "intense",
    "funny",
  ];
  for (const f of frames) {
    if (emotionalTones.includes(f.emotionalTone)) {
      score += 5;
    }
  }

  // Scene changes indicate visual interest
  score += Math.min(sceneChanges.length * 3, 15);

  // Multiple subjects indicate interaction
  const uniqueSubjects = new Set(frames.flatMap((f) => f.subjects));
  if (uniqueSubjects.size > 1) {
    score += 5;
  }

  return Math.min(100, Math.max(0, score));
}
