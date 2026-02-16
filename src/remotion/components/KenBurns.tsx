/**
 * Director Mode — Ken Burns Effect Component
 * Issue #258: Reusable Remotion component that applies slow zoom + pan
 * to static images, creating cinematic movement from still frames.
 *
 * Used in Mode C (Generative Presentation) to animate AI-generated images.
 */

import React from "react";
import {
  AbsoluteFill,
  Img,
  useCurrentFrame,
  interpolate,
} from "remotion";

export interface KenBurnsProps {
  /** Image source URL or local path */
  src: string;
  /** Total duration of the animation in frames */
  durationInFrames: number;
  /** Starting scale factor (default: 1.0) */
  scaleFrom?: number;
  /** Ending scale factor (default: 1.15) */
  scaleTo?: number;
  /** Starting X translation in pixels (default: 0) */
  translateXFrom?: number;
  /** Ending X translation in pixels (default: -10) */
  translateXTo?: number;
  /** Starting Y translation in pixels (default: 0) */
  translateYFrom?: number;
  /** Ending Y translation in pixels (default: -5) */
  translateYTo?: number;
  /** Opacity fade-in duration in frames (default: 15) */
  fadeInFrames?: number;
  /** Opacity fade-out duration in frames (default: 15) */
  fadeOutFrames?: number;
  /** CSS object-fit for the image (default: "cover") */
  objectFit?: React.CSSProperties["objectFit"];
}

/**
 * KenBurns — Applies a cinematic slow zoom and pan to a static image.
 *
 * Creates the iconic "Ken Burns effect" used in documentaries:
 * a gentle zoom-in with subtle horizontal/vertical drift that brings
 * life to still photographs and generated imagery.
 *
 * @example
 * ```tsx
 * <KenBurns
 *   src="/path/to/scene-image.png"
 *   durationInFrames={450}  // 15 seconds at 30fps
 *   scaleFrom={1.0}
 *   scaleTo={1.2}
 *   translateXFrom={0}
 *   translateXTo={-15}
 * />
 * ```
 */
export const KenBurns: React.FC<KenBurnsProps> = ({
  src,
  durationInFrames,
  scaleFrom = 1.0,
  scaleTo = 1.15,
  translateXFrom = 0,
  translateXTo = -10,
  translateYFrom = 0,
  translateYTo = -5,
  fadeInFrames = 15,
  fadeOutFrames = 15,
  objectFit = "cover",
}) => {
  const frame = useCurrentFrame();

  // Smooth zoom interpolation across the full duration
  const scale = interpolate(frame, [0, durationInFrames], [scaleFrom, scaleTo], {
    extrapolateLeft: "clamp",
    extrapolateRight: "clamp",
  });

  // Smooth pan interpolation
  const translateX = interpolate(frame, [0, durationInFrames], [translateXFrom, translateXTo], {
    extrapolateLeft: "clamp",
    extrapolateRight: "clamp",
  });

  const translateY = interpolate(frame, [0, durationInFrames], [translateYFrom, translateYTo], {
    extrapolateLeft: "clamp",
    extrapolateRight: "clamp",
  });

  // Fade in at the start
  const fadeIn = interpolate(frame, [0, fadeInFrames], [0, 1], {
    extrapolateLeft: "clamp",
    extrapolateRight: "clamp",
  });

  // Fade out at the end
  const fadeOut = interpolate(
    frame,
    [durationInFrames - fadeOutFrames, durationInFrames],
    [1, 0],
    {
      extrapolateLeft: "clamp",
      extrapolateRight: "clamp",
    },
  );

  const opacity = fadeIn * fadeOut;

  return (
    <AbsoluteFill
      style={{
        opacity,
        overflow: "hidden",
      }}
    >
      <Img
        src={src}
        style={{
          width: "100%",
          height: "100%",
          objectFit,
          transform: `scale(${scale}) translate(${translateX}px, ${translateY}px)`,
          transformOrigin: "center center",
        }}
      />
    </AbsoluteFill>
  );
};
