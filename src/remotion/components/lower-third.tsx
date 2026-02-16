/**
 * Director Mode — Lower Third Component
 * Issue #247: Animated lower third overlay with name and title.
 */

import React from "react";
import { AbsoluteFill, useCurrentFrame, spring, useVideoConfig, interpolate } from "remotion";

interface LowerThirdComponentProps {
  name: string;
  title: string;
  accentColor?: string;
  animationDuration?: number;
  fontFamily?: string;
}

export const LowerThird: React.FC<LowerThirdComponentProps> = ({
  name,
  title,
  accentColor = "#3b82f6",
  animationDuration = 15,
  fontFamily = "Inter, system-ui, sans-serif",
}) => {
  const frame = useCurrentFrame();
  const { fps, durationInFrames, width } = useVideoConfig();

  // Slide in from left
  const slideIn = spring({
    frame,
    fps,
    config: { damping: 200, stiffness: 80 },
    durationInFrames: animationDuration,
  });

  // Slide out before end
  const slideOut = interpolate(
    frame,
    [durationInFrames - animationDuration, durationInFrames],
    [0, -1],
    { extrapolateLeft: "clamp", extrapolateRight: "clamp" },
  );

  const translateX = interpolate(slideIn, [0, 1], [-400, 0]) + slideOut * 400;
  const opacity = slideIn * (1 + slideOut);

  const barWidth = Math.min(400, width * 0.25);

  return (
    <AbsoluteFill>
      <div
        style={{
          position: "absolute",
          bottom: "12%",
          left: "5%",
          display: "flex",
          flexDirection: "column",
          transform: `translateX(${translateX}px)`,
          opacity: Math.max(0, opacity),
          fontFamily,
        }}
      >
        {/* Accent bar */}
        <div
          style={{
            width: barWidth,
            height: 4,
            backgroundColor: accentColor,
            marginBottom: 8,
          }}
        />
        {/* Name */}
        <div
          style={{
            color: "#ffffff",
            fontSize: 32,
            fontWeight: 700,
            textShadow: "0 2px 8px rgba(0,0,0,0.6)",
            marginBottom: 4,
          }}
        >
          {name}
        </div>
        {/* Title */}
        <div
          style={{
            color: "#cccccc",
            fontSize: 20,
            fontWeight: 400,
            textShadow: "0 2px 8px rgba(0,0,0,0.6)",
          }}
        >
          {title}
        </div>
      </div>
    </AbsoluteFill>
  );
};
