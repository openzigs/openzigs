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
  /** Horizontal crop offset for 9:16 framing (0–100, default 50 = center) */
  horizontalCropOffset?: number;
  /** Fit mode: "cover" crops to fill, "contain" shows full frame with blurred background */
  fitMode?: "cover" | "contain";
}

export const VideoClipSegment: React.FC<VideoClipSegmentProps> = ({
  src,
  trimStartFrame,
  durationInFrames,
  volume,
  effects,
  horizontalCropOffset = 50,
  fitMode = "cover",
}) => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();

  // Build transform/filter values from effects
  let scale = 1;
  let opacity = 1;
  let blur = 0;
  let grayscale = 0;
  let playbackRate = 1;

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
        const factor = (effect.params?.factor as number) ?? 1;
        // Clamp to Remotion's supported range (0.0625 to 16)
        playbackRate = Math.max(0.0625, Math.min(16, factor));
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
        {fitMode === "contain" ? (
          <>
            {/* Blurred, scaled-up background fill */}
            <OffthreadVideo
              src={src}
              trimBefore={trimStartFrame}
              volume={0}
              playbackRate={playbackRate}
              style={{
                position: "absolute",
                width: "100%",
                height: "100%",
                objectFit: "cover",
                objectPosition: `${horizontalCropOffset}% center`,
                filter: "blur(30px) brightness(0.4)",
                transform: "scale(1.2)",
              }}
            />
            {/* Contained foreground showing full frame */}
            <OffthreadVideo
              src={src}
              trimBefore={trimStartFrame}
              volume={volume}
              playbackRate={playbackRate}
              style={{
                position: "absolute",
                width: "100%",
                height: "100%",
                objectFit: "contain",
              }}
            />
          </>
        ) : (
          <OffthreadVideo
            src={src}
            trimBefore={trimStartFrame}
            volume={volume}
            playbackRate={playbackRate}
            style={{
              width: "100%",
              height: "100%",
              objectFit: "cover",
              objectPosition: `${horizontalCropOffset}% center`,
            }}
          />
        )}
      </AbsoluteFill>
    </AbsoluteFill>
  );
};
