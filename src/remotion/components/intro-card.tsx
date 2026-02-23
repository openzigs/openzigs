/**
 * Director Mode — Intro Card Component
 * Issue #316: Animated intro card with full-bleed background, title entrance,
 * staggered subtitle, and optional logo overlay.
 */

import React from "react";
import {
  AbsoluteFill,
  Img,
  useCurrentFrame,
  useVideoConfig,
  spring,
  interpolate,
} from "remotion";
import type { IntroCardProps } from "../input-props";

export const IntroCard: React.FC<Omit<IntroCardProps, "startAtFrame" | "durationInFrames">> = ({
  title,
  subtitle,
  backgroundSrc,
  logoSrc,
  animation = "fade-in",
}) => {
  const frame = useCurrentFrame();
  const { fps, width, height } = useVideoConfig();

  // Scale font sizes for portrait (9:16) compositions
  const isPortrait = height > width;
  const titleFontSize = isPortrait ? 52 : 72;
  const subtitleFontSize = isPortrait ? 24 : 32;
  const containerWidth = isPortrait ? "90%" : "80%";
  const logoHeight = isPortrait ? 48 : 60;

  // Title animation
  const titleSpring = spring({ frame, fps, config: { damping: 18, stiffness: 80 } });

  let titleOpacity = 1;
  let titleTranslateY = 0;
  let titleScale = 1;

  switch (animation) {
    case "fade-in":
      titleOpacity = titleSpring;
      break;
    case "slide-up":
      titleOpacity = titleSpring;
      titleTranslateY = interpolate(titleSpring, [0, 1], [60, 0]);
      break;
    case "scale-in":
      titleOpacity = titleSpring;
      titleScale = interpolate(titleSpring, [0, 1], [0.5, 1]);
      break;
    case "typewriter":
      titleOpacity = 1;
      break;
  }

  // Subtitle appears with a stagger
  const subtitleSpring = spring({ frame: Math.max(0, frame - 12), fps, config: { damping: 20, stiffness: 60 } });
  const subtitleOpacity = subtitleSpring;
  const subtitleTranslateY = interpolate(subtitleSpring, [0, 1], [30, 0]);

  // Logo fades in early
  const logoOpacity = spring({ frame: Math.max(0, frame - 5), fps, config: { damping: 25, stiffness: 100 } });

  // Typewriter: reveal characters over time
  const displayTitle = animation === "typewriter"
    ? title.slice(0, Math.floor(interpolate(frame, [0, Math.min(title.length * 2, 60)], [0, title.length], { extrapolateRight: "clamp" })))
    : title;

  return (
    <AbsoluteFill>
      {/* Background */}
      {backgroundSrc ? (
        <Img
          src={backgroundSrc}
          style={{
            width: "100%",
            height: "100%",
            objectFit: "cover",
          }}
        />
      ) : (
        <div style={{
          width: "100%",
          height: "100%",
          background: "linear-gradient(135deg, #1a1a2e 0%, #16213e 50%, #0f3460 100%)",
        }} />
      )}

      {/* Dark overlay for text readability */}
      <AbsoluteFill style={{ backgroundColor: "rgba(0,0,0,0.4)" }} />

      {/* Title */}
      <div
        style={{
          position: "absolute",
          top: "50%",
          left: "50%",
          transform: `translate(-50%, -50%) translateY(${titleTranslateY}px) scale(${titleScale})`,
          opacity: titleOpacity,
          textAlign: "center",
          width: containerWidth,
        }}
      >
        <div
          style={{
            fontSize: titleFontSize,
            fontWeight: "bold",
            color: "#ffffff",
            fontFamily: "Inter, system-ui, sans-serif",
            textShadow: "0 4px 20px rgba(0,0,0,0.5)",
            lineHeight: 1.2,
          }}
        >
          {displayTitle}
        </div>

        {subtitle && (
          <div
            style={{
              fontSize: subtitleFontSize,
              fontWeight: 300,
              color: "rgba(255,255,255,0.85)",
              fontFamily: "Inter, system-ui, sans-serif",
              marginTop: 16,
              opacity: subtitleOpacity,
              transform: `translateY(${subtitleTranslateY}px)`,
            }}
          >
            {subtitle}
          </div>
        )}
      </div>

      {/* Logo overlay */}
      {logoSrc && (
        <div
          style={{
            position: "absolute",
            bottom: 40,
            right: 40,
            opacity: logoOpacity,
          }}
        >
          <Img
            src={logoSrc}
            style={{ height: logoHeight, objectFit: "contain" }}
          />
        </div>
      )}
    </AbsoluteFill>
  );
};
