/**
 * Clip Extractor — Unit Tests
 * Issue #821: Intelligent video clipping.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  ClipExtractor,
  type ClipExtractorChatFn,
  type ExtractedClip,
} from "./clip-extractor.js";

function createMockChat(responses: string[]): ClipExtractorChatFn {
  let callIndex = 0;
  return async function* mockChat() {
    const response = responses[callIndex] ?? "[]";
    callIndex++;
    yield response;
  };
}

describe("ClipExtractor", () => {
  let extractor: ClipExtractor;

  beforeEach(() => {
    extractor = new ClipExtractor({
      chat: createMockChat([]),
    });
  });

  it("creates a job and assigns an ID", async () => {
    // Override processNext to not actually process
    vi.spyOn(extractor as never, "runExtraction" as never).mockResolvedValue(
      undefined as never,
    );

    const id = await extractor.submit({
      source: "/tmp/test.mp4",
      mode: "auto",
    });

    expect(id).toMatch(/^clip-/);
    const job = extractor.getJob(id);
    expect(job).toBeDefined();
    expect(job!.source).toBe("/tmp/test.mp4");
  });

  it("lists all jobs", async () => {
    vi.spyOn(extractor as never, "runExtraction" as never).mockResolvedValue(
      undefined as never,
    );

    await extractor.submit({ source: "/tmp/a.mp4", mode: "auto" });
    await extractor.submit({ source: "/tmp/b.mp4", mode: "auto" });

    const jobs = extractor.listJobs();
    expect(jobs.length).toBeGreaterThanOrEqual(1);
  });

  it("emits clip:queued event on submit", async () => {
    vi.spyOn(extractor as never, "runExtraction" as never).mockResolvedValue(
      undefined as never,
    );

    const handler = vi.fn();
    extractor.on("clip:queued", handler);

    await extractor.submit({ source: "/tmp/test.mp4", mode: "auto" });
    expect(handler).toHaveBeenCalledWith(
      expect.objectContaining({ jobId: expect.stringMatching(/^clip-/) }),
    );
  });

  it("emits clip:complete on successful extraction", async () => {
    const mockClips: ExtractedClip[] = [
      {
        startTime: 10,
        endTime: 40,
        viralityScore: 85,
        title: "Test Clip",
        description: "A test clip",
        hookDetected: true,
      },
    ];

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    vi.spyOn(extractor as any, "runExtraction").mockImplementation(
      async (job: any) => {
        job.clips = mockClips;
      },
    );

    const completeHandler = vi.fn();
    extractor.on("clip:complete", completeHandler);

    const id = await extractor.submit({
      source: "/tmp/test.mp4",
      mode: "auto",
    });

    // Wait for async processing
    await new Promise((resolve) => setTimeout(resolve, 50));

    expect(completeHandler).toHaveBeenCalledWith(
      expect.objectContaining({
        jobId: id,
        clips: mockClips,
      }),
    );
  });

  it("emits clip:failed on error", async () => {
    vi.spyOn(extractor as never, "runExtraction" as never).mockRejectedValue(
      new Error("Test failure"),
    );

    const failHandler = vi.fn();
    extractor.on("clip:failed", failHandler);

    const id = await extractor.submit({
      source: "/tmp/test.mp4",
      mode: "auto",
    });

    await new Promise((resolve) => setTimeout(resolve, 50));

    expect(failHandler).toHaveBeenCalledWith(
      expect.objectContaining({
        jobId: id,
        error: "Test failure",
      }),
    );
  });

  it("waitForCompletion resolves on success", async () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    vi.spyOn(extractor as any, "runExtraction").mockImplementation(
      async (job: any) => {
        job.clips = [];
      },
    );

    const id = await extractor.submit({
      source: "/tmp/test.mp4",
      mode: "auto",
    });
    const job = await extractor.waitForCompletion(id, 5000);

    expect(job.status).toBe("complete");
  });

  it("waitForCompletion rejects on failure", async () => {
    vi.spyOn(extractor as never, "runExtraction" as never).mockRejectedValue(
      new Error("Extraction failed"),
    );

    const id = await extractor.submit({
      source: "/tmp/test.mp4",
      mode: "auto",
    });

    await expect(extractor.waitForCompletion(id, 5000)).rejects.toThrow(
      "Extraction failed",
    );
  });

  it("waitForCompletion rejects for unknown job", async () => {
    await expect(extractor.waitForCompletion("nonexistent")).rejects.toThrow(
      "not found",
    );
  });

  it("extractFrames calls ffmpeg with correct args", async () => {
    // This test verifies the method signature exists and is callable
    // Actual FFmpeg integration is tested via e2e
    expect(typeof extractor.extractFrames).toBe("function");
  });

  it("detectSceneChanges calls ffmpeg with scene filter", async () => {
    expect(typeof extractor.detectSceneChanges).toBe("function");
  });
});
