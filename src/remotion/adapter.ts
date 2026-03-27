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
 * Visual segment types that contribute to the composition duration.
 * Overlays and transitions are layered on top and must not inflate total length.
 */
const VISUAL_SEGMENT_TYPES = new Set(["video_clip", "title_card", "image_scene", "intro_card", "outro_card"]);

/**
 * Derive word-level frame timings from scene scriptText fields.
 * Used to ensure SmartCaptions word data is always fresh and correct
 * at render time, matching the exact scene positions in the manifest.
 */
function deriveWordTimingsFromTimeline(
  timeline: TimelineEntry[],
  fps: number,
  renderedPositions?: Map<number, number>,
): Array<{ word: string; start: number; end: number }> {
  const scenes = timeline
    .filter((e) => e.type !== "overlay" && e.type !== "transition" && "scriptText" in e && (e as unknown as Record<string, unknown>).scriptText)
    .sort((a, b) => a.startAtFrame - b.startAtFrame);

  const results: Array<{ word: string; start: number; end: number }> = [];
  const MIN_FRAMES = 4;

  for (const scene of scenes) {
    const scriptText = ((scene as unknown as Record<string, unknown>).scriptText as string)
      .replace(/\[PAUSE:\s*[\d.]+s?\]/gi, "")
      .replace(/\*/g, "");
    const words = scriptText.split(/\s+/).filter((w) => w.length > 0);
    if (words.length === 0) continue;

    const sceneDuration = ("duration" in scene ? ((scene as unknown as Record<string, unknown>).duration as number) : null) ?? fps;
    const startAtFrame = renderedPositions?.get(scene.startAtFrame) ?? scene.startAtFrame;
    const totalChars = words.reduce((n, w) => n + w.length, 0);

    const rawDurations = words.map((w) =>
      Math.max(MIN_FRAMES, Math.round(sceneDuration * (w.length / totalChars))),
    );
    const rawTotal = rawDurations.reduce((a, b) => a + b, 0);
    const scale = sceneDuration / rawTotal;
    const durations = rawDurations.map((d) => Math.max(MIN_FRAMES, Math.round(d * scale)));
    const durSum = durations.reduce((a, b) => a + b, 0);
    durations[durations.length - 1] += sceneDuration - durSum;

    let frame = startAtFrame;
    for (let i = 0; i < words.length; i++) {
      const end = Math.min(frame + durations[i], startAtFrame + sceneDuration);
      results.push({ word: words[i], start: frame, end });
      frame = end;
    }
  }

  return results;
}

/**
 * Find the transition between two adjacent segments.
 * Mirrors the composition's findTransitionBetween logic.
 */
function findTransBetween(
  transitions: TimelineItem[],
  segA: TimelineItem,
  segB: TimelineItem,
): TimelineItem | undefined {
  const segAEnd = segA.startAtFrame + ("durationInFrames" in segA ? (segA.durationInFrames ?? 0) : 0);
  const segBStart = segB.startAtFrame;
  const TOLERANCE = 30;
  return transitions.find((t) => t.type === "transition" && Math.abs(t.startAtFrame - segAEnd) <= TOLERANCE)
    ?? transitions.find((t) => t.type === "transition" && Math.abs(t.startAtFrame - segBStart) <= TOLERANCE)
    ?? transitions.find((t) => t.type === "transition" && t.startAtFrame >= segA.startAtFrame && t.startAtFrame <= segBStart + TOLERANCE);
}

/**
 * Compute the actual rendered start frame for each visual segment,
 * accounting for TransitionSeries overlap where transitions "eat" frames
 * from adjacent segments. Returns a Map from manifest startAtFrame → rendered frame.
 */
function computeRenderedLayout(adaptedTimeline: TimelineItem[]): Map<number, number> {
  const segments: TimelineItem[] = [];
  const transitions: TimelineItem[] = [];
  for (const item of adaptedTimeline) {
    if (!item?.type) continue;
    switch (item.type) {
      case "video_clip": case "title_card": case "image_scene": case "intro_card": case "outro_card":
        segments.push(item);
        break;
      case "transition":
        transitions.push(item);
        break;
    }
  }
  segments.sort((a, b) => a.startAtFrame - b.startAtFrame);

  const positionMap = new Map<number, number>();
  let renderedFrame = 0;

  for (let i = 0; i < segments.length; i++) {
    const seg = segments[i];
    const dur = "durationInFrames" in seg ? (seg.durationInFrames ?? 90) : 90;
    positionMap.set(seg.startAtFrame, renderedFrame);

    if (i < segments.length - 1) {
      const nextSeg = segments[i + 1];
      const nextDur = "durationInFrames" in nextSeg ? (nextSeg.durationInFrames ?? 90) : 90;
      const trans = findTransBetween(transitions, seg, nextSeg);
      let overlap = 0;
      if (trans && "durationInFrames" in trans) {
        overlap = Math.min(trans.durationInFrames ?? 0, dur, nextDur);
      }
      renderedFrame += dur - overlap;
    }
  }

  logger.info(`[Adapter] Rendered layout: ${segments.length} segments, total rendered frames=${renderedFrame}`);
  return positionMap;
}

/**
 * Calculate the total composition duration in frames from the timeline.
 * Only visual segments count — overlays and transitions are layered on top
 * and must not inflate the total render duration.
 */
function calculateDuration(timeline: TimelineEntry[], fps: number): number {
  let maxFrame = 0;
  for (const entry of timeline) {
    if (!VISUAL_SEGMENT_TYPES.has(entry.type)) continue;
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
        textOverlays: (entry.textOverlays ?? []).map((o) => ({
          id: o.id,
          text: o.text,
          position: o.position,
          customPosition: o.customPosition,
          fontSize: o.fontSize ?? 48,
          fontWeight: o.fontWeight ?? "bold",
          color: o.color ?? "#ffffff",
          backgroundColor: o.backgroundColor ?? "rgba(0,0,0,0.6)",
          borderRadius: o.borderRadius ?? 8,
          padding: o.padding ?? 16,
          animation: o.animation,
          startFrame: o.startFrame,
          durationFrames: o.durationFrames,
        })),
        horizontalCropOffset: entry.horizontalCropOffset ?? 50,
        fitMode: entry.fitMode ?? "cover",
      };
    case "title_card": {
      const bg = entry.background ?? "#1a1a1a";
      return {
        type: "title_card",
        title: entry.title,
        subtitle: entry.subtitle,
        background: bg.startsWith("#") ? bg : resolveMediaPath(bg, outputDir),
        startAtFrame: entry.startAtFrame,
        durationInFrames: entry.duration,
        animation: entry.animation ?? "fade",
      };
    }
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
    case "image_scene":
      return {
        type: "image_scene",
        src: resolveMediaPath(entry.src, outputDir),
        startAtFrame: entry.startAtFrame,
        durationInFrames: entry.duration,
        voiceover: entry.voiceover ? resolveMediaPath(entry.voiceover, outputDir) : undefined,
        voiceoverVolume: entry.voiceoverVolume ?? 1,
        kenBurns: {
          scaleFrom: entry.kenBurns?.scaleFrom ?? 1.0,
          scaleTo: entry.kenBurns?.scaleTo ?? 1.15,
          translateXFrom: entry.kenBurns?.translateXFrom ?? 0,
          translateXTo: entry.kenBurns?.translateXTo ?? -10,
          translateYFrom: entry.kenBurns?.translateYFrom ?? 0,
          translateYTo: entry.kenBurns?.translateYTo ?? -5,
        },
        effects: (entry.effects ?? []).map((e) => ({
          type: e.type,
          params: { ...e } as Record<string, unknown>,
        })),
        textOverlays: (entry.textOverlays ?? []).map((o) => ({
          id: o.id,
          text: o.text,
          position: o.position,
          customPosition: o.customPosition,
          fontSize: o.fontSize ?? 48,
          fontWeight: o.fontWeight ?? "bold",
          color: o.color ?? "#ffffff",
          backgroundColor: o.backgroundColor ?? "rgba(0,0,0,0.6)",
          borderRadius: o.borderRadius ?? 8,
          padding: o.padding ?? 16,
          animation: o.animation,
          startFrame: o.startFrame,
          durationFrames: o.durationFrames,
        })),
      };
    case "intro_card":
      return {
        type: "intro_card",
        title: entry.title ?? "",
        subtitle: entry.subtitle,
        backgroundSrc: entry.enhancedBackgroundSrc
          ? resolveMediaPath(entry.enhancedBackgroundSrc, outputDir)
          : entry.backgroundSrc
            ? resolveMediaPath(entry.backgroundSrc, outputDir)
            : undefined,
        logoSrc: entry.logoSrc ? resolveMediaPath(entry.logoSrc, outputDir) : undefined,
        startAtFrame: entry.startAtFrame,
        durationInFrames: entry.duration,
        animation: entry.animation ?? "fade-in",
      };
    case "outro_card":
      return {
        type: "outro_card",
        title: entry.title ?? "",
        subtitle: entry.subtitle,
        backgroundSrc: entry.enhancedBackgroundSrc
          ? resolveMediaPath(entry.enhancedBackgroundSrc, outputDir)
          : entry.backgroundSrc
            ? resolveMediaPath(entry.backgroundSrc, outputDir)
            : undefined,
        logoSrc: entry.logoSrc ? resolveMediaPath(entry.logoSrc, outputDir) : undefined,
        ctaText: entry.ctaText,
        startAtFrame: entry.startAtFrame,
        durationInFrames: entry.duration,
        animation: entry.animation ?? "fade-out",
      };
    default:
      throw new Error(`Unknown timeline entry type: ${(entry as { type: string }).type}`);
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

  // Adapt entries, clamp overlay durations, and drop overlays that start beyond the composition
  const adaptedTimeline = timeline.map((entry) => {
    const adapted = adaptTimelineEntry(entry, outputDir);
    if (adapted.type === "overlay" && "durationInFrames" in adapted && adapted.durationInFrames != null) {
      const maxDur = Math.max(0, durationInFrames - adapted.startAtFrame);
      if (adapted.durationInFrames > maxDur) {
        adapted.durationInFrames = maxDur;
      }
    }
    if (adapted.type === "overlay") {
      const wordsCount = Array.isArray((adapted.props as Record<string, unknown>)?.words)
        ? ((adapted.props as Record<string, unknown>).words as unknown[]).length
        : 0;
      logger.info(`[Adapter] Overlay: component=${adapted.component}, from=${adapted.startAtFrame}, dur=${adapted.durationInFrames ?? "∞"}, wordsCount=${wordsCount}`);
    }
    return adapted;
  }).filter((item) => {
    // Drop overlays whose start frame is at or beyond the composition end —
    // they can't be visible and Remotion throws if durationInFrames is 0.
    if (item.type === "overlay" && item.startAtFrame >= durationInFrames) {
      logger.warn(`[Adapter] Dropping out-of-bounds overlay: component=${item.component}, from=${item.startAtFrame}, compositionDur=${durationInFrames}`);
      return false;
    }
    return true;
  });

  // Compute actual rendered positions accounting for TransitionSeries overlaps.
  // Transitions "eat" frames from adjacent segments, shifting all subsequent
  // content earlier than the manifest's startAtFrame values would suggest.
  const renderedLayout = computeRenderedLayout(adaptedTimeline);

  // SmartCaptions word timings must use the rendered positions (not manifest
  // positions) so captions align with the actual visual content.
  for (const item of adaptedTimeline) {
    if (item.type === "overlay" && item.component === "SmartCaptions") {
      const freshWords = deriveWordTimingsFromTimeline(timeline, composition.fps, renderedLayout);
      if (freshWords.length > 0) {
        (item.props as Record<string, unknown>).words = freshWords;
        logger.info(`[Adapter] SmartCaptions: re-derived ${freshWords.length} words, first=${freshWords[0].start}, last=${freshWords[freshWords.length - 1].end}`);
      }
      // Force overlay to start at frame 0 — word timings are absolute
      item.startAtFrame = 0;
      item.durationInFrames = durationInFrames;
    }
  }

  return {
    templateId: manifest.templateId,
    projectTitle: manifest.projectTitle,
    width: composition.width,
    height: composition.height,
    fps: composition.fps,
    durationInFrames,
    timeline: adaptedTimeline,
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
    if (item.type === "image_scene") {
      const stagedSrc = stageMediaFile(item.src, bundleDir);
      if (!stagedSrc) {
        logger.warn(`[Adapter] Image scene file not found on disk — src will be unusable: "${item.src}"`);
        return item;
      }
      let stagedVo: string | undefined;
      if (item.voiceover) {
        stagedVo = stageMediaFile(item.voiceover, bundleDir) ?? undefined;
        if (!stagedVo) {
          logger.warn(`[Adapter] Image scene voiceover not found on disk — dropping: "${item.voiceover}"`);
        }
      }
      return { ...item, src: stagedSrc, voiceover: stagedVo };
    }
    // Stage media referenced in overlay props (e.g. ImageOverlay.src)
    if (item.type === "overlay" && item.props && typeof item.props === "object") {
      const overlayProps = item.props as Record<string, unknown>;
      if (typeof overlayProps.src === "string" && overlayProps.src.length > 0) {
        const staged = stageMediaFile(overlayProps.src, bundleDir);
        if (staged) {
          return { ...item, props: { ...overlayProps, src: staged } };
        }
        logger.warn(`[Adapter] Overlay media file not found on disk — src will be unusable: "${overlayProps.src}"`);
      }
    }
    // Stage title_card background image (if it's a file path, not a CSS color)
    if (item.type === "title_card" && !item.background.startsWith("#")) {
      const staged = stageMediaFile(item.background, bundleDir);
      if (staged) {
        return { ...item, background: staged };
      }
      logger.warn(`[Adapter] Title card background file not found on disk — background will be unusable: "${item.background}"`);
    }
    // Stage intro/outro card background and logo media
    if (item.type === "intro_card" || item.type === "outro_card") {
      let bgSrc = item.backgroundSrc;
      let logo = item.logoSrc;
      if (bgSrc) {
        const staged = stageMediaFile(bgSrc, bundleDir);
        bgSrc = staged ?? bgSrc;
      }
      if (logo) {
        const staged = stageMediaFile(logo, bundleDir);
        logo = staged ?? logo;
      }
      return { ...item, backgroundSrc: bgSrc, logoSrc: logo };
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
