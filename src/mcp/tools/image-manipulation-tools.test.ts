import { describe, it, expect, vi, beforeEach } from "vitest";
import { createImageManipulationTools } from "./image-manipulation-tools.js";
import type { ToolDefinition } from "../tool-registry.js";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const HOME = os.homedir();
const TEST_IMAGE = path.join(HOME, ".openzigs", "gallery", "test.png");
const MISSING_IMAGE = path.join(HOME, ".openzigs", "gallery", "missing.png");
const WATERMARK_IMAGE = path.join(
  HOME,
  ".openzigs",
  "gallery",
  "watermark.png",
);
const MISSING_WATERMARK = path.join(
  HOME,
  ".openzigs",
  "gallery",
  "missing-wm.png",
);

// Mock sharp and fs
vi.mock("sharp", () => {
  const mockSharp = vi.fn();
  const pipeline = {
    resize: vi.fn().mockReturnThis(),
    extract: vi.fn().mockReturnThis(),
    toFormat: vi.fn().mockReturnThis(),
    grayscale: vi.fn().mockReturnThis(),
    blur: vi.fn().mockReturnThis(),
    sharpen: vi.fn().mockReturnThis(),
    negate: vi.fn().mockReturnThis(),
    normalize: vi.fn().mockReturnThis(),
    tint: vi.fn().mockReturnThis(),
    composite: vi.fn().mockReturnThis(),
    ensureAlpha: vi.fn().mockReturnThis(),
    toFile: vi.fn().mockResolvedValue({}),
    toBuffer: vi.fn().mockResolvedValue(Buffer.from("fake")),
    metadata: vi.fn().mockResolvedValue({
      width: 800,
      height: 600,
      format: "png",
      size: 1024,
    }),
  };
  mockSharp.mockReturnValue(pipeline);
  return { default: mockSharp };
});

vi.mock("node:fs", async () => {
  const actual = await vi.importActual<typeof fs>("node:fs");
  return {
    ...actual,
    default: {
      ...actual,
      existsSync: vi.fn().mockReturnValue(true),
      mkdirSync: vi.fn(),
      statSync: vi.fn().mockReturnValue({ size: 2048 }),
      readFileSync: vi.fn().mockReturnValue(Buffer.from("fake-image")),
      writeFileSync: vi.fn(),
    },
    existsSync: vi.fn().mockReturnValue(true),
    mkdirSync: vi.fn(),
    statSync: vi.fn().mockReturnValue({ size: 2048 }),
  };
});

describe("Image Manipulation Tools", () => {
  let tools: ToolDefinition[];

  beforeEach(() => {
    tools = createImageManipulationTools();
    vi.clearAllMocks();
  });

  it("should create 5 tools", () => {
    expect(tools).toHaveLength(5);
    const names = tools.map((t) => t.name);
    expect(names).toContain("resize-image");
    expect(names).toContain("crop-image");
    expect(names).toContain("convert-image");
    expect(names).toContain("filter-image");
    expect(names).toContain("watermark-image");
  });

  describe("resize-image", () => {
    it("should resize an image", async () => {
      const tool = tools.find((t) => t.name === "resize-image")!;
      const result = await tool.handler({
        file_path: TEST_IMAGE,
        width: 200,
        height: 150,
      });
      const parsed = JSON.parse(result.text);
      expect(parsed.success).toBe(true);
      expect(parsed.outputPath).toContain("gallery");
    });

    it("should error if neither width nor height is provided", async () => {
      const tool = tools.find((t) => t.name === "resize-image")!;
      const result = await tool.handler({ file_path: TEST_IMAGE });
      expect(result.isError).toBe(true);
      expect(result.text).toContain("At least one of width or height");
    });

    it("should error if file not found", async () => {
      const fsMod = await import("node:fs");
      vi.mocked(fsMod.default.existsSync).mockReturnValueOnce(false);
      const tool = tools.find((t) => t.name === "resize-image")!;
      const result = await tool.handler({
        file_path: MISSING_IMAGE,
        width: 100,
      });
      expect(result.isError).toBe(true);
      expect(result.text).toContain("File not found");
    });

    it("should reject paths outside allowed directories", async () => {
      const tool = tools.find((t) => t.name === "resize-image")!;
      const result = await tool.handler({
        file_path: "/etc/passwd",
        width: 100,
      });
      expect(result.isError).toBe(true);
      expect(result.text).toContain("Path not allowed");
    });
  });

  describe("crop-image", () => {
    it("should crop an image", async () => {
      const tool = tools.find((t) => t.name === "crop-image")!;
      const result = await tool.handler({
        file_path: TEST_IMAGE,
        left: 10,
        top: 20,
        width: 100,
        height: 80,
      });
      const parsed = JSON.parse(result.text);
      expect(parsed.success).toBe(true);
      expect(parsed.width).toBe(100);
      expect(parsed.height).toBe(80);
    });
  });

  describe("convert-image", () => {
    it("should convert image format", async () => {
      const tool = tools.find((t) => t.name === "convert-image")!;
      const result = await tool.handler({
        file_path: TEST_IMAGE,
        format: "webp",
        quality: 90,
      });
      const parsed = JSON.parse(result.text);
      expect(parsed.success).toBe(true);
      expect(parsed.format).toBe("webp");
    });
  });

  describe("filter-image", () => {
    it("should apply grayscale filter", async () => {
      const tool = tools.find((t) => t.name === "filter-image")!;
      const result = await tool.handler({
        file_path: TEST_IMAGE,
        filter: "grayscale",
      });
      const parsed = JSON.parse(result.text);
      expect(parsed.success).toBe(true);
      expect(parsed.filter).toBe("grayscale");
    });

    it("should apply blur filter", async () => {
      const tool = tools.find((t) => t.name === "filter-image")!;
      const result = await tool.handler({
        file_path: TEST_IMAGE,
        filter: "blur",
        intensity: 5,
      });
      const parsed = JSON.parse(result.text);
      expect(parsed.success).toBe(true);
      expect(parsed.filter).toBe("blur");
    });

    it("should apply sepia filter", async () => {
      const tool = tools.find((t) => t.name === "filter-image")!;
      const result = await tool.handler({
        file_path: TEST_IMAGE,
        filter: "sepia",
      });
      const parsed = JSON.parse(result.text);
      expect(parsed.success).toBe(true);
      expect(parsed.filter).toBe("sepia");
    });
  });

  describe("watermark-image", () => {
    it("should add watermark to image", async () => {
      const tool = tools.find((t) => t.name === "watermark-image")!;
      const result = await tool.handler({
        file_path: TEST_IMAGE,
        watermark_path: WATERMARK_IMAGE,
        position: "bottom-right",
        opacity: 0.5,
      });
      const parsed = JSON.parse(result.text);
      expect(parsed.success).toBe(true);
      expect(parsed.position).toBe("bottom-right");
    });

    it("should error if watermark file not found", async () => {
      const fsMod = await import("node:fs");
      vi.mocked(fsMod.default.existsSync)
        .mockReturnValueOnce(true) // source exists
        .mockReturnValueOnce(false); // watermark missing
      const tool = tools.find((t) => t.name === "watermark-image")!;
      const result = await tool.handler({
        file_path: TEST_IMAGE,
        watermark_path: MISSING_WATERMARK,
      });
      expect(result.isError).toBe(true);
      expect(result.text).toContain("Watermark file not found");
    });
  });
});
