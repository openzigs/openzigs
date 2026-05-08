"use client";

/**
 * Image quality (FluxQ model) picker — toolbar dropdown that mirrors
 * the wizard's "Image quality" selector so users can switch the
 * deck-level `metadata.image_model` after the deck has already been
 * created (PR #1044 walkthrough Bug #1). Native <select> for the same
 * jsdom-friendly reasons documented on `BrandKitPicker`.
 *
 * The PATCH is the caller's responsibility — this component is purely
 * presentational so the page-level mutation can drive cache
 * invalidation alongside the existing deck-update mutations.
 */

export type PitchImageModel = "flux-schnell" | "flux-dev";

export interface ImageModelPickerProps {
  /** Current deck-level image model. `null`/`undefined` => "flux-schnell". */
  value: PitchImageModel | null | undefined;
  onChange: (model: PitchImageModel) => void;
  disabled?: boolean;
}

export const ImageModelPicker = ({
  value,
  onChange,
  disabled,
}: ImageModelPickerProps) => {
  const effective: PitchImageModel = value ?? "flux-schnell";
  return (
    <label
      data-testid="pitch-image-model-picker"
      className="flex items-center gap-1 text-xs"
    >
      <span className="sr-only">Image quality</span>
      <select
        data-testid="pitch-image-model-select"
        aria-label="Image quality"
        value={effective}
        disabled={disabled}
        onChange={(e) => onChange(e.target.value as PitchImageModel)}
        className="rounded border border-border bg-background px-2 py-1 text-xs"
      >
        <option value="flux-schnell">Fast (flux-schnell)</option>
        <option value="flux-dev">High quality (flux-dev)</option>
      </select>
    </label>
  );
};
