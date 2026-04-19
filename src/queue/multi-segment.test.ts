/**
 * Multi-Segment Video Orchestration — Tests
 * Issue #790: Verify decomposition, segment tracking, stitching, and validation.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  decomposeMultiSegmentJob,
  handleSegmentCompletion,
  stitchSegments,
  buildXfadeCommand,
  isMultiSegmentDuration,
  isValidVideoDuration,
  isSegmentJob,
  registerSegmentJob,
  getSegmentTracker,
  formatSegmentProgress,
  _clearTrackers,
  _trackerCount,
} from "./multi-segment.js";
import type { MediaJob } from "./types.js";

vi.mock("../logging/logger.js", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

vi.mock("node:fs/promises", () => ({
  default: {
    mkdir: vi.fn().mockResolvedValue(undefined),
    writeFile: vi.fn().mockResolvedValue(undefined),
    readFile: vi.fn().mockResolvedValue(Buffer.from("fake-video-data")),
    copyFile: vi.fn().mockResolvedValue(undefined),
    rm: vi.fn().mockResolvedValue(undefined),
    unlink: vi.fn().mockResolvedValue(undefined),
  },
}));

vi.mock("node:child_process", () => ({
  execFile: vi.fn(
    (_cmd: string, _args: string[], cb: (err: Error | null) => void) => {
      cb(null);
    },
  ),
}));

function makeJob(overrides: Partial<MediaJob> = {}): MediaJob {
  return {
    id: "parent-1",
    type: "txt2video",
    requiredModel: "ltx-2",
    targetNode: "m2-pro",
    payload: {
      prompt: "a cat running in a field",
      width: 768,
      height: 512,
      pipeline: "distilled",
      video_duration: 16,
    },
    status: "pending",
    resultUrl: null,
    resultMetadata: null,
    projectId: null,
    galleryAssetId: null,
    priority: 0,
    retries: 0,
    maxRetries: 3,
    error: null,
    retryAfter: null,
    createdAt: new Date(),
    dispatchedAt: null,
    completedAt: null,
    notifyViaTelegram: false,
    telegramChatId: null,
    ...overrides,
  };
}

describe("multi-segment", () => {
  beforeEach(() => {
    _clearTrackers();
  });

  afterEach(() => {
    _clearTrackers();
  });

  // ── isMultiSegmentDuration ──

  describe("isMultiSegmentDuration", () => {
    it("returns false for undefined", () => {
      expect(isMultiSegmentDuration(undefined)).toBe(false);
    });

    it("returns false for duration <= 4", () => {
      expect(isMultiSegmentDuration(4)).toBe(false);
      expect(isMultiSegmentDuration(3)).toBe(false);
    });

    it("returns true for duration > 4", () => {
      expect(isMultiSegmentDuration(8)).toBe(true);
      expect(isMultiSegmentDuration(16)).toBe(true);
    });
  });

  // ── isValidVideoDuration ──

  describe("isValidVideoDuration", () => {
    it("accepts valid durations", () => {
      expect(isValidVideoDuration(4)).toBe(true);
      expect(isValidVideoDuration(8)).toBe(true);
      expect(isValidVideoDuration(12)).toBe(true);
      expect(isValidVideoDuration(16)).toBe(true);
    });

    it("rejects invalid durations", () => {
      expect(isValidVideoDuration(5)).toBe(false);
      expect(isValidVideoDuration(0)).toBe(false);
      expect(isValidVideoDuration(20)).toBe(false);
      expect(isValidVideoDuration(7)).toBe(false);
    });
  });

  // ── decomposeMultiSegmentJob ──

  describe("decomposeMultiSegmentJob", () => {
    it("decomposes 16s into 4 segments", () => {
      const job = makeJob({ payload: { prompt: "test", video_duration: 16 } });
      const result = decomposeMultiSegmentJob(job);

      expect(result).not.toBeNull();
      expect(result!.totalSegments).toBe(4);
      expect(result!.payload.segmentIndex).toBe(0);
      expect(result!.payload.totalSegments).toBe(4);
      expect(result!.payload.parentJobId).toBe("parent-1");
      expect(result!.payload.num_frames).toBe(97);
      expect(result!.payload.audio).toBe(false);
      expect(result!.payload.video_duration).toBeUndefined();
    });

    it("decomposes 8s into 2 segments", () => {
      const job = makeJob({ payload: { prompt: "test", video_duration: 8 } });
      const result = decomposeMultiSegmentJob(job);

      expect(result).not.toBeNull();
      expect(result!.totalSegments).toBe(2);
    });

    it("decomposes 12s into 3 segments", () => {
      const job = makeJob({ payload: { prompt: "test", video_duration: 12 } });
      const result = decomposeMultiSegmentJob(job);

      expect(result).not.toBeNull();
      expect(result!.totalSegments).toBe(3);
    });

    it("returns null for duration <= 4 (no decomposition)", () => {
      const job = makeJob({ payload: { prompt: "test", video_duration: 4 } });
      const result = decomposeMultiSegmentJob(job);
      expect(result).toBeNull();
    });

    it("returns null for missing duration", () => {
      const job = makeJob({ payload: { prompt: "test" } });
      const result = decomposeMultiSegmentJob(job);
      expect(result).toBeNull();
    });

    it("preserves parent job type for first segment", () => {
      const job = makeJob({
        type: "img2video",
        payload: { prompt: "test", video_duration: 8, init_image: "base64..." },
      });
      const result = decomposeMultiSegmentJob(job);
      expect(result!.type).toBe("img2video");
    });

    it("creates a tracker", async () => {
      const job = makeJob({ payload: { prompt: "test", video_duration: 16 } });
      decomposeMultiSegmentJob(job);
      expect(_trackerCount()).toBe(1);
      expect(await getSegmentTracker("parent-1")).toBeDefined();
    });
  });

  // ── registerSegmentJob ──

  describe("registerSegmentJob", () => {
    it("registers a segment job ID in the tracker", async () => {
      const job = makeJob({ payload: { prompt: "test", video_duration: 8 } });
      decomposeMultiSegmentJob(job);

      registerSegmentJob("parent-1", 0, "seg-job-0");
      const tracker = (await getSegmentTracker("parent-1"))!;
      expect(tracker.segments[0].jobId).toBe("seg-job-0");
    });

    it("does nothing for unknown parent", () => {
      registerSegmentJob("unknown", 0, "seg-job-0");
      // No error, just silently ignores
    });
  });

  // ── isSegmentJob ──

  describe("isSegmentJob", () => {
    it("returns true for segment sub-jobs", () => {
      const job = makeJob({
        payload: { prompt: "test", segmentIndex: 0, parentJobId: "parent-1" },
      });
      expect(isSegmentJob(job)).toBe(true);
    });

    it("returns false for regular jobs", () => {
      const job = makeJob({ payload: { prompt: "test" } });
      expect(isSegmentJob(job)).toBe(false);
    });

    it("returns false when only segmentIndex is set", () => {
      const job = makeJob({ payload: { prompt: "test", segmentIndex: 0 } });
      expect(isSegmentJob(job)).toBe(false);
    });
  });

  // ── formatSegmentProgress ──

  describe("formatSegmentProgress", () => {
    it("formats without progress", () => {
      expect(formatSegmentProgress(0, 4)).toBe("Segment 1/4");
    });

    it("formats with progress percentage", () => {
      expect(formatSegmentProgress(1, 4, 60)).toBe("Segment 2/4 — 60%");
    });

    it("rounds progress", () => {
      expect(formatSegmentProgress(2, 4, 33.7)).toBe("Segment 3/4 — 34%");
    });
  });

  // ── handleSegmentCompletion ──

  describe("handleSegmentCompletion", () => {
    it("tracks segment completion and requests next segment", async () => {
      const parent = makeJob({
        payload: { prompt: "test", video_duration: 8 },
      });
      decomposeMultiSegmentJob(parent);
      registerSegmentJob("parent-1", 0, "seg-0");

      const segmentJob = makeJob({
        id: "seg-0",
        payload: {
          prompt: "test",
          segmentIndex: 0,
          totalSegments: 2,
          parentJobId: "parent-1",
        },
      });

      const mockNodeConfig = vi.fn().mockResolvedValue({
        url: "http://worker:5002",
        token: "test",
      });

      // Mock fetch for /last-frame endpoint
      const mockFetch = vi.fn().mockResolvedValue({
        ok: true,
        json: () => Promise.resolve({ frame_base64: "lastframe_base64" }),
      });
      vi.stubGlobal("fetch", mockFetch);

      const result = await handleSegmentCompletion(
        segmentJob,
        Buffer.from("video-data"),
        mockNodeConfig,
      );

      expect(result.done).toBe(false);
      if (!result.done) {
        expect(result.nextSegment.type).toBe("img2video");
        expect(result.nextSegment.payload.segmentIndex).toBe(1);
        expect(result.nextSegment.payload.init_image).toBe("lastframe_base64");
        expect(result.nextSegment.payload.image_strength).toBe(0.8);
        expect(result.nextSegment.payload.audio).toBe(false);
      }

      vi.unstubAllGlobals();
    });

    it("signals done when last segment completes", async () => {
      const parent = makeJob({
        payload: { prompt: "test", video_duration: 8 },
      });
      decomposeMultiSegmentJob(parent);
      registerSegmentJob("parent-1", 0, "seg-0");
      registerSegmentJob("parent-1", 1, "seg-1");

      // Complete first segment
      const seg0 = makeJob({
        id: "seg-0",
        payload: {
          prompt: "test",
          segmentIndex: 0,
          totalSegments: 2,
          parentJobId: "parent-1",
        },
      });
      const mockFetch = vi.fn().mockResolvedValue({
        ok: true,
        json: () => Promise.resolve({ frame_base64: "lastframe" }),
      });
      vi.stubGlobal("fetch", mockFetch);

      await handleSegmentCompletion(
        seg0,
        Buffer.from("video-data-0"),
        vi.fn().mockResolvedValue({ url: "http://w:5002" }),
      );

      // Complete second (last) segment
      const seg1 = makeJob({
        id: "seg-1",
        payload: {
          prompt: "test",
          segmentIndex: 1,
          totalSegments: 2,
          parentJobId: "parent-1",
        },
      });

      const result = await handleSegmentCompletion(
        seg1,
        Buffer.from("video-data-1"),
        vi.fn().mockResolvedValue({ url: "http://w:5002" }),
      );

      expect(result.done).toBe(true);
      expect(result.parentJobId).toBe("parent-1");

      vi.unstubAllGlobals();
    });

    it("throws for unknown parent job", async () => {
      const segmentJob = makeJob({
        id: "seg-orphan",
        payload: {
          prompt: "test",
          segmentIndex: 0,
          totalSegments: 2,
          parentJobId: "unknown-parent",
        },
      });

      await expect(
        handleSegmentCompletion(
          segmentJob,
          Buffer.from("video"),
          vi.fn().mockResolvedValue({ url: "http://w:5002" }),
        ),
      ).rejects.toThrow("No segment tracker found");
    });
  });

  // ── stitchSegments ──

  describe("stitchSegments", () => {
    it("copies single segment without ffmpeg", async () => {
      _clearTrackers();

      // Use decomposeMultiSegmentJob with duration 8 to get a real tracker,
      // then manipulate it for the single-segment test
      const job8s = makeJob({
        id: "stitch-1",
        payload: { prompt: "test", video_duration: 8 },
      });
      decomposeMultiSegmentJob(job8s);
      const tracker = (await getSegmentTracker("stitch-1"))!;
      // Override to 1 segment
      tracker.totalSegments = 1;
      tracker.segments = [
        {
          index: 0,
          jobId: "s0",
          status: "complete",
          videoPath: "/tmp/seg-0.mp4",
        },
      ];

      const result = await stitchSegments("stitch-1");
      expect(result).toBeInstanceOf(Buffer);
    });

    it("throws for unknown parent", async () => {
      await expect(stitchSegments("nonexistent")).rejects.toThrow(
        "No segment tracker found",
      );
    });
  });

  // ── buildXfadeCommand ──

  describe("buildXfadeCommand", () => {
    it("builds correct command for 2 inputs", () => {
      const args = buildXfadeCommand(
        ["/tmp/a.mp4", "/tmp/b.mp4"],
        "/tmp/out.mp4",
        0.5,
      );

      expect(args).toContain("-i");
      expect(args).toContain("/tmp/a.mp4");
      expect(args).toContain("/tmp/b.mp4");
      expect(args).toContain("-filter_complex");
      expect(args.join(" ")).toContain(
        "xfade=transition=fade:duration=0.5:offset=3.5",
      );
      expect(args).toContain("-y");
      expect(args).toContain("/tmp/out.mp4");
    });

    it("builds correct chain for 4 inputs", () => {
      const args = buildXfadeCommand(
        ["/tmp/a.mp4", "/tmp/b.mp4", "/tmp/c.mp4", "/tmp/d.mp4"],
        "/tmp/out.mp4",
        0.5,
      );

      expect(args).toContain("-filter_complex");
      const filterIdx = args.indexOf("-filter_complex");
      const filterExpr = args[filterIdx + 1];
      // Should have 3 xfade operations chained
      const xfadeCount = (filterExpr.match(/xfade/g) || []).length;
      expect(xfadeCount).toBe(3);
      // Final output label should be [outv]
      expect(filterExpr).toContain("[outv]");
    });

    it("uses libx264 encoding", () => {
      const args = buildXfadeCommand(
        ["/tmp/a.mp4", "/tmp/b.mp4"],
        "/tmp/out.mp4",
        0.5,
      );
      expect(args).toContain("-c:v");
      expect(args).toContain("libx264");
    });
  });
});
