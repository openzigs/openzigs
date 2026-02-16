/**
 * Director Mode — Video Clip Segment Component
 * Issue #247: Renders a single video clip with effects (Ken Burns, fade, etc.)
 */

import React from "react";
import {
  AbsoluteFill,
  OffthreadVideo,
  useCurrentFrame,
  useVideoConfig,
  interpolate,
} from "remotion";

interface VideoEffect {
  type: "slowZoom" | "fadeIn" | "fadeOut" | "blur" | "grayscale" | "speedRamp";
  params?: Record<string, unknown>;
}

interface VideoClipSegmentProps {
  src: string;
  trimStartFrame: number;
  durationInFrames: number;
  volume: number;
  effects: VideoEffect[];
}

export const VideoClipSegment: React.FC<VideoClipSegmentProps> = ({
  src,
  trimStartFrame,
  durationInFrames,
  volume,
  effects,
}) => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();

  // Compute the start time in seconds for the source video
  const startFrom = Math.round(trimStartFrame / fps * fps);

  // Build transform/filter values from effects
  let scale = 1;
  let opacity = 1;
  let blur = 0;
  let grayscale = 0;

  for (const effect of effects) {
    switch (effect.type) {
      case "slowZoom": {
        const from = (effect.params?.from as number) ?? 1;
        const to = (effect.params?.to as number) ?? 1.15;
        scale *= interpolate(frame, [0, durationInFrames], [from, to], {
          extrapolateRight: "clamp",
        });
        break;
      }
      case "fadeIn": {
        const dur = (effect.params?.durationFrames as number) ?? 15;
        opacity *= interpolate(frame, [0, dur], [0, 1], {
          extrapolateRight: "clamp",
        });
        break;
      }
      case "fadeOut": {
        const dur = (effect.params?.durationFrames as number) ?? 15;
        opacity *= interpolate(
          frame,
          [durationInFrames - dur, durationInFrames],
          [1, 0],
          { extrapolateLeft: "clamp", extrapolateRight: "clamp" },
        );
        break;
      }
      case "blur": {
        const amount = (effect.params?.amount as number) ?? 5;
        const startFrame = (effect.params?.startFrame as number) ?? 0;
        const endFrame = (effect.params?.endFrame as number) ?? durationInFrames;
        if (frame >= startFrame && frame <= endFrame) {
          blur = amount;
        }
        break;
      }
      case "grayscale": {
        grayscale = 1;
        break;
      }
      case "speedRamp": {
        // Speed ramp is handled at the playback level, not visual
        break;
      }
    }
  }

  const filterParts: string[] = [];
  if (blur > 0) filterParts.push(`blur(${blur}px)`);
  if (grayscale > 0) filterParts.push(`grayscale(${grayscale})`);

  return (
    <AbsoluteFill style={{ opacity }}>
      <AbsoluteFill
        style={{
          transform: `scale(${scale})`,
          filter: filterParts.length > 0 ? filterParts.join(" ") : undefined,
        }}
      >
        <OffthreadVideo
          src={src}
          startFrom={startFrom}
          volume={volume}
          style={{
            width: "100%",
            height: "100%",
            objectFit: "cover",
          }}
        />
      </AbsoluteFill>
    </AbsoluteFill>
  );
};
