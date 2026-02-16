/**
 * Director Mode — Manifest-to-InputProps Adapter
 * Issue #245: Transforms a DirectorManifest into Remotion CompositionInputProps.
 *
 * The manifest is the LLM-generated data contract; the input props are what
 * Remotion compositions consume at render time. This adapter bridges the two.
 */

import type { DirectorManifest, TimelineEntry } from "../video/manifest/manifest-types.js";
import type { CompositionInputProps, TimelineItem, AudioProps, BrandingProps } from "./input-props.js";
import { resolveMediaPath, stageMediaFile } from "./media-resolver.js";
import { logger } from "../logging/logger.js";

/**
 * Calculate the total composition duration in frames from the timeline.
 * This is the frame number of the last entry's end point.
 */
function calculateDuration(timeline: TimelineEntry[], fps: number): number {
  let maxFrame = 0;
  for (const entry of timeline) {
    const entryEnd = entry.startAtFrame + ("duration" in entry ? (entry.duration ?? 0) : 0);
    if (entryEnd > maxFrame) maxFrame = entryEnd;
  }
  // Minimum 1 second
  return Math.max(maxFrame, fps);
}

/**
 * Transform a manifest TimelineEntry into a Remotion TimelineItem.
 */
function adaptTimelineEntry(entry: TimelineEntry, outputDir: string): TimelineItem {
  switch (entry.type) {
    case "video_clip":
      return {
        type: "video_clip",
        src: resolveMediaPath(entry.source, outputDir),
        startAtFrame: entry.startAtFrame,
        trimStartFrame: entry.trimStart,
        durationInFrames: entry.duration,
        volume: entry.volume ?? 1,
        effects: (entry.effects ?? []).map((e) => ({
          type: e.type,
          params: { ...e } as Record<string, unknown>,
        })),
      };
    case "title_card":
      return {
        type: "title_card",
        title: entry.title,
        subtitle: entry.subtitle,
        background: entry.background ?? "#1a1a1a",
        startAtFrame: entry.startAtFrame,
        durationInFrames: entry.duration,
        animation: entry.animation ?? "fade",
      };
    case "overlay":
      return {
        type: "overlay",
        component: entry.component,
        props: entry.props,
        startAtFrame: entry.startAtFrame,
        durationInFrames: entry.duration,
      };
    case "transition":
      return {
        type: "transition",
        style: entry.style,
        durationInFrames: entry.duration,
        startAtFrame: entry.startAtFrame,
      };
  }
}

/**
 * Transform manifest audio config into Remotion AudioProps.
 */
function adaptAudio(manifest: DirectorManifest, outputDir: string): AudioProps {
  const music = manifest.audioLayer?.music;
  const voiceover = manifest.audioLayer?.voiceover;

  return {
    music: music
      ? {
          src: resolveMediaPath(music.track, outputDir),
          volume: music.volume ?? 1,
          loop: music.loop ?? true,
          fadeInFrames: music.fadeInFrames ?? 0,
          fadeOutFrames: music.fadeOutFrames ?? 0,
          ducking: music.ducking ?? false,
        }
      : null,
    voiceover: voiceover
      ? {
          src: resolveMediaPath(voiceover.source, outputDir),
          volume: voiceover.volume ?? 1,
          startAtFrame: voiceover.startAtFrame ?? 0,
        }
      : null,
  };
}

/**
 * Transform manifest branding into Remotion BrandingProps.
 */
function adaptBranding(manifest: DirectorManifest): BrandingProps {
  const b = manifest.branding;
  return {
    logoUrl: b?.logoUrl,
    accentColor: b?.accentColor ?? "#3b82f6",
    fontFamily: b?.fontFamily ?? "Inter, system-ui, sans-serif",
    watermarkOpacity: b?.watermarkOpacity ?? 0.3,
    watermarkPosition: b?.watermarkPosition ?? "bottom-right",
  };
}

/**
 * Convert a DirectorManifest into Remotion CompositionInputProps.
 *
 * @param manifest - The LLM-generated director manifest
 * @param outputDir - Base directory for resolving relative media paths
 * @returns Validated CompositionInputProps ready for Remotion rendering
 */
export function adaptManifest(manifest: DirectorManifest, outputDir: string): CompositionInputProps {
  const { composition, timeline } = manifest;
  const durationInFrames = calculateDuration(timeline, composition.fps);

  return {
    templateId: manifest.templateId,
    projectTitle: manifest.projectTitle,
    width: composition.width,
    height: composition.height,
    fps: composition.fps,
    durationInFrames,
    timeline: timeline.map((entry) => adaptTimelineEntry(entry, outputDir)),
    audio: adaptAudio(manifest, outputDir),
    branding: adaptBranding(manifest),
  };
}

/**
 * Stage all local media files referenced in the input props into the
 * Remotion bundle directory so they can be served via HTTP.
 *
 * Returns a shallow copy of the input props with updated media paths.
 * Remote URLs (http/https) are left unchanged.
 *
 * @param props - The adapted composition input props
 * @param bundleDir - The Remotion bundle serve directory
 */
export function stageInputPropsMedia(
  props: CompositionInputProps,
  bundleDir: string,
): CompositionInputProps {
  const stagedTimeline = props.timeline.map((item) => {
    if (item.type === "video_clip") {
      const staged = stageMediaFile(item.src, bundleDir);
      if (!staged) {
        logger.warn(`[Adapter] Video clip file not found on disk — src will be unusable: "${item.src}"`);
        return item;
      }
      return { ...item, src: staged };
    }
    return item;
  });

  // Music and voiceover may reference files that don't exist (LLM-generated
  // track names like "uplifting_background.mp3").  Drop them gracefully.
  const stagedMusic = props.audio.music
    ? (() => {
        const staged = stageMediaFile(props.audio.music!.src, bundleDir);
        if (!staged) {
          logger.warn(`[Adapter] Music file not found on disk — dropping music track: "${props.audio.music!.src}"`);
        }
        return staged ? { ...props.audio.music!, src: staged } : null;
      })()
    : null;

  const stagedVoiceover = props.audio.voiceover
    ? (() => {
        const staged = stageMediaFile(props.audio.voiceover!.src, bundleDir);
        if (!staged) {
          logger.warn(`[Adapter] Voiceover file not found on disk — dropping voiceover: "${props.audio.voiceover!.src}"`);
        }
        return staged ? { ...props.audio.voiceover!, src: staged } : null;
      })()
    : null;

  const stagedAudio = { music: stagedMusic, voiceover: stagedVoiceover };

  return { ...props, timeline: stagedTimeline, audio: stagedAudio };
}
