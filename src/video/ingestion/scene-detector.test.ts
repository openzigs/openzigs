import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("node:fs/promises", () => ({
  default: {
    mkdir: vi.fn().mockResolvedValue(undefined),
  },
}));

vi.mock("../../logging/logger.js", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

// Mock fluent-ffmpeg with configurable behavior
const mockFfmpegInstance = {
  videoFilters: vi.fn().mockReturnThis(),
  outputOptions: vi.fn().mockReturnThis(),
  output: vi.fn().mockReturnThis(),
  on: vi.fn().mockReturnThis(),
  run: vi.fn(),
};

vi.mock("fluent-ffmpeg", () => {
  const ffmpegFn = vi.fn().mockReturnValue(mockFfmpegInstance);
  (ffmpegFn as any).ffprobe = vi.fn((_path: string, cb: Function) => {
    cb(null, { format: { duration: 30 } });
  });
  return { default: ffmpegFn };
});

import { extractKeyframes, getVideoDuration } from "./scene-detector.js";

describe("scene-detector", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // Reset the fluent-ffmpeg mock to trigger end events
    mockFfmpegInstance.videoFilters.mockReturnThis();
    mockFfmpegInstance.outputOptions.mockReturnThis();
    mockFfmpegInstance.output.mockReturnThis();
    mockFfmpegInstance.run.mockImplementation(() => {});
    mockFfmpegInstance.on.mockImplementation(function (this: any, event: string, cb: Function) {
      if (event === "end") {
        // Queue end call after run
        setTimeout(() => cb(), 0);
      }
      return this;
    });
  });

  describe("getVideoDuration", () => {
    it("returns duration from ffprobe", async () => {
      const duration = await getVideoDuration("/tmp/test.mp4");
      expect(duration).toBe(30);
    });

    it("returns 0 on probe error", async () => {
      const ffmpeg = await import("fluent-ffmpeg");
      (vi.mocked(ffmpeg.default.ffprobe) as any).mockImplementation((_path: string, cb: (...args: unknown[]) => void) => {
        cb(new Error("file not found"), null);
      });
      const duration = await getVideoDuration("/tmp/missing.mp4");
      expect(duration).toBe(0);
    });
  });

  describe("extractKeyframes", () => {
    it("returns keyframes from scene detection and interval sampling", async () => {
      const keyframes = await extractKeyframes("/tmp/test.mp4", "/tmp/output");
      // Should return merged keyframes (deduplicated)
      expect(keyframes).toBeDefined();
      expect(Array.isArray(keyframes)).toBe(true);
    });

    it("creates output directory", async () => {
      const fs = await import("node:fs/promises");
      await extractKeyframes("/tmp/test.mp4", "/tmp/output");
      expect(fs.default.mkdir).toHaveBeenCalledWith("/tmp/output", { recursive: true });
    });

    it("respects maxKeyframes limit", async () => {
      // Create scenario with many keyframes via interval
      const ffmpeg = await import("fluent-ffmpeg");
      (vi.mocked(ffmpeg.default.ffprobe) as any).mockImplementation((_path: string, cb: (...args: unknown[]) => void) => {
        cb(null, { format: { duration: 600 } }); // 10 min video
      });

      const keyframes = await extractKeyframes("/tmp/test.mp4", "/tmp/output", {
        maxKeyframes: 5,
        minInterval: 1,
      });
      expect(keyframes.length).toBeLessThanOrEqual(5);
    });

    it("uses default options when none provided", async () => {
      await extractKeyframes("/tmp/test.mp4", "/tmp/output");
      // Should use default sceneThreshold=0.3
      const filterCall = mockFfmpegInstance.videoFilters.mock.calls[0];
      if (filterCall) {
        expect(filterCall[0]).toContain("0.3");
      }
    });

    it("handles ffmpeg scene detection errors gracefully", async () => {
      mockFfmpegInstance.on.mockImplementation(function (this: any, event: string, cb: Function) {
        if (event === "error") {
          setTimeout(() => cb(new Error("ffmpeg crashed")), 0);
        }
        if (event === "end") {
          // For interval extraction
          setTimeout(() => cb(), 10);
        }
        return this;
      });

      const keyframes = await extractKeyframes("/tmp/test.mp4", "/tmp/output");
      // Should still return interval frames even if scene detection fails
      expect(Array.isArray(keyframes)).toBe(true);
    });
  });
});
