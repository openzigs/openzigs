/**
 * Director Mode — Manifest Enhancer
 * Deterministic post-processing that guarantees effects, transitions,
 * multi-clip coverage, AND adequate duration in LLM-generated manifests.
 *
 * The LLM is instructed to create long, well-covered timelines but often
 * produces short, sparse output. This module applies smart defaults AFTER
 * repair/validation so the final video always has professional quality.
 */

import { logger } from "../../logging/logger.js";
import type { DirectorManifest, VideoClipEntry, TransitionEntry, TitleCardEntry } from "./manifest-types.js";

// ── Configuration ─────────────────────────────────────────────

/** Minimum clip duration (frames) to receive a slowZoom effect. */
const SLOW_ZOOM_MIN_DURATION = 60; // ~2s at 30fps

/** Default crossfade duration in frames when inserting transitions. */
const DEFAULT_TRANSITION_DURATION = 20;

/** slowZoom default scale range (subtle Ken Burns). */
const DEFAULT_ZOOM_FROM = 1.0;
const DEFAULT_ZOOM_TO = 1.12;

/** Default fadeIn/fadeOut duration in frames. */
const DEFAULT_FADE_DURATION = 20;

/** Default segment duration in seconds when injecting fill clips. */
const DEFAULT_SEGMENT_SEC = 5;

/**
 * Minimum ratio of output duration to source duration.
 * If the LLM produces a 20s video from 80s of source, that's 25% — way too low.
 * We require at least 65% coverage.
 */
const MIN_DURATION_RATIO = 0.65;

export interface EnhancementOptions {
  /** Per-clip durations in seconds keyed by source path */
  clipDurations?: Record<string, number>;
  /** Total source duration in seconds */
  totalSourceDuration?: number;
}

export interface EnhancementStats {
  transitionsAdded: number;
  effectsAdded: number;
  clipsInjected: number;
  warnings: string[];
  /** Duration extension info (null if not extended) */
  durationExtended: { fromSec: number; toSec: number } | null;
}

/**
 * Enhance a manifest with smart defaults for transitions, effects,
 * multi-clip coverage, and adequate duration. Mutates the manifest in-place.
 *
 * @param manifest - The LLM-generated (and already repaired) manifest
 * @param sourceClips - Array of source clip file paths that were ingested
 * @param options - Duration and clip metadata for coverage enforcement
 * @returns Statistics about what was enhanced
 */
export function enhanceManifest(
  manifest: DirectorManifest,
  sourceClips: string[],
  options: EnhancementOptions = {},
): EnhancementStats {
  const stats: EnhancementStats = {
    transitionsAdded: 0,
    effectsAdded: 0,
    clipsInjected: 0,
    warnings: [],
    durationExtended: null,
  };

  // 1. Ensure intro and outro title cards exist
  ensureTitleCards(manifest, stats);

  // 2. Ensure all source clips are represented
  ensureMultiClipCoverage(manifest, sourceClips, stats, options);

  // 2. Ensure adequate duration (fill timeline to use enough source material)
  ensureAdequateDuration(manifest, sourceClips, stats, options);

  // 3. Ensure transitions between adjacent video clips
  ensureTransitions(manifest, stats);

  // 4. Ensure effects on video clips (slowZoom, fadeIn, fadeOut)
  ensureEffects(manifest, stats);

  if (stats.transitionsAdded + stats.effectsAdded + stats.clipsInjected > 0) {
    logger.info(
      `[ManifestEnhancer] Enhanced manifest: ` +
        `+${stats.transitionsAdded} transitions, ` +
        `+${stats.effectsAdded} effects, ` +
        `+${stats.clipsInjected} clips injected`,
    );
  }

  if (stats.warnings.length > 0) {
    for (const w of stats.warnings) {
      logger.warn(`[ManifestEnhancer] ${w}`);
    }
  }

  return stats;
}

// ── Title Cards ───────────────────────────────────────────────

/** Default intro title card duration in frames (~3s at 30fps). */
const INTRO_CARD_DURATION = 90;
/** Default outro title card duration in frames (~2.5s at 30fps). */
const OUTRO_CARD_DURATION = 75;

/**
 * Ensure the timeline has an intro title_card (first entry) and an outro
 * title_card (last visual entry). Injects defaults when the LLM omits them.
 */
function ensureTitleCards(
  manifest: DirectorManifest,
  stats: EnhancementStats,
): void {
  // Check for existing title cards
  const titleCards = manifest.timeline.filter(
    (e): e is TitleCardEntry => e.type === "title_card",
  );

  const hasIntro = titleCards.some((c) => c.startAtFrame === 0);

  // Derive an intro/outro title from the manifest
  const projectTitle = manifest.projectTitle || "Untitled";

  if (!hasIntro) {
    // Insert intro title card at the very beginning
    const introCard: TitleCardEntry = {
      type: "title_card",
      title: projectTitle,
      subtitle: "",
      startAtFrame: 0,
      duration: INTRO_CARD_DURATION,
      animation: "fade",
    };

    // Shift all existing entries forward to make room
    const shiftAmount = INTRO_CARD_DURATION;
    for (const entry of manifest.timeline) {
      entry.startAtFrame += shiftAmount;
    }

    // Insert the intro card and a transition after it
    manifest.timeline.unshift(introCard);
    manifest.timeline.splice(1, 0, {
      type: "transition",
      style: "crossfade",
      duration: DEFAULT_TRANSITION_DURATION,
      startAtFrame: INTRO_CARD_DURATION,
    } as TransitionEntry);

    stats.transitionsAdded++;
    stats.warnings.push("Injected missing intro title card");
    logger.info("[ManifestEnhancer] Injected intro title card");
  }

  // Check for outro: a title_card near the end of the timeline
  const timelineDuration = getTimelineDuration(manifest);
  const hasOutro = titleCards.some(
    (c) => c.startAtFrame + c.duration >= timelineDuration - 30, // within ~1s of end
  );

  if (!hasOutro) {
    const outroStart = timelineDuration;

    // Insert transition before outro
    manifest.timeline.push({
      type: "transition",
      style: "crossfade",
      duration: DEFAULT_TRANSITION_DURATION,
      startAtFrame: outroStart,
    } as TransitionEntry);
    stats.transitionsAdded++;

    // Insert outro title card
    const outroCard: TitleCardEntry = {
      type: "title_card",
      title: "Thanks for watching",
      startAtFrame: outroStart,
      duration: OUTRO_CARD_DURATION,
      animation: "fade",
    };
    manifest.timeline.push(outroCard);

    stats.warnings.push("Injected missing outro title card");
    logger.info("[ManifestEnhancer] Injected outro title card");
  }
}

// ── Multi-Clip Coverage ───────────────────────────────────────

/**
 * Verify that every source clip appears in the timeline.
 * If a clip is missing, inject segments from it (using actual clip
 * durations to spread trim points evenly across the source).
 */
function ensureMultiClipCoverage(
  manifest: DirectorManifest,
  sourceClips: string[],
  stats: EnhancementStats,
  options: EnhancementOptions,
): void {
  if (sourceClips.length <= 1) return;

  const videoClips = manifest.timeline.filter(
    (e): e is VideoClipEntry => e.type === "video_clip",
  );

  const usedSources = new Set(videoClips.map((c) => normalizePath(c.source)));

  const missingClips = sourceClips.filter(
    (src) => !usedSources.has(normalizePath(src)),
  );

  if (missingClips.length === 0) return;

  stats.warnings.push(
    `LLM ignored ${missingClips.length} of ${sourceClips.length} source clips: ${missingClips.map((p) => pathBasename(p)).join(", ")}`,
  );

  const fps = manifest.composition.fps || 30;

  for (const missingPath of missingClips) {
    const clipDur = options.clipDurations?.[missingPath] ?? 30;
    const clipDurFrames = Math.floor(clipDur * fps);

    // More segments for longer clips — at least 3, up to 8
    const segmentCount = Math.max(3, Math.min(8, Math.ceil(clipDur / 8)));
    const segmentDuration = Math.floor(fps * DEFAULT_SEGMENT_SEC);

    // Spread trim points evenly across the source clip's full duration
    const trimStep = Math.max(1, Math.floor(clipDurFrames / segmentCount));

    injectSegments(manifest, missingPath, segmentCount, segmentDuration, trimStep, fps, stats);
  }

  // Update metadata.sourceClips
  if (manifest.metadata) {
    const metaSources = new Set(manifest.metadata.sourceClips.map(normalizePath));
    for (const src of sourceClips) {
      if (!metaSources.has(normalizePath(src))) {
        manifest.metadata.sourceClips.push(src);
      }
    }
  }
}

// ── Duration Enforcement ──────────────────────────────────────

/**
 * Ensure that the output video duration is at least MIN_DURATION_RATIO of the
 * total source material. If the LLM produced a short timeline, inject
 * additional segments from source clips to fill the gap, picking from
 * unused regions of each clip.
 */
function ensureAdequateDuration(
  manifest: DirectorManifest,
  sourceClips: string[],
  stats: EnhancementStats,
  options: EnhancementOptions,
): void {
  const totalSourceSec = options.totalSourceDuration ?? 0;
  if (totalSourceSec <= 0) return;

  const fps = manifest.composition.fps || 30;
  const currentDurationFrames = getTimelineDuration(manifest);
  const currentDurationSec = currentDurationFrames / fps;
  const targetDurationSec = totalSourceSec * MIN_DURATION_RATIO;

  if (currentDurationSec >= targetDurationSec) {
    logger.info(
      `[ManifestEnhancer] Duration OK: ${currentDurationSec.toFixed(1)}s >= ${targetDurationSec.toFixed(1)}s target ` +
        `(${((currentDurationSec / totalSourceSec) * 100).toFixed(0)}% of source)`,
    );
    return;
  }

  const deficitSec = targetDurationSec - currentDurationSec;
  stats.warnings.push(
    `Output too short: ${currentDurationSec.toFixed(1)}s ` +
      `(${((currentDurationSec / totalSourceSec) * 100).toFixed(0)}% of ${totalSourceSec.toFixed(1)}s source). ` +
      `Adding ~${deficitSec.toFixed(1)}s of content.`,
  );

  // Build a map of regions that are already covered per source clip
  const videoClips = manifest.timeline.filter(
    (e): e is VideoClipEntry => e.type === "video_clip",
  );
  const usedRegions: Map<string, Array<{ start: number; end: number }>> = new Map();
  for (const clip of videoClips) {
    const key = normalizePath(clip.source);
    if (!usedRegions.has(key)) usedRegions.set(key, []);
    usedRegions.get(key)!.push({ start: clip.trimStart, end: clip.trimStart + clip.duration });
  }

  // Round-robin through source clips, filling from their largest unused gaps
  const segmentDurationFrames = Math.floor(fps * DEFAULT_SEGMENT_SEC);
  let remainingDeficitFrames = Math.ceil(deficitSec * fps);
  let clipIndex = 0;
  const maxIterations = sourceClips.length * 10; // safety valve

  while (remainingDeficitFrames > segmentDurationFrames / 2 && clipIndex < maxIterations) {
    const sourcePath = sourceClips[clipIndex % sourceClips.length];
    const sourceKey = normalizePath(sourcePath);
    const clipDurSec = options.clipDurations?.[sourcePath] ?? 30;
    const clipDurFrames = Math.floor(clipDurSec * fps);

    const used = usedRegions.get(sourceKey) ?? [];
    used.sort((a, b) => a.start - b.start);

    const gaps = findUnusedGaps(used, clipDurFrames, segmentDurationFrames);

    if (gaps.length === 0) {
      clipIndex++;
      continue;
    }

    // Pick the largest gap
    const gap = gaps[0];
    const trimCenter = gap.start + Math.floor((gap.end - gap.start) / 2);
    const actualTrim = Math.max(0, Math.min(trimCenter - segmentDurationFrames / 2, clipDurFrames - segmentDurationFrames));
    const actualDuration = Math.min(segmentDurationFrames, remainingDeficitFrames, clipDurFrames - actualTrim);

    if (actualDuration < fps) {
      // Less than 1 second — skip
      clipIndex++;
      continue;
    }

    injectSingleSegment(manifest, sourcePath, actualTrim, actualDuration, fps, stats);

    // Mark this region as used
    if (!usedRegions.has(sourceKey)) usedRegions.set(sourceKey, []);
    usedRegions.get(sourceKey)!.push({ start: actualTrim, end: actualTrim + actualDuration });

    remainingDeficitFrames -= actualDuration;
    clipIndex++;
  }

  const newDurationSec = getTimelineDuration(manifest) / fps;
  stats.durationExtended = {
    fromSec: currentDurationSec,
    toSec: newDurationSec,
  };

  logger.info(
    `[ManifestEnhancer] Extended duration: ${currentDurationSec.toFixed(1)}s → ${newDurationSec.toFixed(1)}s ` +
      `(target: ${targetDurationSec.toFixed(1)}s)`,
  );
}

/**
 * Find continuous gaps in the used regions large enough for a segment.
 * Returns gaps sorted by size descending (fill largest first).
 */
function findUnusedGaps(
  usedRegions: Array<{ start: number; end: number }>,
  totalFrames: number,
  minGapSize: number,
): Array<{ start: number; end: number }> {
  const sorted = [...usedRegions].sort((a, b) => a.start - b.start);
  const gaps: Array<{ start: number; end: number }> = [];

  let cursor = 0;
  for (const region of sorted) {
    if (region.start - cursor >= minGapSize) {
      gaps.push({ start: cursor, end: region.start });
    }
    cursor = Math.max(cursor, region.end);
  }
  // Gap after the last used region until end of clip
  if (totalFrames - cursor >= minGapSize) {
    gaps.push({ start: cursor, end: totalFrames });
  }

  gaps.sort((a, b) => (b.end - b.start) - (a.end - a.start));
  return gaps;
}

// ── Segment Injection Helpers ─────────────────────────────────

/**
 * Inject multiple segments from a source clip, spread evenly via trimStep.
 */
function injectSegments(
  manifest: DirectorManifest,
  sourcePath: string,
  segmentCount: number,
  segmentDuration: number,
  trimStep: number,
  _fps: number,
  stats: EnhancementStats,
): void {
  let lastFrame = getTimelineDuration(manifest);

  for (let i = 0; i < segmentCount; i++) {
    // Crossfade before each segment
    const transition: TransitionEntry = {
      type: "transition",
      style: "crossfade",
      duration: DEFAULT_TRANSITION_DURATION,
      startAtFrame: lastFrame,
    };
    manifest.timeline.push(transition);
    stats.transitionsAdded++;

    const trimStart = i * trimStep;
    const clipEntry: VideoClipEntry = {
      type: "video_clip",
      source: sourcePath,
      startAtFrame: lastFrame,
      trimStart,
      duration: segmentDuration,
      volume: 0.8,
      effects: [
        {
          type: "slowZoom",
          from: i % 2 === 0 ? DEFAULT_ZOOM_FROM : DEFAULT_ZOOM_TO,
          to: i % 2 === 0 ? DEFAULT_ZOOM_TO : DEFAULT_ZOOM_FROM,
        },
      ],
    };

    if (i === 0) {
      clipEntry.effects!.push({ type: "fadeIn", durationFrames: DEFAULT_FADE_DURATION });
    }

    manifest.timeline.push(clipEntry);
    lastFrame += segmentDuration;
    stats.clipsInjected++;
  }
}

/**
 * Inject a single segment from a source clip at a specific trim point.
 */
function injectSingleSegment(
  manifest: DirectorManifest,
  sourcePath: string,
  trimStart: number,
  duration: number,
  _fps: number,
  stats: EnhancementStats,
): void {
  const lastFrame = getTimelineDuration(manifest);

  const transition: TransitionEntry = {
    type: "transition",
    style: "crossfade",
    duration: DEFAULT_TRANSITION_DURATION,
    startAtFrame: lastFrame,
  };
  manifest.timeline.push(transition);
  stats.transitionsAdded++;

  const clipEntry: VideoClipEntry = {
    type: "video_clip",
    source: sourcePath,
    startAtFrame: lastFrame,
    trimStart,
    duration,
    volume: 0.8,
    effects: [
      {
        type: "slowZoom",
        from: DEFAULT_ZOOM_FROM,
        to: DEFAULT_ZOOM_TO,
      },
    ],
  };

  manifest.timeline.push(clipEntry);
  stats.clipsInjected++;
}

// ── Transitions ───────────────────────────────────────────────

/**
 * Ensure transitions exist between adjacent video clips / title cards.
 * If the LLM didn't generate transitions, insert crossfades.
 */
function ensureTransitions(
  manifest: DirectorManifest,
  stats: EnhancementStats,
): void {
  // Sort timeline by startAtFrame
  manifest.timeline.sort((a, b) => a.startAtFrame - b.startAtFrame);

  // Find indices of visual segments (video_clip, title_card)
  const segmentIndices: number[] = [];
  for (let i = 0; i < manifest.timeline.length; i++) {
    const t = manifest.timeline[i].type;
    if (t === "video_clip" || t === "title_card") {
      segmentIndices.push(i);
    }
  }

  // Check for existing transitions
  const existingTransitions = manifest.timeline.filter(
    (e): e is TransitionEntry => e.type === "transition",
  );

  // If the LLM generated at least some transitions, don't add more
  // (we only add defaults when transitions are completely absent)
  if (existingTransitions.length >= segmentIndices.length - 1) return;

  // For each pair of adjacent segments, check if a transition exists between them
  const newEntries: TransitionEntry[] = [];

  for (let i = 0; i < segmentIndices.length - 1; i++) {
    const segA = manifest.timeline[segmentIndices[i]];
    const segB = manifest.timeline[segmentIndices[i + 1]];

    const segAEnd = segA.startAtFrame + ("duration" in segA ? (segA.duration ?? 0) : 0);

    // Check if any existing transition is near this gap
    const hasTransition = existingTransitions.some((t) => {
      const tFrame = t.startAtFrame;
      // Transition should be near the end of segA or start of segB
      return (
        Math.abs(tFrame - segAEnd) <= 10 ||
        Math.abs(tFrame - segB.startAtFrame) <= 10
      );
    });

    if (!hasTransition) {
      newEntries.push({
        type: "transition",
        style: "crossfade",
        duration: DEFAULT_TRANSITION_DURATION,
        startAtFrame: segAEnd,
      });
      stats.transitionsAdded++;
    }
  }

  // Insert new transitions into timeline
  manifest.timeline.push(...newEntries);

  // Re-sort after adding
  manifest.timeline.sort((a, b) => a.startAtFrame - b.startAtFrame);
}

// ── Effects ───────────────────────────────────────────────────

/**
 * Ensure video clips have effects applied. Applies smart defaults:
 *   - slowZoom on clips > 2s (if no zoom already)
 *   - fadeIn on the first video clip (if no fadeIn)
 *   - fadeOut on the last video clip (if no fadeOut)
 *   - Occasional grayscale or blur for variety
 */
function ensureEffects(
  manifest: DirectorManifest,
  stats: EnhancementStats,
): void {
  const videoClips = manifest.timeline.filter(
    (e): e is VideoClipEntry => e.type === "video_clip",
  );

  if (videoClips.length === 0) return;

  // Count how many clips already have effects
  const clipsWithEffects = videoClips.filter(
    (c) => c.effects && c.effects.length > 0,
  );

  // If 40%+ of clips already have effects, the LLM did its job — skip
  if (clipsWithEffects.length >= videoClips.length * 0.4) {
    logger.info(
      `[ManifestEnhancer] ${clipsWithEffects.length}/${videoClips.length} clips already have effects — skipping effect enhancement`,
    );
    return;
  }

  // Apply effects to clips that don't have them
  for (let i = 0; i < videoClips.length; i++) {
    const clip = videoClips[i];
    if (!clip.effects) clip.effects = [];

    const hasEffect = (type: string) => clip.effects!.some((e) => e.type === type);

    // slowZoom on clips longer than threshold (most common edit effect)
    if (clip.duration >= SLOW_ZOOM_MIN_DURATION && !hasEffect("slowZoom")) {
      // Alternate zoom direction for variety
      const zoomIn = i % 2 === 0;
      clip.effects.push({
        type: "slowZoom",
        from: zoomIn ? DEFAULT_ZOOM_FROM : DEFAULT_ZOOM_TO,
        to: zoomIn ? DEFAULT_ZOOM_TO : DEFAULT_ZOOM_FROM,
      });
      stats.effectsAdded++;
    }

    // fadeIn on the first clip
    if (i === 0 && !hasEffect("fadeIn")) {
      clip.effects.push({ type: "fadeIn", durationFrames: DEFAULT_FADE_DURATION });
      stats.effectsAdded++;
    }

    // fadeOut on the last clip
    if (i === videoClips.length - 1 && !hasEffect("fadeOut")) {
      clip.effects.push({ type: "fadeOut", durationFrames: DEFAULT_FADE_DURATION });
      stats.effectsAdded++;
    }

    // Every 4th clip gets grayscale for tonal variety (if not already grayscale)
    if (i > 0 && i % 4 === 0 && !hasEffect("grayscale") && videoClips.length > 4) {
      clip.effects.push({ type: "grayscale" });
      stats.effectsAdded++;
    }
  }
}

// ── Helpers ───────────────────────────────────────────────────

/** Get the total duration of the timeline in frames. */
function getTimelineDuration(manifest: DirectorManifest): number {
  let maxFrame = 0;
  for (const entry of manifest.timeline) {
    const end =
      entry.startAtFrame +
      ("duration" in entry ? (entry.duration ?? 0) : 0);
    if (end > maxFrame) maxFrame = end;
  }
  return maxFrame;
}

function normalizePath(p: string): string {
  return p.toLowerCase().replace(/\/+$/, "");
}

function pathBasename(p: string): string {
  return p.split("/").pop() ?? p;
}
