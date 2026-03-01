import { describe, it, expect, vi, beforeEach } from "vitest";

const { mockFfprobe } = vi.hoisted(() => ({
  mockFfprobe: vi.fn((_path: string, cb: Function) => {
    cb(null, {
      format: { duration: 10.5 },
      streams: [{ codec_type: "video", width: 1920, height: 1080, r_frame_rate: "30/1" }],
    });
  }),
}));

vi.mock("node:fs/promises", () => ({
  default: {
    mkdir: vi.fn().mockResolvedValue(undefined),
    rm: vi.fn().mockResolvedValue(undefined),
  },
}));

vi.mock("../../logging/logger.js", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

vi.mock("./audio-extractor.js", () => ({
  extractAudio: vi.fn().mockResolvedValue("/tmp/audio.wav"),
}));

vi.mock("./scene-detector.js", () => ({
  extractKeyframes: vi.fn().mockResolvedValue([
    { timestamp: 1.0, framePath: "/tmp/f1.jpg", sceneScore: 0.5 },
    { timestamp: 5.0, framePath: "/tmp/f2.jpg", sceneScore: 0.8 },
  ]),
}));

vi.mock("./transcriber.js", () => ({
  transcribe: vi.fn().mockResolvedValue([
    { start: "00:00:01.000", end: "00:00:03.000", speech: "Hello world", clipIndex: 0 },
  ]),
}));

vi.mock("./context-assembler.js", () => ({
  assembleContext: vi.fn().mockReturnValue({
    clips: [],
    totalDuration: 10,
    resolution: { width: 1920, height: 1080 },
  }),
}));

vi.mock("./keyframe-analyzer.js", () => ({
  analyzeKeyframes: vi.fn().mockResolvedValue({ analyzed: 2, skipped: 0, failed: 0 }),
}));

vi.mock("fluent-ffmpeg", () => ({
  default: { ffprobe: mockFfprobe },
}));

vi.mock("nanoid", () => ({
  nanoid: vi.fn().mockReturnValue("testid12"),
}));

import { ingest, cleanupWorkingDir } from "./index.js";
import { extractAudio } from "./audio-extractor.js";
import { extractKeyframes } from "./scene-detector.js";
import { transcribe } from "./transcriber.js";
import { assembleContext } from "./context-assembler.js";
import { analyzeKeyframes } from "./keyframe-analyzer.js";
import fs from "node:fs/promises";

/** Helper to re-initialize all mocks (used by beforeEach and individual tests that need a clean slate). */
async function resetMocks() {
  vi.clearAllMocks();
  vi.mocked(extractAudio).mockResolvedValue("/tmp/audio.wav");
  vi.mocked(extractKeyframes).mockResolvedValue([
    { timestamp: 1.0, framePath: "/tmp/f1.jpg", sceneScore: 0.5 },
    { timestamp: 5.0, framePath: "/tmp/f2.jpg", sceneScore: 0.8 },
  ]);
  vi.mocked(transcribe).mockResolvedValue([
    { start: "00:00:01.000", end: "00:00:03.000", speech: "Hello world", clipIndex: 0 },
  ]);
  vi.mocked(assembleContext).mockReturnValue({
    clips: [],
    totalDuration: 10,
    resolution: { width: 1920, height: 1080 },
  });
  vi.mocked(analyzeKeyframes).mockResolvedValue({ analyzed: 2, skipped: 0, failed: 0 });
  vi.mocked(fs.mkdir).mockResolvedValue(undefined as any);
  vi.mocked(fs.rm).mockResolvedValue(undefined);
  mockFfprobe.mockImplementation((_path: string, cb: Function) => {
    cb(null, {
      format: { duration: 10.5 },
      streams: [{ codec_type: "video", width: 1920, height: 1080, r_frame_rate: "30/1" }],
    });
  });
  // Re-attach ffprobe to the cached fluent-ffmpeg module in case of cross-test contamination
  const fluentMod = await import("fluent-ffmpeg") as any;
  if (fluentMod?.default) {
    fluentMod.default.ffprobe = mockFfprobe;
  }
}

describe("ingestion/index", () => {
  beforeEach(async () => {
    await resetMocks();
  });

  describe("ingest", () => {
    it("processes a single clip through the pipeline", async () => {
      const result = await ingest({ clips: ["/tmp/video.mp4"], mode: "standard" });

      expect(result.clips.length).toBe(1);
      expect(result.totalDuration).toBeCloseTo(10.5);
      expect(result.workingDir).toContain("openzigs-ingest");
      expect(extractAudio).toHaveBeenCalled();
      expect(extractKeyframes).toHaveBeenCalled();
      expect(transcribe).toHaveBeenCalled();
      expect(assembleContext).toHaveBeenCalled();
    });

    it("processes multiple clips", async () => {
      const result = await ingest({ clips: ["/tmp/v1.mp4", "/tmp/v2.mp4"], mode: "standard" });
      expect(result.clips.length).toBeGreaterThanOrEqual(1);
      expect(result.totalDuration).toBeGreaterThan(0);
      expect(assembleContext).toHaveBeenCalled();
    });

    it("skips vision analysis when no copilot", async () => {
      await ingest({ clips: ["/tmp/v.mp4"] });
      expect(analyzeKeyframes).not.toHaveBeenCalled();
    });

    it("calls onProgress with phase events", async () => {
      const onProgress = vi.fn();
      await ingest({ clips: ["/tmp/v.mp4"] }, { onProgress });
      expect(onProgress).toHaveBeenCalled();
      const phases = onProgress.mock.calls.map((c: any[]) => c[0].phase);
      expect(phases).toContain("extracting");
      expect(phases).toContain("assembling");
    });

    it("uses dense mode settings", async () => {
      await ingest({ clips: ["/tmp/v.mp4"] }, { mode: "dense" });
      expect(extractKeyframes).toHaveBeenCalledWith(
        expect.any(String),
        expect.any(String),
        expect.objectContaining({ minInterval: 1 }),
      );
    });

    it("passes custom sceneThreshold", async () => {
      await ingest({ clips: ["/tmp/v.mp4"] }, { sceneThreshold: 0.5 });
      expect(extractKeyframes).toHaveBeenCalledWith(
        expect.any(String),
        expect.any(String),
        expect.objectContaining({ sceneThreshold: 0.5 }),
      );
    });

    it("returns workingDir in result", async () => {
      const result = await ingest({ clips: ["/tmp/v.mp4"] });
      expect(result.workingDir).toBeDefined();
      expect(result.contextPayload).toBeDefined();
    });

    // Tests that override mock behavior go last to minimize cross-test impact
    it("throws when all clips fail", async () => {
      vi.mocked(extractAudio).mockRejectedValue(new Error("ffmpeg error"));
      vi.mocked(extractKeyframes).mockRejectedValue(new Error("ffmpeg error"));

      await expect(ingest({ clips: ["/tmp/bad.mp4"] })).rejects.toThrow("All clips failed");
    });

    it("continues when some clips fail", async () => {
      vi.mocked(extractAudio)
        .mockResolvedValueOnce("/tmp/audio1.wav")
        .mockRejectedValueOnce(new Error("bad clip"));

      const result = await ingest({ clips: ["/tmp/v1.mp4", "/tmp/bad.mp4"] });
      expect(result.clips.length).toBe(1);
    });
  });

  describe("cleanupWorkingDir", () => {
    it("removes working directory recursively", async () => {
      await cleanupWorkingDir("/tmp/openzigs-ingest-test");
      expect(fs.rm).toHaveBeenCalledWith("/tmp/openzigs-ingest-test", { recursive: true, force: true });
    });

    it("handles cleanup errors gracefully", async () => {
      vi.mocked(fs.rm).mockRejectedValue(new Error("EPERM"));
      await expect(cleanupWorkingDir("/tmp/test")).resolves.toBeUndefined();
    });
  });
});
