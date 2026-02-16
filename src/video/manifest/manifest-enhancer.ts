/**
 * Director Mode — Manifest Enhancer
 * Deterministic post-processing that guarantees effects, transitions, and
 * multi-clip coverage in LLM-generated manifests.
 *
 * The LLM is instructed to add effects and transitions but often doesn't.
 * This module applies smart defaults AFTER repair/validation so the final
 * video always has professional-quality production values.
 */

import { logger } from "../../logging/logger.js";
import type { DirectorManifest, VideoClipEntry, TransitionEntry } from "./manifest-types.js";

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

export interface EnhancementStats {
  transitionsAdded: number;
  effectsAdded: number;
  clipsInjected: number;
  warnings: string[];
}

/**
 * Enhance a manifest with smart defaults for transitions, effects, and
 * multi-clip coverage. Mutates the manifest in-place.
 *
 * @param manifest - The LLM-generated (and already repaired) manifest
 * @param sourceClips - Array of source clip file paths that were ingested
 * @returns Statistics about what was enhanced
 */
export function enhanceManifest(
  manifest: DirectorManifest,
  sourceClips: string[],
): EnhancementStats {
  const stats: EnhancementStats = {
    transitionsAdded: 0,
    effectsAdded: 0,
    clipsInjected: 0,
    warnings: [],
  };

  // 1. Ensure all source clips are represented
  ensureMultiClipCoverage(manifest, sourceClips, stats);

  // 2. Ensure transitions between adjacent video clips
  ensureTransitions(manifest, stats);

  // 3. Ensure effects on video clips (slowZoom, fadeIn, fadeOut)
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

// ── Multi-Clip Coverage ───────────────────────────────────────

/**
 * Verify that every source clip appears in the timeline.
 * If a clip is missing, inject segments from it.
 */
function ensureMultiClipCoverage(
  manifest: DirectorManifest,
  sourceClips: string[],
  stats: EnhancementStats,
): void {
  if (sourceClips.length <= 1) return;

  const videoClips = manifest.timeline.filter(
    (e): e is VideoClipEntry => e.type === "video_clip",
  );

  // Normalize paths for comparison (strip trailing slash, case-insensitive on macOS)
  const usedSources = new Set(
    videoClips.map((c) => normalizePath(c.source)),
  );

  const missingClips = sourceClips.filter(
    (src) => !usedSources.has(normalizePath(src)),
  );

  if (missingClips.length === 0) return;

  stats.warnings.push(
    `LLM ignored ${missingClips.length} of ${sourceClips.length} source clips: ${missingClips.map(p => pathBasename(p)).join(", ")}`,
  );

  // Find the last frame in the current timeline
  let lastFrame = 0;
  for (const entry of manifest.timeline) {
    const end = entry.startAtFrame + ("duration" in entry ? (entry.duration ?? 0) : 0);
    if (end > lastFrame) lastFrame = end;
  }

  const fps = manifest.composition.fps || 30;

  // Inject segments from each missing clip
  for (const missingPath of missingClips) {
    // Add a crossfade transition before the injected clip
    const transition: TransitionEntry = {
      type: "transition",
      style: "crossfade",
      duration: DEFAULT_TRANSITION_DURATION,
      startAtFrame: lastFrame,
    };
    manifest.timeline.push(transition);
    stats.transitionsAdded++;

    // Insert 3 segments from the missing clip at different trim points
    const segmentDuration = fps * 4; // 4 seconds each
    const segmentCount = 3;

    for (let i = 0; i < segmentCount; i++) {
      const clipEntry: VideoClipEntry = {
        type: "video_clip",
        source: missingPath,
        startAtFrame: lastFrame,
        trimStart: i * segmentDuration * 2, // Skip around the clip
        duration: segmentDuration,
        volume: 0.8,
        effects: [
          { type: "slowZoom", from: DEFAULT_ZOOM_FROM, to: DEFAULT_ZOOM_TO },
        ],
      };

      // Add fadeIn to first injected segment
      if (i === 0) {
        clipEntry.effects!.push({ type: "fadeIn", durationFrames: DEFAULT_FADE_DURATION });
      }

      manifest.timeline.push(clipEntry);
      lastFrame += segmentDuration;
      stats.clipsInjected++;

      // Add transition between injected segments
      if (i < segmentCount - 1) {
        const innerTransition: TransitionEntry = {
          type: "transition",
          style: "crossfade",
          duration: DEFAULT_TRANSITION_DURATION,
          startAtFrame: lastFrame,
        };
        manifest.timeline.push(innerTransition);
        stats.transitionsAdded++;
      }
    }
  }

  // Update metadata.sourceClips to include all clips
  if (manifest.metadata) {
    const metaSources = new Set(manifest.metadata.sourceClips.map(normalizePath));
    for (const src of sourceClips) {
      if (!metaSources.has(normalizePath(src))) {
        manifest.metadata.sourceClips.push(src);
      }
    }
  }
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

function normalizePath(p: string): string {
  return p.toLowerCase().replace(/\/+$/, "");
}

function pathBasename(p: string): string {
  return p.split("/").pop() ?? p;
}
