/**
 * Director Mode — Text Overlay Layer
 * Issue #317: PowerPoint-style text overlays rendered as React components
 * within Remotion compositions. Supports positioned text with animations.
 */

import React from "react";
import { useCurrentFrame, useVideoConfig, spring, interpolate } from "remotion";
import type { TextOverlayProps } from "../input-props";

/** Map named positions to CSS styles. */
function getPositionStyle(
  position: TextOverlayProps["position"],
  customPosition?: { x: number; y: number },
): React.CSSProperties {
  switch (position) {
    case "center":
      return {
        top: "50%",
        left: "50%",
        transform: "translate(-50%, -50%)",
      };
    case "bottom-third":
      return {
        bottom: "10%",
        left: "50%",
        transform: "translateX(-50%)",
      };
    case "top-third":
      return {
        top: "10%",
        left: "50%",
        transform: "translateX(-50%)",
      };
    case "custom":
      return {
        top: `${customPosition?.y ?? 50}%`,
        left: `${customPosition?.x ?? 50}%`,
        transform: "translate(-50%, -50%)",
      };
    default:
      return {
        top: "50%",
        left: "50%",
        transform: "translate(-50%, -50%)",
      };
  }
}

/** Single text overlay with animation. */
const TextOverlayItem: React.FC<TextOverlayProps> = ({
  text,
  position,
  customPosition,
  fontSize = 48,
  fontWeight = "bold",
  color = "#ffffff",
  backgroundColor = "rgba(0,0,0,0.6)",
  borderRadius = 8,
  padding = 16,
  animation = "fade-in",
  startFrame,
  durationFrames,
}) => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();

  // Only render within the overlay's active range
  const localFrame = frame - startFrame;
  if (localFrame < 0 || localFrame >= durationFrames) return null;

  const posStyle = getPositionStyle(position, customPosition);

  // Calculate animation values
  let opacity = 1;
  let translateY = 0;
  let visibleChars = text.length;

  const FADE_FRAMES = Math.min(15, Math.floor(durationFrames / 4));

  switch (animation) {
    case "fade-in": {
      const fadeInProgress = spring({
        frame: localFrame,
        fps,
        config: { damping: 20, stiffness: 100 },
      });
      opacity = fadeInProgress;
      // Fade out near end
      if (localFrame > durationFrames - FADE_FRAMES) {
        opacity *= interpolate(
          localFrame,
          [durationFrames - FADE_FRAMES, durationFrames],
          [1, 0],
          { extrapolateLeft: "clamp", extrapolateRight: "clamp" },
        );
      }
      break;
    }
    case "slide-up": {
      const slideProgress = spring({
        frame: localFrame,
        fps,
        config: { damping: 15, stiffness: 80 },
      });
      translateY = interpolate(slideProgress, [0, 1], [40, 0]);
      opacity = slideProgress;
      if (localFrame > durationFrames - FADE_FRAMES) {
        opacity *= interpolate(
          localFrame,
          [durationFrames - FADE_FRAMES, durationFrames],
          [1, 0],
          { extrapolateLeft: "clamp", extrapolateRight: "clamp" },
        );
      }
      break;
    }
    case "typewriter": {
      const charsPerFrame = text.length / Math.min(durationFrames * 0.6, 30);
      visibleChars = Math.min(text.length, Math.floor(localFrame * charsPerFrame));
      if (localFrame > durationFrames - FADE_FRAMES) {
        opacity = interpolate(
          localFrame,
          [durationFrames - FADE_FRAMES, durationFrames],
          [1, 0],
          { extrapolateLeft: "clamp", extrapolateRight: "clamp" },
        );
      }
      break;
    }
    case "none":
    default:
      break;
  }

  const displayText = animation === "typewriter" ? text.slice(0, visibleChars) : text;

  // Build transform — merge position transform with animation offsets
  const baseTransform = posStyle.transform ?? "";
  const animTransform = translateY !== 0 ? ` translateY(${translateY}px)` : "";

  return (
    <div
      style={{
        position: "absolute",
        ...posStyle,
        transform: `${baseTransform}${animTransform}`,
        opacity,
        fontSize,
        fontWeight,
        color,
        backgroundColor,
        borderRadius,
        padding,
        maxWidth: "80%",
        textAlign: "center",
        lineHeight: 1.3,
        whiteSpace: "pre-wrap",
        fontFamily: "Inter, system-ui, sans-serif",
        zIndex: 10,
        pointerEvents: "none",
      }}
    >
      {displayText}
    </div>
  );
};

/** Renders all text overlays for a segment. */
export const TextOverlayLayer: React.FC<{
  overlays: TextOverlayProps[];
}> = ({ overlays }) => {
  if (!overlays || overlays.length === 0) return null;

  return (
    <>
      {overlays.map((overlay) => (
        <TextOverlayItem key={overlay.id} {...overlay} />
      ))}
    </>
  );
};
