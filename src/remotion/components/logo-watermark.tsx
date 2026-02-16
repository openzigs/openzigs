/**
 * Director Mode — Logo Watermark Component
 * Issue #247: Persistent logo watermark with configurable position and opacity.
 *
 * Uses delayRender/continueRender to preload the image and gracefully
 * skip rendering if the logo URL is unreachable (LLM-generated manifests
 * may reference fabricated URLs).
 */

import React, { useEffect, useState } from "react";
import { AbsoluteFill, continueRender, delayRender } from "remotion";

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
  const [handle] = useState(() => delayRender("Loading logo watermark"));
  const [loaded, setLoaded] = useState(false);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    if (!logoUrl) {
      setFailed(true);
      continueRender(handle);
      return;
    }

    const img = new Image();
    img.onload = () => {
      setLoaded(true);
      continueRender(handle);
    };
    img.onerror = () => {
      // Logo not reachable — skip silently rather than crashing the render
      setFailed(true);
      continueRender(handle);
    };
    img.src = logoUrl;
  }, [logoUrl, handle]);

  // If the image failed to load or hasn't loaded yet, render nothing
  if (failed || !loaded) return null;

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
        <img
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
