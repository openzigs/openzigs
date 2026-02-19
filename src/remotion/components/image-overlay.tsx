/**
 * Director Mode — Image Overlay Component
 * Renders a user-uploaded image or video as a full-screen visual.
 * Used for visual assets that users add in the Director wizard Step 5.
 */

import React from "react";
import { AbsoluteFill, Img, OffthreadVideo, interpolate, useCurrentFrame } from "remotion";

export type OverlayPosition =
  | "top-left"
  | "top-center"
  | "top-right"
  | "center"
  | "bottom-left"
  | "bottom-center"
  | "bottom-right";

export interface ImageOverlayProps {
  /** Path to the image or video file */
  src: string;
  /** Position preset */
  position?: OverlayPosition;
  /** Scale multiplied against a base size (default 1.0 → 30% of frame width) */
  scale?: number;
  /** Whether the asset is a video clip */
  isVideo?: boolean;
  /** Fade-in/out duration in frames (default 10) */
  fadeFrames?: number;
  /** Total duration of this overlay in frames (needed for fade-out) */
  durationInFrames?: number;
}

export const ImageOverlay: React.FC<ImageOverlayProps> = ({
  src,
  position: _position = "bottom-right",
  scale: _scale = 1.0,
  isVideo = false,
  fadeFrames = 10,
  durationInFrames = 90,
}) => {
  const frame = useCurrentFrame();

  // Fade in at start, fade out at end
  const opacity = interpolate(
    frame,
    [0, fadeFrames, durationInFrames - fadeFrames, durationInFrames],
    [0, 1, 1, 0],
    { extrapolateLeft: "clamp", extrapolateRight: "clamp" },
  );

  return (
    <AbsoluteFill style={{ pointerEvents: "none" }}>
      <div style={{ position: "absolute", inset: 0, opacity, overflow: "hidden" }}>
        {isVideo ? (
          <OffthreadVideo
            src={src}
            style={{ width: "100%", height: "100%", objectFit: "fill", display: "block" }}
          />
        ) : (
          <Img
            src={src}
            style={{ width: "100%", height: "100%", objectFit: "fill", display: "block" }}
          />
        )}
      </div>
    </AbsoluteFill>
  );
};
