/**
 * Tests for `image-style-prompts.ts` (sub-issue #998).
 *
 * Covers:
 *   - Enum is exhaustive against the IMAGE_STYLE_PROMPTS map keys
 *   - Each preset prefix is non-empty and ends with ", "
 *   - `applyStylePreset` no-ops when style is undefined
 *   - `applyStylePreset` prepends the matching prefix
 *   - `applyStylePreset` trims leading whitespace on the user prompt
 *   - `resolveImageStyle` per-slide overrides deck-level
 *   - `resolveImageStyle` falls back to deck-level when per-slide is undefined
 */
import { describe, it, expect } from "vitest";
import {
  IMAGE_STYLE_PROMPTS,
  ImageStyleEnum,
  applyStylePreset,
  resolveImageStyle,
  type ImageStyle,
} from "./image-style-prompts.js";

describe("ImageStyleEnum + IMAGE_STYLE_PROMPTS", () => {
  it("exposes the same set of keys in the enum and the map", () => {
    const enumKeys = Object.values(ImageStyleEnum.enum).sort();
    const mapKeys = Object.keys(IMAGE_STYLE_PROMPTS).sort();
    expect(enumKeys).toEqual(mapKeys);
  });

  it("every prefix is non-empty and ends with a comma+space separator", () => {
    for (const [style, prefix] of Object.entries(IMAGE_STYLE_PROMPTS)) {
      expect(prefix.length).toBeGreaterThan(0);
      expect(prefix.endsWith(", ")).toBe(true);
      // Prefixes are short enough not to dominate downstream model context.
      expect(prefix.length).toBeLessThan(120);
      // Sanity: prefix references the style label or its theme; we just
      // assert it isn't the literal style identifier (those are snake_case).
      expect(prefix).not.toBe(style);
    }
  });
});

describe("applyStylePreset", () => {
  it("returns the prompt unchanged when style is undefined", () => {
    expect(applyStylePreset("a serene mountain", undefined)).toBe(
      "a serene mountain",
    );
  });

  it.each(Object.keys(IMAGE_STYLE_PROMPTS) as ImageStyle[])(
    "prepends the %s preset prefix",
    (style) => {
      const out = applyStylePreset("a hero shot", style);
      expect(out.startsWith(IMAGE_STYLE_PROMPTS[style])).toBe(true);
      expect(out.endsWith("a hero shot")).toBe(true);
    },
  );

  it("trims leading whitespace on the user prompt before joining", () => {
    const out = applyStylePreset("   widget closeup", "cinematic");
    expect(out).toBe(`${IMAGE_STYLE_PROMPTS.cinematic}widget closeup`);
  });

  it("preserves trailing whitespace and inner punctuation", () => {
    const out = applyStylePreset("alpha, beta — gamma. ", "illustration");
    expect(out).toBe(
      `${IMAGE_STYLE_PROMPTS.illustration}alpha, beta — gamma. `,
    );
  });
});

describe("resolveImageStyle", () => {
  it("returns the per-slide override when set", () => {
    expect(resolveImageStyle("cinematic", "illustration")).toBe("cinematic");
  });

  it("falls back to deck-level when per-slide is undefined", () => {
    expect(resolveImageStyle(undefined, "3d_render")).toBe("3d_render");
  });

  it("returns undefined when both are undefined", () => {
    expect(resolveImageStyle(undefined, undefined)).toBeUndefined();
  });

  it("returns undefined when per-slide is set to undefined explicitly", () => {
    expect(resolveImageStyle(undefined, undefined)).toBeUndefined();
  });
});
