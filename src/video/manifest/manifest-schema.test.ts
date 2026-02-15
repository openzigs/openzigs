/**
 * Director Mode — Manifest Validation Tests
 * Issue #240: Tests for Zod schema + semantic validator
 */

import { describe, it, expect } from "vitest";
import { DirectorManifestSchema } from "./manifest-schema.js";
import { validateManifest } from "./manifest-validator.js";
import type { DirectorManifest } from "./manifest-types.js";

/** Helper: minimal valid manifest for baseline testing. */
function buildValidManifest(overrides: Partial<DirectorManifest> = {}): DirectorManifest {
  return {
    projectTitle: "Test Project",
    templateId: "Minimalist",
    composition: { width: 1920, height: 1080, fps: 30 },
    audioLayer: {
      music: null,
      voiceover: null,
    },
    timeline: [
      {
        type: "video_clip",
        source: "intro.mp4",
        startAtFrame: 0,
        trimStart: 0,
        duration: 150,
        volume: 0.8,
      },
    ],
    ...overrides,
  };
}

describe("DirectorManifestSchema (Zod)", () => {
  it("accepts a valid minimal manifest", () => {
    const manifest = buildValidManifest();
    const result = DirectorManifestSchema.safeParse(manifest);
    expect(result.success).toBe(true);
  });

  it("accepts a full manifest with all fields", () => {
    const manifest = buildValidManifest({
      templateId: "Corporate",
      audioLayer: {
        music: {
          track: "music.mp3",
          volume: 0.15,
          ducking: true,
          fadeInFrames: 30,
          fadeOutFrames: 60,
          loop: true,
        },
        voiceover: {
          source: "voiceover.mp3",
          volume: 1.0,
          startAtFrame: 0,
        },
      },
      timeline: [
        {
          type: "title_card",
          title: "Q3 2026 Update",
          subtitle: "Engineering Team",
          background: "#1a1a2e",
          startAtFrame: 0,
          duration: 90,
          animation: "fade",
        },
        {
          type: "transition",
          style: "dissolve",
          duration: 20,
          startAtFrame: 80,
        },
        {
          type: "video_clip",
          source: "intro.mp4",
          startAtFrame: 90,
          trimStart: 45,
          duration: 180,
          volume: 0.8,
          effects: [{ type: "slowZoom", from: 1.0, to: 1.1 }],
        },
        {
          type: "overlay",
          component: "LowerThird",
          props: { name: "Sarah Chen", title: "VP Engineering", accentColor: "#0066ff" },
          startAtFrame: 120,
          duration: 120,
        },
      ],
      branding: {
        logoUrl: "logo.png",
        accentColor: "#0066ff",
        watermarkOpacity: 0.3,
        watermarkPosition: "top-right",
      },
      metadata: {
        generatedAt: "2026-02-15T10:30:00Z",
        llmModel: "gpt-4o",
        llmTokensUsed: 6842,
        productionMode: "highlight",
        sourceClips: ["intro.mp4", "demo.mp4"],
      },
    });
    const result = DirectorManifestSchema.safeParse(manifest);
    expect(result.success).toBe(true);
  });

  it("rejects manifest with empty projectTitle", () => {
    const manifest = buildValidManifest({ projectTitle: "" });
    const result = DirectorManifestSchema.safeParse(manifest);
    expect(result.success).toBe(false);
  });

  it("rejects manifest with invalid templateId", () => {
    const manifest = buildValidManifest({ templateId: "FunkyMode" as never });
    const result = DirectorManifestSchema.safeParse(manifest);
    expect(result.success).toBe(false);
  });

  it("rejects manifest with empty timeline", () => {
    const manifest = buildValidManifest({ timeline: [] });
    const result = DirectorManifestSchema.safeParse(manifest);
    expect(result.success).toBe(false);
  });

  it("rejects composition with invalid dimensions", () => {
    const manifest = buildValidManifest({
      composition: { width: 100, height: 1080, fps: 30 },
    });
    const result = DirectorManifestSchema.safeParse(manifest);
    expect(result.success).toBe(false);
  });

  it("rejects music volume > 1", () => {
    const manifest = buildValidManifest({
      audioLayer: {
        music: { track: "x.mp3", volume: 1.5, ducking: false },
      },
    });
    const result = DirectorManifestSchema.safeParse(manifest);
    expect(result.success).toBe(false);
  });

  it("rejects invalid accent color format", () => {
    const manifest = buildValidManifest({
      branding: { accentColor: "red" },
    });
    const result = DirectorManifestSchema.safeParse(manifest);
    expect(result.success).toBe(false);
  });

  it("accepts valid hex accent color", () => {
    const manifest = buildValidManifest({
      branding: { accentColor: "#ff00aa" },
    });
    const result = DirectorManifestSchema.safeParse(manifest);
    expect(result.success).toBe(true);
  });

  it("validates all effect types in a clip", () => {
    const manifest = buildValidManifest({
      timeline: [
        {
          type: "video_clip",
          source: "clip.mp4",
          startAtFrame: 0,
          trimStart: 0,
          duration: 300,
          effects: [
            { type: "slowZoom", from: 1.0, to: 1.2 },
            { type: "fadeIn", durationFrames: 15 },
            { type: "fadeOut", durationFrames: 15 },
            { type: "grayscale" },
            { type: "blur", amount: 5, startFrame: 10, endFrame: 20 },
            { type: "speedRamp", factor: 2.0, startFrame: 50, endFrame: 100 },
          ],
        },
      ],
    });
    const result = DirectorManifestSchema.safeParse(manifest);
    expect(result.success).toBe(true);
  });
});

describe("validateManifest (semantic)", () => {
  it("passes for a valid manifest", () => {
    const manifest = buildValidManifest();
    const result = validateManifest(manifest);
    expect(result.valid).toBe(true);
    expect(result.errors).toHaveLength(0);
  });

  it("propagates Zod schema errors", () => {
    const result = validateManifest({ projectTitle: 42 });
    expect(result.valid).toBe(false);
    expect(result.errors.length).toBeGreaterThan(0);
    expect(result.errors[0]).toContain("[schema]");
  });

  it("warns about large timeline gaps (> 30 frames)", () => {
    const manifest = buildValidManifest({
      timeline: [
        { type: "video_clip", source: "a.mp4", startAtFrame: 0, trimStart: 0, duration: 100 },
        { type: "video_clip", source: "b.mp4", startAtFrame: 200, trimStart: 0, duration: 100 },
      ],
    });
    const result = validateManifest(manifest);
    expect(result.valid).toBe(true);
    expect(result.warnings.some((w) => w.includes("gap"))).toBe(true);
  });

  it("warns about ContentCreator with landscape resolution", () => {
    const manifest = buildValidManifest({
      templateId: "ContentCreator",
      composition: { width: 1920, height: 1080, fps: 30 },
    });
    const result = validateManifest(manifest);
    expect(result.warnings.some((w) => w.includes("vertical"))).toBe(true);
  });

  it("errors on slowZoom with from === to", () => {
    const manifest = buildValidManifest({
      timeline: [
        {
          type: "video_clip",
          source: "clip.mp4",
          startAtFrame: 0,
          trimStart: 0,
          duration: 100,
          effects: [{ type: "slowZoom", from: 1.0, to: 1.0 }],
        },
      ],
    });
    const result = validateManifest(manifest);
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.includes("slowZoom"))).toBe(true);
  });

  it("errors on blur with endFrame <= startFrame", () => {
    const manifest = buildValidManifest({
      timeline: [
        {
          type: "video_clip",
          source: "clip.mp4",
          startAtFrame: 0,
          trimStart: 0,
          duration: 100,
          effects: [{ type: "blur", amount: 5, startFrame: 50, endFrame: 20 }],
        },
      ],
    });
    const result = validateManifest(manifest);
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.includes("blur"))).toBe(true);
  });

  it("warns about script mode without voiceover", () => {
    const manifest = buildValidManifest({
      audioLayer: { music: null, voiceover: null },
      metadata: {
        generatedAt: "2026-02-15T10:00:00Z",
        llmModel: "gpt-4o",
        llmTokensUsed: 5000,
        productionMode: "script",
        sourceClips: ["a.mp4"],
      },
    });
    const result = validateManifest(manifest);
    expect(result.warnings.some((w) => w.includes("voiceover"))).toBe(true);
  });

  it("warns about high music volume without ducking", () => {
    const manifest = buildValidManifest({
      audioLayer: {
        music: { track: "music.mp3", volume: 0.6, ducking: false },
        voiceover: { source: "vo.mp3" },
      },
    });
    const result = validateManifest(manifest);
    expect(result.warnings.some((w) => w.includes("ducking"))).toBe(true);
  });

  it("warns about non-standard fps", () => {
    const manifest = buildValidManifest({
      composition: { width: 1920, height: 1080, fps: 23 },
    });
    const result = validateManifest(manifest);
    expect(result.warnings.some((w) => w.includes("Non-standard fps"))).toBe(true);
  });
});
