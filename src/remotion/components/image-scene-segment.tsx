/**
 * Director Mode — Image Scene Segment Component
 * Issue #258: Renders a single AI-generated image with Ken Burns effect
 * and optional per-scene voiceover. Used in Mode C (Generative Presentation).
 *
 * Wraps the KenBurns component with an Audio track so each scene gets
 * its own narration timed to the image animation.
 */

import React from "react";
import { AbsoluteFill, Audio, Sequence, useCurrentFrame, interpolate } from "remotion";
import { KenBurns } from "./KenBurns";

interface EffectDef {
  type: string;
  params?: Record<string, unknown>;
}

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
  /** Visual effects applied to this scene */
  effects?: EffectDef[];
}

export const ImageSceneSegment: React.FC<ImageSceneSegmentProps> = ({
  src,
  durationInFrames,
  voiceover,
  voiceoverVolume = 1,
  kenBurns = {},
  effects = [],
}) => {
  const frame = useCurrentFrame();

  // Process effects into CSS filter/opacity values
  let opacity = 1;
  const filterParts: string[] = [];

  for (const effect of effects) {
    switch (effect.type) {
      case "fadeIn": {
        const dur = (effect.params?.durationFrames as number) ?? 15;
        opacity *= interpolate(frame, [0, dur], [0, 1], { extrapolateRight: "clamp" });
        break;
      }
      case "fadeOut": {
        const dur = (effect.params?.durationFrames as number) ?? 15;
        opacity *= interpolate(frame, [durationInFrames - dur, durationInFrames], [1, 0], {
          extrapolateLeft: "clamp",
          extrapolateRight: "clamp",
        });
        break;
      }
      case "blur": {
        const amount = (effect.params?.amount as number) ?? 5;
        filterParts.push(`blur(${amount}px)`);
        break;
      }
      case "grayscale":
        filterParts.push("grayscale(1)");
        break;
      case "brightness": {
        const val = (effect.params?.value as number) ?? 1;
        filterParts.push(`brightness(${val})`);
        break;
      }
      case "contrast": {
        const val = (effect.params?.value as number) ?? 1;
        filterParts.push(`contrast(${val})`);
        break;
      }
      case "saturate": {
        const val = (effect.params?.value as number) ?? 1;
        filterParts.push(`saturate(${val})`);
        break;
      }
      case "sepia": {
        const val = (effect.params?.value as number) ?? 0;
        filterParts.push(`sepia(${val})`);
        break;
      }
      case "hueRotate": {
        const deg = (effect.params?.degrees as number) ?? 0;
        filterParts.push(`hue-rotate(${deg}deg)`);
        break;
      }
    }
  }

  return (
    <AbsoluteFill
      style={{
        opacity,
        filter: filterParts.length > 0 ? filterParts.join(" ") : undefined,
      }}
    >
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
