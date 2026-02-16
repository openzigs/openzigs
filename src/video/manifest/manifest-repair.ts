/**
 * Director Mode — Manifest Repair / Normalization
 * Normalizes common LLM output deviations before Zod validation.
 *
 * LLMs are creative — they may use "fade" instead of "crossfade",
 * "slide" instead of "slide-up", fractional frame numbers, etc.
 * This module fixes those issues deterministically so the manifest
 * passes strict schema validation.
 */

import { logger } from "../../logging/logger.js";

/**
 * Map of non-standard transition style names → valid enum values.
 * Key = lowercase LLM output, Value = valid schema value.
 */
const TRANSITION_STYLE_ALIASES: Record<string, string> = {
  fade: "crossfade",
  "fade-in": "crossfade",
  "fade-out": "crossfade",
  "dip-to-black": "dissolve",
  "dip-to-white": "dissolve",
  blend: "crossfade",
  mix: "crossfade",
  slide: "wipe-left",
  "slide-left": "wipe-left",
  "slide-right": "wipe-right",
  wipe: "wipe-left",
  "hard-cut": "cut",
  "jump-cut": "cut",
  none: "cut",
  straight: "cut",
};

const VALID_TRANSITION_STYLES = new Set(["crossfade", "wipe-left", "wipe-right", "dissolve", "cut"]);

const VALID_OVERLAY_COMPONENTS = new Set(["SmartCaptions", "LowerThird", "LogoWatermark", "ProgressBar"]);

const VALID_ANIMATION_STYLES = new Set(["fade", "slide-up", "typewriter"]);

/**
 * Repair/normalize a raw LLM-produced manifest object in-place.
 * Returns the number of repairs made.
 */
export function repairManifest(raw: Record<string, unknown>): number {
  let repairs = 0;

  // ── Strip nulls from optional string fields ────────────
  // LLMs often set optional fields to null instead of omitting them.
  // Zod's `.optional()` rejects null — delete the key entirely.
  repairs += stripNullFields(raw, ["projectTitle"]);

  // Branding sub-object
  const branding = raw.branding as Record<string, unknown> | undefined;
  if (branding && typeof branding === "object") {
    repairs += stripNullFields(branding, ["logoUrl", "accentColor", "watermarkPosition"]);
  }

  // Repair timeline entries
  const timeline = raw.timeline;
  if (Array.isArray(timeline)) {
    for (let i = 0; i < timeline.length; i++) {
      const entry = timeline[i] as Record<string, unknown>;
      if (!entry || typeof entry !== "object") continue;

      const type = entry.type;

      // ── Transition style normalization ────────────────
      if (type === "transition") {
        const style = typeof entry.style === "string" ? entry.style.toLowerCase().trim() : "";
        if (!VALID_TRANSITION_STYLES.has(style)) {
          const mapped = TRANSITION_STYLE_ALIASES[style] ?? "crossfade";
          logger.info(`[ManifestRepair] timeline[${i}]: transition style "${entry.style}" → "${mapped}"`);
          entry.style = mapped;
          repairs++;
        }
      }

      // ── Fractional frame numbers → integers ──────────
      if (typeof entry.startAtFrame === "number" && !Number.isInteger(entry.startAtFrame)) {
        entry.startAtFrame = Math.round(entry.startAtFrame as number);
        repairs++;
      }
      if (typeof entry.duration === "number" && !Number.isInteger(entry.duration)) {
        entry.duration = Math.max(1, Math.round(entry.duration as number));
        repairs++;
      }
      if (typeof entry.trimStart === "number" && !Number.isInteger(entry.trimStart)) {
        entry.trimStart = Math.max(0, Math.round(entry.trimStart as number));
        repairs++;
      }

      // ── Negative startAtFrame ────────────────────────
      if (typeof entry.startAtFrame === "number" && entry.startAtFrame < 0) {
        entry.startAtFrame = 0;
        repairs++;
      }

      // ── Zero-duration clips ──────────────────────────
      if (type === "video_clip" || type === "title_card" || type === "transition") {
        if (typeof entry.duration === "number" && entry.duration < 1) {
          entry.duration = 30; // 1 second at 30fps
          repairs++;
        }
      }

      // ── Title card animation normalization ───────────
      if (type === "title_card") {
        // Strip null optional string fields (background, subtitle)
        repairs += stripNullFields(entry, ["background", "subtitle"]);

        if (typeof entry.animation === "string") {
          const anim = entry.animation.toLowerCase().trim();
          if (!VALID_ANIMATION_STYLES.has(anim)) {
            // Common aliases
            if (anim.includes("slide")) entry.animation = "slide-up";
            else if (anim.includes("type")) entry.animation = "typewriter";
            else entry.animation = "fade";
            repairs++;
          }
        }
      }

      // ── Overlay component name normalization ─────────
      if (type === "overlay" && typeof entry.component === "string") {
        if (!VALID_OVERLAY_COMPONENTS.has(entry.component as string)) {
          // Try case-insensitive match
          const lower = (entry.component as string).toLowerCase();
          for (const valid of VALID_OVERLAY_COMPONENTS) {
            if (valid.toLowerCase() === lower) {
              entry.component = valid;
              repairs++;
              break;
            }
          }
        }
      }

      // ── Volume clamping ──────────────────────────────
      if (typeof entry.volume === "number") {
        const vol = entry.volume as number;
        if (vol < 0) { entry.volume = 0; repairs++; }
        else if (vol > 1) { entry.volume = 1; repairs++; }
      }

      // ── Effect repairs ───────────────────────────────
      if (Array.isArray(entry.effects)) {
        for (const effect of entry.effects as Record<string, unknown>[]) {
          if (!effect || typeof effect !== "object") continue;
          // Fix fractional frame numbers in effects
          for (const key of ["startFrame", "endFrame", "durationFrames"]) {
            if (typeof effect[key] === "number" && !Number.isInteger(effect[key])) {
              effect[key] = Math.max(0, Math.round(effect[key] as number));
              repairs++;
            }
          }
        }
      }
    }
  }

  // ── Audio layer repairs ──────────────────────────────────
  const audioLayer = raw.audioLayer as Record<string, unknown> | undefined;
  if (audioLayer && typeof audioLayer === "object") {
    const music = audioLayer.music as Record<string, unknown> | undefined;
    if (music && typeof music === "object") {
      // Clamp volume
      if (typeof music.volume === "number") {
        const vol = music.volume as number;
        if (vol < 0) { music.volume = 0; repairs++; }
        else if (vol > 1) { music.volume = 1; repairs++; }
      }
      // Fix fractional frame numbers
      for (const key of ["fadeInFrames", "fadeOutFrames"]) {
        if (typeof music[key] === "number" && !Number.isInteger(music[key])) {
          music[key] = Math.max(0, Math.round(music[key] as number));
          repairs++;
        }
      }
    }
  }

  // ── Metadata repairs ─────────────────────────────────────
  const metadata = raw.metadata as Record<string, unknown> | undefined;
  if (metadata && typeof metadata === "object") {
    // Fix llmTokensUsed if fractional
    if (typeof metadata.llmTokensUsed === "number" && !Number.isInteger(metadata.llmTokensUsed)) {
      metadata.llmTokensUsed = Math.ceil(metadata.llmTokensUsed as number);
      repairs++;
    }
    // Ensure sourceClips is an array
    if (!Array.isArray(metadata.sourceClips)) {
      metadata.sourceClips = [];
      repairs++;
    }
  }

  if (repairs > 0) {
    logger.info(`[ManifestRepair] Applied ${repairs} repair(s) to LLM manifest output`);
  }

  return repairs;
}

/**
 * Delete keys from an object where the value is null.
 * Zod's `.optional()` only accepts `undefined`, not `null`.
 * LLMs frequently set optional fields to null instead of omitting them.
 */
function stripNullFields(obj: Record<string, unknown>, keys: string[]): number {
  let count = 0;
  for (const key of keys) {
    if (key in obj && obj[key] === null) {
      delete obj[key];
      count++;
    }
  }
  return count;
}
