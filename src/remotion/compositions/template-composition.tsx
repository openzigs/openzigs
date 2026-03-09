/**
 * Director Mode — Template Composition
 * Issue #246: The main Remotion composition component that renders
 * an entire timeline with transitions, overlays, and audio.
 *
 * This single composition handles all four templates — the templateId
 * controls styling defaults (font, colors, etc.) while the timeline
 * drives the actual content.
 */

import React, { useEffect, useState } from "react";
import {
  AbsoluteFill,
  Sequence,
  Audio,
  useVideoConfig,
  Loop,
  interpolate,
  useCurrentFrame,
  delayRender,
  continueRender,
} from "remotion";
import { TransitionSeries } from "@remotion/transitions";
import type { CompositionInputProps, TimelineItem } from "../input-props";
import { TitleCard } from "../components/title-card";
import { SmartCaptions } from "../components/smart-captions";
import { LowerThird } from "../components/lower-third";
import { LogoWatermark } from "../components/logo-watermark";
import { ProgressBar } from "../components/progress-bar";
import { VideoClipSegment } from "../components/video-clip-segment";
import { ImageSceneSegment } from "../components/image-scene-segment";
import { ImageOverlay } from "../components/image-overlay";
import { TextOverlayLayer } from "../components/text-overlay-layer";
import { IntroCard } from "../components/intro-card";
import { OutroCard } from "../components/outro-card";
import { mapTransition } from "../util/transition-mapper";

/**
 * Separate the timeline into visual segments (clips/titles) and overlays.
 * Transitions are attached to the segments they precede.
 */
function partitionTimeline(timeline: TimelineItem[]) {
  const segments: TimelineItem[] = [];
  const overlays: TimelineItem[] = [];
  const transitions: TimelineItem[] = [];

  for (const item of timeline) {
    if (!item || !item.type) continue;
    switch (item.type) {
      case "video_clip":
      case "title_card":
      case "image_scene":
      case "intro_card":
      case "outro_card":
        segments.push(item);
        break;
      case "overlay":
        overlays.push(item);
        break;
      case "transition":
        transitions.push(item);
        break;
    }
  }

  // Sort segments by startAtFrame
  segments.sort((a, b) => a.startAtFrame - b.startAtFrame);

  return { segments, overlays, transitions };
}

/**
 * Find the transition that should occur between two adjacent segments.
 *
 * Strategy (ordered by priority):
 *   1. Transition whose startAtFrame is near segA's end (±30 frames)
 *   2. Transition whose startAtFrame is near segB's start (±30 frames)
 *   3. Transition whose startAtFrame falls anywhere between segA start and segB end
 *
 * This is deliberately generous because LLMs place transitions inconsistently —
 * sometimes at the end of the outgoing clip, sometimes at the start of the
 * incoming clip, sometimes at an arbitrary frame in between.
 */
function findTransitionBetween(
  transitions: TimelineItem[],
  segA: TimelineItem,
  segB: TimelineItem,
): TimelineItem | undefined {
  const segAEnd =
    segA.startAtFrame +
    ("durationInFrames" in segA ? (segA.durationInFrames ?? 0) : 0);
  const segBStart = segB.startAtFrame;

  // Tolerance: 30 frames (~1 second at 30fps) — generous enough for LLM jitter
  const TOLERANCE = 30;

  // Priority 1: near the end of segment A
  const nearEnd = transitions.find(
    (t) =>
      t.type === "transition" &&
      Math.abs(t.startAtFrame - segAEnd) <= TOLERANCE,
  );
  if (nearEnd) return nearEnd;

  // Priority 2: near the start of segment B
  const nearStart = transitions.find(
    (t) =>
      t.type === "transition" &&
      Math.abs(t.startAtFrame - segBStart) <= TOLERANCE,
  );
  if (nearStart) return nearStart;

  // Priority 3: anywhere between the two segments (expanded range)
  const inBetween = transitions.find(
    (t) =>
      t.type === "transition" &&
      t.startAtFrame >= segA.startAtFrame &&
      t.startAtFrame <= segBStart + TOLERANCE,
  );
  return inBetween;
}

/**
 * Render a segment (video clip or title card) as a React element.
 */
function renderSegment(
  item: TimelineItem,
  branding: CompositionInputProps["branding"],
): React.ReactElement | null {
  switch (item.type) {
    case "video_clip":
      return (
        <AbsoluteFill>
          <VideoClipSegment
            src={item.src}
            trimStartFrame={item.trimStartFrame}
            durationInFrames={item.durationInFrames}
            volume={item.volume}
            effects={item.effects}
            horizontalCropOffset={item.horizontalCropOffset}
            fitMode={item.fitMode}
          />
          <TextOverlayLayer overlays={item.textOverlays ?? []} />
        </AbsoluteFill>
      );
    case "title_card":
      return (
        <TitleCard
          title={item.title}
          subtitle={item.subtitle}
          background={item.background}
          animation={item.animation}
          fontFamily={branding.fontFamily}
          accentColor={branding.accentColor}
        />
      );
    case "image_scene":
      return (
        <AbsoluteFill>
          <ImageSceneSegment
            src={item.src}
            durationInFrames={item.durationInFrames}
            voiceover={item.voiceover}
            voiceoverVolume={item.voiceoverVolume}
            kenBurns={item.kenBurns}
            effects={item.effects}
          />
          <TextOverlayLayer overlays={item.textOverlays ?? []} />
        </AbsoluteFill>
      );
    case "intro_card":
      return (
        <IntroCard
          title={item.title}
          subtitle={item.subtitle}
          backgroundSrc={item.backgroundSrc}
          logoSrc={item.logoSrc}
          animation={item.animation}
        />
      );
    case "outro_card":
      return (
        <OutroCard
          title={item.title}
          subtitle={item.subtitle}
          backgroundSrc={item.backgroundSrc}
          logoSrc={item.logoSrc}
          ctaText={item.ctaText}
          durationInFrames={item.durationInFrames}
          animation={item.animation}
        />
      );
    default:
      return null;
  }
}

/**
 * Render an overlay component.
 */
function renderOverlay(
  item: TimelineItem,
  branding: CompositionInputProps["branding"],
): React.ReactElement | null {
  if (item.type !== "overlay") return null;

  const props = item.props as Record<string, unknown>;

  switch (item.component) {
    case "SmartCaptions":
      return (
        <SmartCaptions
          words={(props.words as Array<{ word: string; start: number; end: number }>) ?? []}
          style={(props.style as "pill" | "underline" | "boxed" | "karaoke") ?? "pill"}
          fontSize={props.fontSize as number | undefined}
          fontColor={props.fontColor as string | undefined}
          backgroundColor={props.backgroundColor as string | undefined}
          position={(props.position as "bottom" | "center" | "top") ?? "bottom"}
          fontFamily={branding.fontFamily}
        />
      );
    case "LowerThird":
      return (
        <LowerThird
          name={(props.name as string) ?? ""}
          title={(props.title as string) ?? ""}
          accentColor={branding.accentColor}
          fontFamily={branding.fontFamily}
        />
      );
    case "LogoWatermark":
      return (
        <LogoWatermark
          logoUrl={(props.logoUrl as string) ?? branding.logoUrl ?? ""}
          opacity={branding.watermarkOpacity}
          position={branding.watermarkPosition}
        />
      );
    case "ProgressBar":
      return (
        <ProgressBar
          color={branding.accentColor}
          height={props.height as number | undefined}
          position={(props.position as "top" | "bottom") ?? "bottom"}
        />
      );
    case "ImageOverlay":
      return (
        <ImageOverlay
          src={props.src as string}
          position={props.position as import("../components/image-overlay").OverlayPosition | undefined}
          scale={props.scale as number | undefined}
          isVideo={props.isVideo as boolean | undefined}
          fadeFrames={props.fadeFrames as number | undefined}
          durationInFrames={item.durationInFrames}
        />
      );
    default:
      return null;
  }
}

/**
 * Audio layer — renders background music and voiceover tracks.
 * Supports ducking: when enabled and voiceover is present, music volume
 * is reduced to 20% of its configured level after the voiceover starts.
 */
const AudioLayer: React.FC<{ audio: CompositionInputProps["audio"]; timeline: CompositionInputProps["timeline"] }> = ({ audio, timeline }) => {
  const { durationInFrames } = useVideoConfig();
  const frame = useCurrentFrame();

  const isNarrationActiveAtFrame = () => {
    return timeline.some((item) => (
      item.type === "image_scene"
      && Boolean(item.voiceover)
      && frame >= item.startAtFrame
      && frame < item.startAtFrame + item.durationInFrames
    ));
  };

  // Calculate effective music volume with ducking and fade support
  const getMusicVolume = () => {
    if (!audio.music) return 0;

    let vol = audio.music.volume;

    // Ducking: reduce volume when narration is playing.
    // Supports both global voiceover track and per-scene image narration.
    if (audio.music.ducking) {
      const narrationActive = (audio.voiceover && frame >= audio.voiceover.startAtFrame) || isNarrationActiveAtFrame();
      if (narrationActive) {
        const DUCK_FACTOR = 0.12;
        vol *= DUCK_FACTOR;
      }
    }

    // Fade in
    const fadeIn = audio.music.fadeInFrames;
    if (fadeIn > 0) {
      vol *= interpolate(frame, [0, fadeIn], [0, 1], { extrapolateRight: "clamp" });
    }

    // Fade out
    const fadeOut = audio.music.fadeOutFrames;
    if (fadeOut > 0) {
      vol *= interpolate(
        frame,
        [durationInFrames - fadeOut, durationInFrames],
        [1, 0],
        { extrapolateLeft: "clamp", extrapolateRight: "clamp" },
      );
    }

    return vol;
  };

  return (
    <>
      {audio.music && (
        audio.music.loop ? (
          <Loop durationInFrames={durationInFrames}>
            <Audio
              src={audio.music.src}
              volume={getMusicVolume}
            />
          </Loop>
        ) : (
          <Audio
            src={audio.music.src}
            volume={getMusicVolume}
          />
        )
      )}
      {audio.voiceover && (
        <Sequence from={audio.voiceover.startAtFrame}>
          <Audio
            src={audio.voiceover.src}
            volume={audio.voiceover.volume}
          />
        </Sequence>
      )}
    </>
  );
};

/**
 * Load Google Fonts used by captions and overlays so SSR renders text properly.
 */
const FontLoader: React.FC<{ children: React.ReactNode }> = ({ children }) => {
  const [handle] = useState(() => delayRender("Loading fonts"));

  useEffect(() => {
    const link = document.createElement("link");
    link.href = "https://fonts.googleapis.com/css2?family=Inter:wght@300;400;600;700;800&display=swap";
    link.rel = "stylesheet";
    link.onload = () => continueRender(handle);
    link.onerror = () => continueRender(handle);
    document.head.appendChild(link);
    return () => {
      document.head.removeChild(link);
    };
  }, [handle]);

  return <>{children}</>;
};

/**
 * The main template composition component.
 * Renders the complete timeline with TransitionSeries for smooth transitions.
 */
export const TemplateComposition: React.FC<CompositionInputProps> = (props) => {
  const { timeline, audio, branding } = props;
  const { segments, overlays, transitions } = partitionTimeline(timeline);

  return (
    <FontLoader>
    <AbsoluteFill style={{ backgroundColor: "#000000" }}>
      {/* Visual timeline with transitions */}
      {segments.length > 0 && (
        <TransitionSeries>
          {segments.map((segment, i) => {
            const elements: React.ReactElement[] = [];

            // Render the segment
            const durationInFrames = "durationInFrames" in segment
              ? segment.durationInFrames
              : 90; // fallback

            elements.push(
              <TransitionSeries.Sequence
                key={`seg-${i}`}
                durationInFrames={durationInFrames}
              >
                {renderSegment(segment, branding)}
              </TransitionSeries.Sequence>,
            );

            // Check if there's a transition to the next segment
            if (i < segments.length - 1) {
              const nextSegment = segments[i + 1];
              const nextDuration = "durationInFrames" in nextSegment
                ? (nextSegment.durationInFrames ?? 90)
                : 90;
              const transitionItem = findTransitionBetween(transitions, segment, nextSegment);

              // Determine the desired transition duration
              let transFrames: number;
              let transStyle: string;
              if (transitionItem && transitionItem.type === "transition") {
                transFrames = transitionItem.durationInFrames ?? 15;
                transStyle = transitionItem.style ?? "crossfade";
              } else {
                // No explicit transition — hard cut (no default crossfade).
                // Shorts manifests and other auto-generated pipelines rely on
                // precise clip timing without invisible overlap.
                transFrames = 0;
                transStyle = "cut";
              }

              // Remotion requires: sequence duration >= transition duration.
              // Clamp the transition to the smaller of the two adjacent segments
              // so the render never crashes.
              const effectiveTransDuration = Math.min(
                transFrames,
                durationInFrames,
                nextDuration,
              );

              if (effectiveTransDuration > 0) {
                const mapped = mapTransition(transStyle, effectiveTransDuration);
                if (mapped) {
                  elements.push(
                    <TransitionSeries.Transition
                      key={`trans-${i}`}
                      presentation={mapped.presentation}
                      timing={mapped.timing}
                    />,
                  );
                }
              }
            }

            return elements;
          })}
        </TransitionSeries>
      )}

      {/* Overlays — positioned absolutely on top of the timeline */}
      <AbsoluteFill style={{ zIndex: 10 }}>
        {overlays.map((overlay, i) => {
          // SmartCaptions word timings use absolute composition frame numbers,
          // so always render from frame 0 to avoid offset mismatches.
          const isSmartCaptions = overlay.type === "overlay" && overlay.component === "SmartCaptions";
          return (
            <Sequence
              key={`overlay-${i}`}
              from={isSmartCaptions ? 0 : overlay.startAtFrame}
              durationInFrames={
                "durationInFrames" in overlay ? overlay.durationInFrames : undefined
              }
            >
              {renderOverlay(overlay, branding)}
            </Sequence>
          );
        })}
      </AbsoluteFill>

      {/* Persistent branding watermark */}
      {branding.logoUrl && (
        <LogoWatermark
          logoUrl={branding.logoUrl}
          opacity={branding.watermarkOpacity}
          position={branding.watermarkPosition}
        />
      )}

      {/* Audio layer */}
      <AudioLayer audio={audio} timeline={timeline} />
    </AbsoluteFill>
    </FontLoader>
  );
};
