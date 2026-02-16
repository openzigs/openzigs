/**
 * Director Mode — Logo Watermark Component
 * Issue #247: Persistent logo watermark with configurable position and opacity.
 */

import React from "react";
import { AbsoluteFill, Img } from "remotion";

interface LogoWatermarkComponentProps {
  logoUrl: string;
  opacity?: number;
  position?: "top-left" | "top-right" | "bottom-left" | "bottom-right";
  scale?: number;
}

export const LogoWatermark: React.FC<LogoWatermarkComponentProps> = ({
  logoUrl,
  opacity = 0.3,
  position = "bottom-right",
  scale = 1,
}) => {
  const positionStyle: React.CSSProperties = {};
  const margin = 24;

  switch (position) {
    case "top-left":
      positionStyle.top = margin;
      positionStyle.left = margin;
      break;
    case "top-right":
      positionStyle.top = margin;
      positionStyle.right = margin;
      break;
    case "bottom-left":
      positionStyle.bottom = margin;
      positionStyle.left = margin;
      break;
    case "bottom-right":
      positionStyle.bottom = margin;
      positionStyle.right = margin;
      break;
  }

  return (
    <AbsoluteFill style={{ pointerEvents: "none" }}>
      <div
        style={{
          position: "absolute",
          ...positionStyle,
          opacity,
          transform: `scale(${scale})`,
          transformOrigin: position.replace("-", " "),
        }}
      >
        <Img
          src={logoUrl}
          style={{
            maxWidth: 120,
            maxHeight: 60,
            objectFit: "contain",
          }}
        />
      </div>
    </AbsoluteFill>
  );
};
