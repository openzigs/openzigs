/**
 * Director Mode — Progress Bar Component
 * Issue #247: Video progress indicator overlay.
 */

import React from "react";
import { AbsoluteFill, useCurrentFrame, useVideoConfig } from "remotion";

interface ProgressBarComponentProps {
  color?: string;
  height?: number;
  position?: "top" | "bottom";
}

export const ProgressBar: React.FC<ProgressBarComponentProps> = ({
  color = "#3b82f6",
  height = 4,
  position = "bottom",
}) => {
  const frame = useCurrentFrame();
  const { durationInFrames } = useVideoConfig();

  const progress = frame / durationInFrames;

  return (
    <AbsoluteFill style={{ pointerEvents: "none" }}>
      <div
        style={{
          position: "absolute",
          [position]: 0,
          left: 0,
          width: "100%",
          height,
          backgroundColor: "rgba(255, 255, 255, 0.15)",
        }}
      >
        <div
          style={{
            height: "100%",
            width: `${progress * 100}%`,
            backgroundColor: color,
            transition: "width 0.05s linear",
          }}
        />
      </div>
    </AbsoluteFill>
  );
};
