import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("node:fs", () => ({
  default: {
    existsSync: vi.fn().mockReturnValue(true),
  },
}));

vi.mock("./manifest-schema.js", () => ({
  DirectorManifestSchema: {
    safeParse: vi.fn(),
  },
}));

import { validateManifest } from "./manifest-validator.js";
import { DirectorManifestSchema } from "./manifest-schema.js";
import fs from "node:fs";
import type { DirectorManifest } from "./manifest-types.js";

const mockedSafeParse = vi.mocked(DirectorManifestSchema.safeParse);
const mockedExistsSync = vi.mocked(fs.existsSync);

function makeValidManifest(overrides: Partial<DirectorManifest> = {}): DirectorManifest {
  return {
    projectTitle: "Test",
    templateId: "Minimalist",
    composition: { width: 1920, height: 1080, fps: 30 },
    audioLayer: {},
    timeline: [
      {
        type: "video_clip",
        source: "/clips/a.mp4",
        startAtFrame: 0,
        trimStart: 0,
        duration: 150,
        volume: 0.8,
      },
    ],
    ...overrides,
  } as DirectorManifest;
}

describe("validateManifest", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockedExistsSync.mockReturnValue(true);
  });

  it("returns errors when Zod schema validation fails", () => {
    mockedSafeParse.mockReturnValue({
      success: false,
      error: {
        issues: [
          { path: ["composition", "fps"], message: "Required" },
          { path: ["templateId"], message: "Invalid enum value" },
        ],
      },
    } as unknown as ReturnType<typeof DirectorManifestSchema.safeParse>);

    const result = validateManifest({});

    expect(result.valid).toBe(false);
    expect(result.errors).toHaveLength(2);
    expect(result.errors[0]).toContain("composition.fps");
    expect(result.errors[1]).toContain("templateId");
  });

  it("returns valid for a well-formed manifest", () => {
    const manifest = makeValidManifest();
    mockedSafeParse.mockReturnValue({ success: true, data: manifest } as unknown as ReturnType<typeof DirectorManifestSchema.safeParse>);

    const result = validateManifest(manifest);

    expect(result.valid).toBe(true);
    expect(result.errors).toHaveLength(0);
  });

  it("warns about empty timeline", () => {
    const manifest = makeValidManifest({ timeline: [] });
    mockedSafeParse.mockReturnValue({ success: true, data: manifest } as unknown as ReturnType<typeof DirectorManifestSchema.safeParse>);

    const result = validateManifest(manifest);

    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.includes("at least one entry"))).toBe(true);
  });

  it("warns about out-of-order timeline entries", () => {
    const manifest = makeValidManifest({
      timeline: [
        { type: "video_clip", source: "/a.mp4", startAtFrame: 100, trimStart: 0, duration: 50 },
        { type: "video_clip", source: "/b.mp4", startAtFrame: 50, trimStart: 0, duration: 50 },
      ],
    });
    mockedSafeParse.mockReturnValue({ success: true, data: manifest } as unknown as ReturnType<typeof DirectorManifestSchema.safeParse>);

    const result = validateManifest(manifest);

    expect(result.warnings.some((w) => w.includes("before previous"))).toBe(true);
  });

  it("warns about large gaps between timeline entries", () => {
    const manifest = makeValidManifest({
      timeline: [
        { type: "video_clip", source: "/a.mp4", startAtFrame: 0, trimStart: 0, duration: 50 },
        { type: "video_clip", source: "/b.mp4", startAtFrame: 200, trimStart: 0, duration: 50 },
      ],
    });
    mockedSafeParse.mockReturnValue({ success: true, data: manifest } as unknown as ReturnType<typeof DirectorManifestSchema.safeParse>);

    const result = validateManifest(manifest);

    expect(result.warnings.some((w) => w.includes("gap"))).toBe(true);
  });

  it("warns about excessively long videos (>1 hour)", () => {
    const manifest = makeValidManifest({
      composition: { width: 1920, height: 1080, fps: 30 },
      timeline: [
        { type: "video_clip", source: "/a.mp4", startAtFrame: 0, trimStart: 0, duration: 30 * 3601 },
      ],
    });
    mockedSafeParse.mockReturnValue({ success: true, data: manifest } as unknown as ReturnType<typeof DirectorManifestSchema.safeParse>);

    const result = validateManifest(manifest);

    expect(result.warnings.some((w) => w.includes("1 hour"))).toBe(true);
  });

  it("reports missing source files when checkFiles is true", () => {
    const manifest = makeValidManifest({
      timeline: [
        { type: "video_clip", source: "/missing.mp4", startAtFrame: 0, trimStart: 0, duration: 150 },
      ],
    });
    mockedSafeParse.mockReturnValue({ success: true, data: manifest } as unknown as ReturnType<typeof DirectorManifestSchema.safeParse>);
    mockedExistsSync.mockReturnValue(false);

    const result = validateManifest(manifest, { checkFiles: true });

    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.includes("not found"))).toBe(true);
  });

  it("does not check files when checkFiles is false", () => {
    const manifest = makeValidManifest();
    mockedSafeParse.mockReturnValue({ success: true, data: manifest } as unknown as ReturnType<typeof DirectorManifestSchema.safeParse>);

    validateManifest(manifest, { checkFiles: false });

    expect(mockedExistsSync).not.toHaveBeenCalled();
  });

  it("reports missing music track when checkFiles is true", () => {
    const manifest = makeValidManifest({
      audioLayer: { music: { track: "/missing-music.mp3", volume: 0.5, ducking: false } },
    });
    mockedSafeParse.mockReturnValue({ success: true, data: manifest } as unknown as ReturnType<typeof DirectorManifestSchema.safeParse>);
    mockedExistsSync.mockReturnValue(false);

    const result = validateManifest(manifest, { checkFiles: true });

    expect(result.errors.some((e) => e.includes("Music track not found"))).toBe(true);
  });

  it("reports missing voiceover source when checkFiles is true", () => {
    const manifest = makeValidManifest({
      audioLayer: { voiceover: { source: "/missing-vo.wav" } },
    });
    mockedSafeParse.mockReturnValue({ success: true, data: manifest } as unknown as ReturnType<typeof DirectorManifestSchema.safeParse>);
    mockedExistsSync.mockReturnValue(false);

    const result = validateManifest(manifest, { checkFiles: true });

    expect(result.errors.some((e) => e.includes("Voiceover source not found"))).toBe(true);
  });

  it("warns about script mode without voiceover", () => {
    const manifest = makeValidManifest({
      audioLayer: {},
      metadata: { sourceClips: [], productionMode: "script" as const },
    });
    mockedSafeParse.mockReturnValue({ success: true, data: manifest } as unknown as ReturnType<typeof DirectorManifestSchema.safeParse>);

    const result = validateManifest(manifest);

    expect(result.warnings.some((w) => w.includes("Script-driven mode without voiceover"))).toBe(true);
  });

  it("warns about high music volume without ducking", () => {
    const manifest = makeValidManifest({
      audioLayer: {
        music: { track: "/m.mp3", volume: 0.6, ducking: false },
        voiceover: { source: "/vo.wav" },
      },
    });
    mockedSafeParse.mockReturnValue({ success: true, data: manifest } as unknown as ReturnType<typeof DirectorManifestSchema.safeParse>);

    const result = validateManifest(manifest);

    expect(result.warnings.some((w) => w.includes("Music volume > 0.4 without ducking"))).toBe(true);
  });

  it("warns about ContentCreator template with landscape aspect ratio", () => {
    const manifest = makeValidManifest({
      templateId: "ContentCreator" as DirectorManifest["templateId"],
      composition: { width: 1920, height: 1080, fps: 30 },
    });
    mockedSafeParse.mockReturnValue({ success: true, data: manifest } as unknown as ReturnType<typeof DirectorManifestSchema.safeParse>);

    const result = validateManifest(manifest);

    expect(result.warnings.some((w) => w.includes("vertical"))).toBe(true);
  });

  it("warns about non-standard fps", () => {
    const manifest = makeValidManifest({
      composition: { width: 1920, height: 1080, fps: 29 },
    });
    mockedSafeParse.mockReturnValue({ success: true, data: manifest } as unknown as ReturnType<typeof DirectorManifestSchema.safeParse>);

    const result = validateManifest(manifest);

    expect(result.warnings.some((w) => w.includes("Non-standard fps"))).toBe(true);
  });

  it("reports slowZoom with from === to as error", () => {
    const manifest = makeValidManifest({
      timeline: [
        {
          type: "video_clip",
          source: "/a.mp4",
          startAtFrame: 0,
          trimStart: 0,
          duration: 150,
          effects: [{ type: "slowZoom", from: 1.0, to: 1.0 }],
        },
      ],
    });
    mockedSafeParse.mockReturnValue({ success: true, data: manifest } as unknown as ReturnType<typeof DirectorManifestSchema.safeParse>);

    const result = validateManifest(manifest);

    expect(result.errors.some((e) => e.includes("slowZoom from === to"))).toBe(true);
  });

  it("reports blur with endFrame <= startFrame as error", () => {
    const manifest = makeValidManifest({
      timeline: [
        {
          type: "video_clip",
          source: "/a.mp4",
          startAtFrame: 0,
          trimStart: 0,
          duration: 150,
          effects: [{ type: "blur", amount: 5, startFrame: 50, endFrame: 30 }],
        },
      ],
    });
    mockedSafeParse.mockReturnValue({ success: true, data: manifest } as unknown as ReturnType<typeof DirectorManifestSchema.safeParse>);

    const result = validateManifest(manifest);

    expect(result.errors.some((e) => e.includes("blur endFrame"))).toBe(true);
  });

  it("reports speedRamp with endFrame <= startFrame as error", () => {
    const manifest = makeValidManifest({
      timeline: [
        {
          type: "video_clip",
          source: "/a.mp4",
          startAtFrame: 0,
          trimStart: 0,
          duration: 150,
          effects: [{ type: "speedRamp", factor: 2, startFrame: 100, endFrame: 50 }],
        },
      ],
    });
    mockedSafeParse.mockReturnValue({ success: true, data: manifest } as unknown as ReturnType<typeof DirectorManifestSchema.safeParse>);

    const result = validateManifest(manifest);

    expect(result.errors.some((e) => e.includes("speedRamp endFrame"))).toBe(true);
  });

  it("checks image_scene sources when checkFiles is true", () => {
    const manifest = makeValidManifest({
      timeline: [
        {
          type: "image_scene" as const,
          src: "/img/scene.png",
          startAtFrame: 0,
          duration: 90,
          voiceover: "/vo/scene.wav",
        },
      ],
    });
    mockedSafeParse.mockReturnValue({ success: true, data: manifest } as unknown as ReturnType<typeof DirectorManifestSchema.safeParse>);
    mockedExistsSync.mockReturnValue(false);

    const result = validateManifest(manifest, { checkFiles: true });

    expect(result.errors.some((e) => e.includes("image source not found"))).toBe(true);
    expect(result.errors.some((e) => e.includes("scene voiceover not found"))).toBe(true);
  });
});
