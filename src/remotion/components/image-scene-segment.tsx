/**
 * Director Mode — Image Scene Segment Component
 * Issue #258: Renders a single AI-generated image with Ken Burns effect
 * and optional per-scene voiceover. Used in Mode C (Generative Presentation).
 *
 * Wraps the KenBurns component with an Audio track so each scene gets
 * its own narration timed to the image animation.
 */

import React from "react";
import { AbsoluteFill, Audio, Sequence } from "remotion";
import { KenBurns } from "./KenBurns";

export interface ImageSceneSegmentProps {
  /** Path to the generated image */
  src: string;
  /** Total duration of this scene in frames */
  durationInFrames: number;
  /** Per-scene voiceover audio path (optional) */
  voiceover?: string;
  /** Volume for the per-scene voiceover (default: 1.0) */
  voiceoverVolume?: number;
  /** Ken Burns animation parameters */
  kenBurns?: {
    scaleFrom?: number;
    scaleTo?: number;
    translateXFrom?: number;
    translateXTo?: number;
    translateYFrom?: number;
    translateYTo?: number;
  };
}

/**
 * ImageSceneSegment — renders a single scene in a Mode C presentation.
 *
 * Each scene consists of:
 * 1. A static image animated with the Ken Burns effect (zoom + pan)
 * 2. An optional voiceover audio track synced to the scene
 *
 * The Ken Burns defaults produce a gentle zoom-in with subtle drift,
 * suitable for documentary-style presentations.
 */
export const ImageSceneSegment: React.FC<ImageSceneSegmentProps> = ({
  src,
  durationInFrames,
  voiceover,
  voiceoverVolume = 1,
  kenBurns = {},
}) => {
  return (
    <AbsoluteFill>
      <KenBurns
        src={src}
        durationInFrames={durationInFrames}
        scaleFrom={kenBurns.scaleFrom ?? 1.0}
        scaleTo={kenBurns.scaleTo ?? 1.15}
        translateXFrom={kenBurns.translateXFrom ?? 0}
        translateXTo={kenBurns.translateXTo ?? -10}
        translateYFrom={kenBurns.translateYFrom ?? 0}
        translateYTo={kenBurns.translateYTo ?? -5}
      />
      {voiceover && (
        <Sequence from={0}>
          <Audio src={voiceover} volume={voiceoverVolume} />
        </Sequence>
      )}
    </AbsoluteFill>
  );
};
