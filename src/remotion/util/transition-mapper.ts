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

export type ManifestTransitionStyle = "crossfade" | "wipe-left" | "wipe-right" | "dissolve" | "cut";

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
 * @returns MappedTransition with presentation, timing, and duration — or null for "cut"
 */
export function mapTransition(
  style: ManifestTransitionStyle,
  durationInFrames: number,
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
      // Dissolve is effectively a fade in video editing
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
