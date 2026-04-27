/**
 * Pitch — image style presets (sub-issue #998).
 *
 * Maps each {@link ImageStyle} preset to a short prompt prefix that is
 * prepended to the user/LLM prompt before the FluxQ job is enqueued so
 * every generated image carries a consistent visual treatment across the
 * deck. Used by:
 *   - {@link enqueueSlideImage} (single-image POST)
 *   - {@link fanOutImageGeneration} (auto-fan-out + bulk generate-all)
 *
 * Style precedence (highest wins):
 *   1. per-slide override on `slide.image_style`
 *   2. deck-level `metadata.image_style` (chosen in the wizard Options
 *      step or via the per-deck control)
 *   3. no preset — prompt sent verbatim
 */
import { z } from "zod";

/** All supported image-style presets. Sorted alphabetically inside the enum
 *  values so generated docs/UI lists are stable. */
export const ImageStyleEnum = z.enum([
  "cinematic",
  "illustration",
  "3d_render",
  "corporate_photo",
  "minimal_vector",
]);
export type ImageStyle = z.infer<typeof ImageStyleEnum>;

/**
 * Prompt prefixes — each ends in `", "` so the user prompt reads as a
 * comma-separated continuation. Kept short (< 80 chars) so the prefix
 * never crowds out the actual subject in models with tight token budgets.
 */
export const IMAGE_STYLE_PROMPTS: Record<ImageStyle, string> = {
  cinematic:
    "cinematic photography, dramatic lighting, shallow depth of field, ",
  illustration: "flat vector illustration, clean lines, modern design, ",
  "3d_render": "3D render, octane, high detail, soft lighting, ",
  corporate_photo: "professional corporate photography, neutral palette, ",
  minimal_vector: "minimal vector graphic, monochromatic, geometric, ",
};

/**
 * Resolve the effective image style for a slide. Per-slide override beats
 * the deck-level default; both may be undefined.
 */
export function resolveImageStyle(
  perSlide: ImageStyle | undefined,
  deckLevel: ImageStyle | undefined,
): ImageStyle | undefined {
  return perSlide ?? deckLevel;
}

/**
 * Pure: prepend the matching prefix when a style is supplied. Idempotent
 * — calling twice with the same style does NOT double-prefix because the
 * caller is expected to apply this exactly once per prompt at the
 * outermost call site (the queue enqueue).
 *
 * Trims the user prompt first so a leading whitespace doesn't push the
 * prefix off into the body of the prompt.
 */
export function applyStylePreset(
  prompt: string,
  style: ImageStyle | undefined,
): string {
  if (!style) return prompt;
  const prefix = IMAGE_STYLE_PROMPTS[style];
  return `${prefix}${prompt.trimStart()}`;
}
