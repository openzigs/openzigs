/**
 * Director Mode — Smart Captions Component
 * Issue #247: Word-by-word captions with pill, underline, boxed, and karaoke styles.
 */

import React from "react";
import { AbsoluteFill, useCurrentFrame, useVideoConfig, interpolate } from "remotion";

interface CaptionWord {
  word: string;
  start: number; // frame
  end: number;   // frame
}

interface SmartCaptionsComponentProps {
  words: CaptionWord[];
  style: "pill" | "underline" | "boxed" | "karaoke";
  fontSize?: number;
  fontColor?: string;
  backgroundColor?: string;
  position?: "bottom" | "center" | "top";
  fontFamily?: string;
}

export const SmartCaptions: React.FC<SmartCaptionsComponentProps> = ({
  words,
  style,
  fontSize = 48,
  fontColor = "#ffffff",
  backgroundColor = "rgba(0, 0, 0, 0.75)",
  position = "bottom",
  fontFamily = "Inter, system-ui, sans-serif",
}) => {
  const frame = useCurrentFrame();
  const { width } = useVideoConfig();

  // Find the currently visible words (show groups of words that overlap in time)
  const activeWords = words.filter((w) => w.start <= frame && w.end >= frame);
  if (activeWords.length === 0) return null;

  // Build a window of context around active words
  const firstActiveIdx = words.indexOf(activeWords[0]);
  const windowStart = Math.max(0, firstActiveIdx - 1);
  const windowEnd = Math.min(words.length, firstActiveIdx + 6);
  const windowWords = words.slice(windowStart, windowEnd).filter(
    (w) => w.start <= frame + 30, // show upcoming words dimly
  );

  const positionStyle: React.CSSProperties = {
    bottom: position === "bottom" ? "8%" : undefined,
    top: position === "top" ? "8%" : position === "center" ? "45%" : undefined,
  };

  const containerPadding = Math.round(width * 0.04);

  return (
    <AbsoluteFill
      style={{
        justifyContent: position === "center" ? "center" : undefined,
        alignItems: "center",
        ...positionStyle,
        position: "absolute",
        pointerEvents: "none",
      }}
    >
      <div
        style={{
          display: "flex",
          flexWrap: "wrap",
          justifyContent: "center",
          gap: style === "pill" ? 8 : 6,
          maxWidth: `${width * 0.85}px`,
          padding: `${containerPadding * 0.3}px ${containerPadding}px`,
          background: style === "boxed" ? backgroundColor : "transparent",
          borderRadius: style === "boxed" ? 12 : 0,
          fontFamily,
        }}
      >
        {windowWords.map((word, i) => {
          const isActive = word.start <= frame && word.end >= frame;
          const isFuture = word.start > frame;
          const wordOpacity = isFuture
            ? interpolate(frame, [word.start - 15, word.start], [0.3, 1], { extrapolateLeft: "clamp", extrapolateRight: "clamp" })
            : isActive ? 1 : 0.5;

          return (
            <span
              key={`${word.word}-${word.start}-${i}`}
              style={getWordStyle(style, isActive, fontSize, fontColor, backgroundColor, wordOpacity)}
            >
              {word.word}
            </span>
          );
        })}
      </div>
    </AbsoluteFill>
  );
};

function getWordStyle(
  captionStyle: SmartCaptionsComponentProps["style"],
  isActive: boolean,
  fontSize: number,
  fontColor: string,
  backgroundColor: string,
  opacity: number,
): React.CSSProperties {
  const base: React.CSSProperties = {
    fontSize,
    fontWeight: isActive ? 800 : 600,
    color: fontColor,
    opacity,
    transition: "all 0.1s ease",
  };

  switch (captionStyle) {
    case "pill":
      return {
        ...base,
        backgroundColor: isActive ? backgroundColor : "transparent",
        borderRadius: 20,
        padding: "4px 16px",
      };
    case "underline":
      return {
        ...base,
        borderBottom: isActive ? `4px solid ${fontColor}` : "4px solid transparent",
        paddingBottom: 4,
      };
    case "boxed":
      return {
        ...base,
        transform: isActive ? "scale(1.1)" : "scale(1)",
      };
    case "karaoke":
      return {
        ...base,
        color: isActive ? "#facc15" : fontColor,
        transform: isActive ? "scale(1.15)" : "scale(1)",
        textShadow: isActive ? "0 0 20px rgba(250, 204, 21, 0.5)" : "none",
      };
  }
}
