/**
 * Director Mode — Template Composition
 * Issue #246: The main Remotion composition component that renders
 * an entire timeline with transitions, overlays, and audio.
 *
 * This single composition handles all four templates — the templateId
 * controls styling defaults (font, colors, etc.) while the timeline
 * drives the actual content.
 */

import React from "react";
import {
  AbsoluteFill,
  Sequence,
  Audio,
  useVideoConfig,
  Loop,
  interpolate,
  useCurrentFrame,
} from "remotion";
import { TransitionSeries } from "@remotion/transitions";
import type { CompositionInputProps, TimelineItem } from "../input-props";
import { TitleCard } from "../components/title-card";
import { SmartCaptions } from "../components/smart-captions";
import { LowerThird } from "../components/lower-third";
import { LogoWatermark } from "../components/logo-watermark";
import { ProgressBar } from "../components/progress-bar";
import { VideoClipSegment } from "../components/video-clip-segment";
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
 * Find the transition that occurs between two segments (based on frame overlap).
 */
function findTransitionBetween(
  transitions: TimelineItem[],
  _segA: TimelineItem,
  segB: TimelineItem,
): TimelineItem | undefined {
  return transitions.find(
    (t) => t.type === "transition" && Math.abs(t.startAtFrame - segB.startAtFrame) < 5,
  );
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
        <VideoClipSegment
          src={item.src}
          trimStartFrame={item.trimStartFrame}
          durationInFrames={item.durationInFrames}
          volume={item.volume}
          effects={item.effects}
        />
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
    default:
      return null;
  }
}

/**
 * Audio layer — renders background music and voiceover tracks.
 * Supports ducking: when enabled and voiceover is present, music volume
 * is reduced to 20% of its configured level after the voiceover starts.
 */
const AudioLayer: React.FC<{ audio: CompositionInputProps["audio"] }> = ({ audio }) => {
  const { durationInFrames } = useVideoConfig();
  const frame = useCurrentFrame();

  // Calculate effective music volume with ducking and fade support
  const getMusicVolume = () => {
    if (!audio.music) return 0;

    let vol = audio.music.volume;

    // Ducking: reduce volume when voiceover is playing
    if (audio.music.ducking && audio.voiceover) {
      const voiceoverStart = audio.voiceover.startAtFrame;
      const duckRampFrames = 10; // 10-frame ramp for smooth ducking
      if (frame >= voiceoverStart) {
        const duckFactor = interpolate(
          frame,
          [voiceoverStart, voiceoverStart + duckRampFrames],
          [1, 0.2],
          { extrapolateLeft: "clamp", extrapolateRight: "clamp" },
        );
        vol *= duckFactor;
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
 * The main template composition component.
 * Renders the complete timeline with TransitionSeries for smooth transitions.
 */
export const TemplateComposition: React.FC<CompositionInputProps> = (props) => {
  const { timeline, audio, branding } = props;
  const { segments, overlays, transitions } = partitionTimeline(timeline);

  return (
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
              const transitionItem = findTransitionBetween(transitions, segment, nextSegment);

              if (transitionItem && transitionItem.type === "transition") {
                const mapped = mapTransition(
                  transitionItem.style,
                  transitionItem.durationInFrames,
                );

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
      {overlays.map((overlay, i) => (
        <Sequence
          key={`overlay-${i}`}
          from={overlay.startAtFrame}
          durationInFrames={
            "durationInFrames" in overlay ? overlay.durationInFrames : undefined
          }
        >
          {renderOverlay(overlay, branding)}
        </Sequence>
      ))}

      {/* Persistent branding watermark */}
      {branding.logoUrl && (
        <LogoWatermark
          logoUrl={branding.logoUrl}
          opacity={branding.watermarkOpacity}
          position={branding.watermarkPosition}
        />
      )}

      {/* Audio layer */}
      <AudioLayer audio={audio} />
    </AbsoluteFill>
  );
};
