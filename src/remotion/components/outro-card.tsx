/**
 * Director Mode — Outro Card Component
 * Issue #316: Animated outro card with exit animations, CTA text, and branding.
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
import type { OutroCardProps } from "../input-props";

export const OutroCard: React.FC<
  Omit<OutroCardProps, "startAtFrame"> & { durationInFrames: number }
> = ({
  title,
  subtitle,
  backgroundSrc,
  logoSrc,
  ctaText,
  durationInFrames,
  animation = "fade-out",
}) => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();

  // Entrance: fade in at start
  const entranceSpring = spring({ frame, fps, config: { damping: 18, stiffness: 80 } });

  // Exit animation starts in the last ~30 frames
  const exitStart = Math.max(0, durationInFrames - 30);
  const exitProgress = frame >= exitStart
    ? interpolate(frame, [exitStart, durationInFrames], [0, 1], { extrapolateRight: "clamp" })
    : 0;

  let exitOpacity = 1;
  let exitTranslateY = 0;
  let exitScale = 1;

  switch (animation) {
    case "fade-out":
      exitOpacity = 1 - exitProgress;
      break;
    case "slide-down":
      exitOpacity = 1 - exitProgress;
      exitTranslateY = interpolate(exitProgress, [0, 1], [0, 60]);
      break;
    case "scale-out":
      exitOpacity = 1 - exitProgress;
      exitScale = interpolate(exitProgress, [0, 1], [1, 0.5]);
      break;
  }

  const combinedOpacity = entranceSpring * exitOpacity;

  // Stagger for subtitle and CTA
  const subtitleSpring = spring({ frame: Math.max(0, frame - 10), fps, config: { damping: 20, stiffness: 60 } });
  const ctaSpring = spring({ frame: Math.max(0, frame - 20), fps, config: { damping: 15, stiffness: 50 } });

  const logoOpacity = spring({ frame: Math.max(0, frame - 5), fps, config: { damping: 25, stiffness: 100 } });

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
          background: "linear-gradient(135deg, #0f3460 0%, #16213e 50%, #1a1a2e 100%)",
        }} />
      )}

      {/* Dark overlay */}
      <AbsoluteFill style={{ backgroundColor: "rgba(0,0,0,0.4)" }} />

      {/* Content */}
      <div
        style={{
          position: "absolute",
          top: "50%",
          left: "50%",
          transform: `translate(-50%, -50%) translateY(${exitTranslateY}px) scale(${exitScale})`,
          opacity: combinedOpacity,
          textAlign: "center",
          width: "80%",
        }}
      >
        <div
          style={{
            fontSize: 64,
            fontWeight: "bold",
            color: "#ffffff",
            fontFamily: "Inter, system-ui, sans-serif",
            textShadow: "0 4px 20px rgba(0,0,0,0.5)",
            lineHeight: 1.2,
          }}
        >
          {title}
        </div>

        {subtitle && (
          <div
            style={{
              fontSize: 28,
              fontWeight: 300,
              color: "rgba(255,255,255,0.85)",
              fontFamily: "Inter, system-ui, sans-serif",
              marginTop: 12,
              opacity: subtitleSpring * exitOpacity,
            }}
          >
            {subtitle}
          </div>
        )}

        {ctaText && (
          <div
            style={{
              marginTop: 32,
              opacity: ctaSpring * exitOpacity,
            }}
          >
            <div
              style={{
                display: "inline-block",
                padding: "14px 36px",
                borderRadius: 8,
                background: "linear-gradient(90deg, #e94560, #c23660)",
                color: "#ffffff",
                fontSize: 24,
                fontWeight: 600,
                fontFamily: "Inter, system-ui, sans-serif",
                letterSpacing: 1,
              }}
            >
              {ctaText}
            </div>
          </div>
        )}
      </div>

      {/* Logo overlay */}
      {logoSrc && (
        <div
          style={{
            position: "absolute",
            bottom: 40,
            left: "50%",
            transform: "translateX(-50%)",
            opacity: logoOpacity * exitOpacity,
          }}
        >
          <Img
            src={logoSrc}
            style={{ height: 50, objectFit: "contain" }}
          />
        </div>
      )}
    </AbsoluteFill>
  );
};
