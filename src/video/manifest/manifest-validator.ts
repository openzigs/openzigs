/**
 * Director Mode — Semantic Manifest Validator
 * Issue #240: Beyond-schema validation logic that catches runtime issues
 * such as missing source files, frame overflows, and timeline gaps.
 */

import fs from "node:fs";
import type { DirectorManifest, ManifestValidationResult, TimelineEntry } from "./manifest-types.js";
import { DirectorManifestSchema } from "./manifest-schema.js";

/**
 * Validate a raw JSON object against the Zod schema + semantic rules.
 * Returns errors for hard failures and warnings for soft issues.
 */
export function validateManifest(
  raw: unknown,
  options: { checkFiles?: boolean } = {},
): ManifestValidationResult {
  const { checkFiles = false } = options;
  const errors: string[] = [];
  const warnings: string[] = [];

  // ── Phase 1: Zod schema validation ────────────────────────
  const result = DirectorManifestSchema.safeParse(raw);
  if (!result.success) {
    for (const issue of result.error.issues) {
      errors.push(`[schema] ${issue.path.join(".")}: ${issue.message}`);
    }
    return { valid: false, errors, warnings };
  }

  const manifest = result.data as DirectorManifest;

  // ── Phase 2: Semantic validation ──────────────────────────
  validateTimeline(manifest, errors, warnings);
  validateAudioReferences(manifest, errors, warnings, checkFiles);
  validateComposition(manifest, warnings);
  validateEffects(manifest, errors);

  if (checkFiles) {
    validateSourceFiles(manifest, errors);
  }

  return { valid: errors.length === 0, errors, warnings };
}

/**
 * Validate timeline ordering and contiguity.
 */
function validateTimeline(
  manifest: DirectorManifest,
  errors: string[],
  warnings: string[],
): void {
  const { timeline, composition } = manifest;

  if (timeline.length === 0) {
    errors.push("[timeline] Timeline must contain at least one entry");
    return;
  }

  // Check ordering: startAtFrame should be non-decreasing
  // (transitions can overlap slightly with adjacent clips)
  let prevStart = -1;
  for (let i = 0; i < timeline.length; i++) {
    const entry = timeline[i];
    if (entry.startAtFrame < prevStart && entry.type !== "transition" && entry.type !== "overlay") {
      warnings.push(
        `[timeline] Entry ${i} (${entry.type}) startAtFrame=${entry.startAtFrame} is before previous entry startAtFrame=${prevStart}`,
      );
    }
    if (entry.type !== "overlay") {
      prevStart = entry.startAtFrame;
    }
  }

  // Check for large gaps (> 30 frames) between non-overlay entries
  const sequentialEntries = timeline.filter(
    (e): e is Exclude<TimelineEntry, { type: "overlay" }> => e.type !== "overlay",
  );
  for (let i = 1; i < sequentialEntries.length; i++) {
    const prev = sequentialEntries[i - 1];
    const prevEnd = prev.startAtFrame + ("duration" in prev ? prev.duration : 0);
    const curr = sequentialEntries[i];
    const gap = curr.startAtFrame - prevEnd;
    if (gap > 30) {
      warnings.push(
        `[timeline] ${gap}-frame gap between entries ${i - 1} and ${i} (frames ${prevEnd}–${curr.startAtFrame})`,
      );
    }
  }

  // Warn if total duration seems unreasonably long (> 1 hour at given fps)
  const lastEntry = timeline[timeline.length - 1]!;
  const lastFrame = lastEntry.startAtFrame + ("duration" in lastEntry ? (lastEntry.duration ?? 0) : 0);
  const totalSeconds = lastFrame / composition.fps;
  if (totalSeconds > 3600) {
    warnings.push(
      `[timeline] Estimated duration ${Math.round(totalSeconds)}s exceeds 1 hour — verify manifest`,
    );
  }
}

/**
 * Validate audio references (music track, voiceover source).
 */
function validateAudioReferences(
  manifest: DirectorManifest,
  errors: string[],
  warnings: string[],
  checkFiles: boolean,
): void {
  const { audioLayer } = manifest;

  if (audioLayer.music && checkFiles) {
    if (!fs.existsSync(audioLayer.music.track)) {
      errors.push(`[audio] Music track not found: ${audioLayer.music.track}`);
    }
  }

  if (audioLayer.voiceover && checkFiles) {
    if (!fs.existsSync(audioLayer.voiceover.source)) {
      errors.push(`[audio] Voiceover source not found: ${audioLayer.voiceover.source}`);
    }
  }

  // Warn if script mode has no voiceover
  if (manifest.metadata?.productionMode === "script" && !audioLayer.voiceover) {
    warnings.push("[audio] Script-driven mode without voiceover — is this intentional?");
  }

  // Warn if music volume seems too high for voiceover
  if (audioLayer.music && audioLayer.voiceover && audioLayer.music.volume > 0.4 && !audioLayer.music.ducking) {
    warnings.push("[audio] Music volume > 0.4 without ducking — voiceover may be hard to hear");
  }
}

/**
 * Validate composition config against template expectations.
 */
function validateComposition(
  manifest: DirectorManifest,
  warnings: string[],
): void {
  const { composition, templateId } = manifest;

  // ContentCreator template expects vertical (9:16) aspect ratio
  if (templateId === "ContentCreator") {
    if (composition.width > composition.height) {
      warnings.push(
        `[composition] ContentCreator template expects vertical (9:16) but got ${composition.width}x${composition.height}`,
      );
    }
  }

  // Non-standard FPS
  if (![24, 25, 30, 50, 60].includes(composition.fps)) {
    warnings.push(`[composition] Non-standard fps=${composition.fps} — rendering may be slower`);
  }
}

/**
 * Validate video effects on clips.
 */
function validateEffects(
  manifest: DirectorManifest,
  errors: string[],
): void {
  for (let i = 0; i < manifest.timeline.length; i++) {
    const entry = manifest.timeline[i];
    if (entry.type !== "video_clip" || !entry.effects) continue;

    for (const effect of entry.effects) {
      if (effect.type === "slowZoom") {
        if (effect.from === effect.to) {
          errors.push(`[effects] Entry ${i}: slowZoom from === to (${effect.from}) — no visible zoom`);
        }
      }
      if (effect.type === "blur") {
        if (effect.endFrame <= effect.startFrame) {
          errors.push(`[effects] Entry ${i}: blur endFrame (${effect.endFrame}) <= startFrame (${effect.startFrame})`);
        }
      }
      if (effect.type === "speedRamp") {
        if (effect.endFrame <= effect.startFrame) {
          errors.push(`[effects] Entry ${i}: speedRamp endFrame (${effect.endFrame}) <= startFrame (${effect.startFrame})`);
        }
      }
    }
  }
}

/**
 * Validate that all referenced source files exist on disk.
 */
function validateSourceFiles(
  manifest: DirectorManifest,
  errors: string[],
): void {
  for (let i = 0; i < manifest.timeline.length; i++) {
    const entry = manifest.timeline[i];
    if (entry.type === "video_clip") {
      if (!fs.existsSync(entry.source)) {
        errors.push(`[source] Entry ${i}: video source not found: ${entry.source}`);
      }
    }
  }
}
