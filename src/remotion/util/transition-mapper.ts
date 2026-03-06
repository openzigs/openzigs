/**
 * Director Mode — Transition Mapper
 * Issue #248: Maps manifest transition styles to @remotion/transitions presentations.
 *
 * Converts the manifest's transition vocabulary (crossfade, wipe-left, wipe-right,
 * dissolve, cut) to Remotion's TransitionSeries presentations.
 */

import { linearTiming, type TransitionPresentation } from "@remotion/transitions";
import { fade } from "@remotion/transitions/fade";
import { wipe } from "@remotion/transitions/wipe";
import { slide } from "@remotion/transitions/slide";
import { flip } from "@remotion/transitions/flip";
import { clockWipe } from "@remotion/transitions/clock-wipe";

export type ManifestTransitionStyle =
  | "crossfade" | "wipe-left" | "wipe-right" | "dissolve" | "cut"
  | "slide" | "flip" | "clock-wipe";

export interface MappedTransition {
  presentation: TransitionPresentation<Record<string, unknown>>;
  timing: ReturnType<typeof linearTiming>;
  durationInFrames: number;
}

/**
 * Map a manifest transition style to a Remotion transition presentation + timing.
 *
 * @param style - The manifest transition style
 * @param durationInFrames - Duration of the transition in frames
 * @param dimensions - Width/height needed for clockWipe
 * @returns MappedTransition with presentation, timing, and duration — or null for "cut"
 */
export function mapTransition(
  style: ManifestTransitionStyle,
  durationInFrames: number,
  dimensions?: { width: number; height: number },
): MappedTransition | null {
  // "cut" = no transition, just a hard cut
  if (style === "cut" || durationInFrames <= 0) {
    return null;
  }

  const timing = linearTiming({ durationInFrames });

  switch (style) {
    case "crossfade":
      return {
        presentation: fade() as TransitionPresentation<Record<string, unknown>>,
        timing,
        durationInFrames,
      };

    case "dissolve":
      return {
        presentation: fade() as TransitionPresentation<Record<string, unknown>>,
        timing,
        durationInFrames,
      };

    case "wipe-left":
      return {
        presentation: wipe({ direction: "from-left" }) as TransitionPresentation<Record<string, unknown>>,
        timing,
        durationInFrames,
      };

    case "wipe-right":
      return {
        presentation: wipe({ direction: "from-right" }) as TransitionPresentation<Record<string, unknown>>,
        timing,
        durationInFrames,
      };

    case "slide":
      return {
        presentation: slide({ direction: "from-right" }) as TransitionPresentation<Record<string, unknown>>,
        timing,
        durationInFrames,
      };

    case "flip":
      return {
        presentation: flip() as TransitionPresentation<Record<string, unknown>>,
        timing,
        durationInFrames,
      };

    case "clock-wipe":
      return {
        // clockWipe returns TransitionPresentation<ClockWipeProps>; widen via unknown
        presentation: clockWipe({
          width: dimensions?.width ?? 1920,
          height: dimensions?.height ?? 1080,
        }) as unknown as TransitionPresentation<Record<string, unknown>>,
        timing,
        durationInFrames,
      };

    default:
      return {
        presentation: fade() as TransitionPresentation<Record<string, unknown>>,
        timing,
        durationInFrames,
      };
  }
}

/**
 * Get the default transition for a template.
 */
export function getDefaultTransition(
  templateTransition: string,
  durationInFrames: number,
): MappedTransition | null {
  return mapTransition(templateTransition as ManifestTransitionStyle, durationInFrames);
}
