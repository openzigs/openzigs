/**
 * Director Mode — Title Card Component
 * Issue #247: Animated title card with fade/slide/typewriter animations.
 */

import React from "react";
import {
  AbsoluteFill,
  interpolate,
  useCurrentFrame,
  useVideoConfig,
  spring,
} from "remotion";

interface TitleCardComponentProps {
  title: string;
  subtitle?: string;
  background: string;
  animation: "fade" | "slide-up" | "typewriter";
  fontFamily?: string;
  accentColor?: string;
}

export const TitleCard: React.FC<TitleCardComponentProps> = ({
  title,
  subtitle,
  background,
  animation,
  fontFamily = "Inter, system-ui, sans-serif",
  accentColor = "#3b82f6",
}) => {
  const frame = useCurrentFrame();
  const { fps, width, durationInFrames } = useVideoConfig();

  // Fade out at the end
  const fadeOut = interpolate(
    frame,
    [durationInFrames - Math.min(15, durationInFrames), durationInFrames],
    [1, 0],
    { extrapolateLeft: "clamp", extrapolateRight: "clamp" },
  );

  let titleOpacity = 1;
  let titleTranslateY = 0;
  let displayTitle = title;
  let subtitleOpacity = 1;

  switch (animation) {
    case "fade": {
      titleOpacity = interpolate(frame, [0, 20], [0, 1], {
        extrapolateRight: "clamp",
      });
      subtitleOpacity = interpolate(frame, [10, 30], [0, 1], {
        extrapolateRight: "clamp",
      });
      break;
    }
    case "slide-up": {
      const slideProgress = spring({ frame, fps, config: { damping: 200, stiffness: 100 } });
      titleTranslateY = interpolate(slideProgress, [0, 1], [80, 0]);
      titleOpacity = slideProgress;
      subtitleOpacity = interpolate(frame, [15, 35], [0, 1], {
        extrapolateRight: "clamp",
      });
      break;
    }
    case "typewriter": {
      const charsToShow = Math.floor(interpolate(frame, [0, Math.min(title.length * 2, 60)], [0, title.length], {
        extrapolateRight: "clamp",
      }));
      displayTitle = title.slice(0, charsToShow);
      subtitleOpacity = interpolate(frame, [title.length * 2, title.length * 2 + 20], [0, 1], {
        extrapolateRight: "clamp",
      });
      break;
    }
  }

  const titleFontSize = Math.round(width / 18);
  const subtitleFontSize = Math.round(width / 28);

  return (
    <AbsoluteFill
      style={{
        opacity: fadeOut,
        backgroundColor: background.startsWith("#") ? background : undefined,
        backgroundImage: background.startsWith("#") ? undefined : `url(${background})`,
        backgroundSize: "cover",
        backgroundPosition: "center",
        display: "flex",
        flexDirection: "column",
        justifyContent: "center",
        alignItems: "center",
        fontFamily,
      }}
    >
      <div
        style={{
          opacity: titleOpacity,
          transform: `translateY(${titleTranslateY}px)`,
          color: "#ffffff",
          fontSize: titleFontSize,
          fontWeight: 700,
          textAlign: "center",
          padding: "0 10%",
          lineHeight: 1.2,
        }}
      >
        {displayTitle}
        {animation === "typewriter" && (
          <span
            style={{
              opacity: frame % 20 < 10 ? 1 : 0,
              color: accentColor,
            }}
          >
            |
          </span>
        )}
      </div>
      {subtitle && (
        <div
          style={{
            opacity: subtitleOpacity,
            color: "#bbbbbb",
            fontSize: subtitleFontSize,
            textAlign: "center",
            marginTop: 20,
            padding: "0 15%",
          }}
        >
          {subtitle}
        </div>
      )}
    </AbsoluteFill>
  );
};
